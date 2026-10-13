// lib/server/testing/pgHarness.ts
// A real Postgres (PGlite = Postgres compiled to WebAssembly, in memory) dressed up
// as a Supabase project, so tests can run the REAL migration files from
// supabase/migrations/ and watch what the database actually does with them.
//
// Why this exists: migration 003 (server-side limits) can only be pasted into the
// live Supabase SQL editor by the owner. A typo there would fail on the live
// project, so we prove it here first instead of finding out in production.
//
// What is a faithful copy of Supabase, and what is not:
//   - Roles: anon, authenticated, service_role (service_role bypasses row-level
//     security), same as Supabase.
//   - auth.uid() reads the request's JWT settings exactly like Supabase's own
//     function (request.jwt.claim.sub, falling back to request.jwt.claims).
//   - storage.buckets / storage.objects have the columns the Storage API uses, row-level
//     security is on for storage.objects, and storage.foldername() is Supabase's own
//     definition.
//   - Each "request" below runs in ONE transaction with `set local role` and the JWT
//     settings, which is how PostgREST and the Storage API talk to the database.
//   - NOT modelled: the privileges of the SQL editor's `postgres` role (here the
//     migrations run as a Postgres superuser), the Storage API's own checks (it
//     enforces file_size_limit and allowed_mime_types in its code, not in SQL), and
//     two requests running at the same moment (PGlite has a single connection).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";

/** The migration files, in the order the owner applies them. */
export const MIGRATION_FILES = [
  "001_init.sql",
  "002_ai_and_rate_limits.sql",
  "003_limits.sql",
] as const;
export type MigrationFile = (typeof MIGRATION_FILES)[number];

export type DbRole = "anon" | "authenticated" | "service_role";
export type Row = Record<string, unknown>;

/** What a failed statement looks like once it has been turned into plain data. */
export interface PgErrorInfo {
  /** SQLSTATE, e.g. "23514" (check violation) or "54000" (our limit error). */
  code: string | undefined;
  message: string;
  /** Name of the violated constraint, when Postgres reports one. */
  constraint: string | undefined;
  table: string | undefined;
}

/** The pieces of Supabase the migrations lean on. */
const SUPABASE_STUBS_SQL = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- ---- auth ----------------------------------------------------------------
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- Supabase's own definition: the id of the signed-in user, or null.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- ---- storage -------------------------------------------------------------
create schema storage;

create table storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
alter table storage.buckets enable row level security;

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  version text,
  owner_id text,
  user_metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored
);
create unique index bucketid_objname on storage.objects (bucket_id, name);
alter table storage.objects enable row level security;

-- Supabase's own definition: every folder in the path, without the file name.
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- ---- public: what Supabase grants on every table the owner creates -------
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

// FIREHUNT_MIGRATIONS_DIR lets a developer point the tests at a COPY of the migrations,
// for example to break one on purpose and watch the tests catch it (a "mutation check")
// without touching the real files. Unset, the real supabase/migrations/ folder is used.
const MIGRATIONS_DIR =
  process.env.FIREHUNT_MIGRATIONS_DIR?.replace(/[\\/]?$/, "/") ??
  fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

/** The exact text of a migration file, as the owner would paste it. */
export function readMigration(file: MigrationFile): string {
  return readFileSync(`${MIGRATIONS_DIR}${file}`, "utf8");
}

/** Turn whatever a failed query threw into plain data a test can assert on. */
export function describeError(err: unknown): PgErrorInfo {
  const e = err as Partial<PgErrorInfo> & { message?: string };
  return {
    code: e.code,
    message: e.message ?? String(err),
    constraint: e.constraint,
    table: e.table,
  };
}

/**
 * Await a query that is expected to FAIL and return what the database said.
 * Throws if it succeeded, so a test can never pass by accident when a guard is gone.
 */
export async function pgError(pending: Promise<unknown>): Promise<PgErrorInfo> {
  let result: unknown;
  try {
    result = await pending;
  } catch (err) {
    return describeError(err);
  }
  throw new Error(`Expected the statement to fail, but it succeeded: ${JSON.stringify(result)}`);
}

/** Something that runs SQL: a whole request, or the inside of a multi-statement one. */
export interface Querier {
  /** Run one statement and return its rows. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** A caller as the database sees them: a role, and (for signed-in users) an id. */
export interface Session extends Querier {
  /** Run one statement and report how many rows it touched, plus its rows. */
  run<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows: number }>;
  /**
   * Run several statements as ONE request (one transaction). If any of them fails
   * the whole request is rolled back and the error is thrown, like a real request.
   */
  transaction<R>(work: (q: Querier) => Promise<R>): Promise<R>;
}

export class PgHarness {
  private notices: string[] = [];

  private constructor(readonly db: PGlite) {}

  /** A bare Supabase-like database with no FireHunt migrations applied. */
  static async create(): Promise<PgHarness> {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(SUPABASE_STUBS_SQL);
    return new PgHarness(db);
  }

  /** A database with the given migrations already applied (default: all three). */
  static async createMigrated(files: readonly MigrationFile[] = MIGRATION_FILES) {
    const pg = await PgHarness.create();
    for (const file of files) await pg.applyMigration(file);
    return pg;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Run a migration file verbatim, the way the SQL editor does (one script, all
   * statements in one implicit transaction). Returns the NOTICE messages it raised.
   */
  async applyMigration(file: MigrationFile): Promise<string[]> {
    return this.runScriptAsAdmin(readMigration(file));
  }

  /** Run any SQL script as the database owner (no row-level security). Returns notices. */
  async runScriptAsAdmin(sql: string): Promise<string[]> {
    const seen: string[] = [];
    await this.db.exec(sql, {
      onNotice: (n) => {
        if (n.message) seen.push(n.message);
      },
    });
    this.notices.push(...seen);
    return seen;
  }

  /** Every notice raised by every script run so far. */
  get allNotices(): readonly string[] {
    return this.notices;
  }

  /** Run one statement as the database owner (no row-level security), e.g. to seed data. */
  async admin<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.db.query<T>(sql, params);
    return res.rows;
  }

  /** Create an account in auth.users and return its id. */
  async createUser(email?: string): Promise<string> {
    const rows = await this.admin<{ id: string }>(
      "insert into auth.users (email) values ($1) returning id",
      [email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.test`],
    );
    return rows[0].id;
  }

  /** Requests made by a signed-in user (role `authenticated`, JWT sub = userId). */
  asUser(userId: string): Session {
    return this.session("authenticated", userId);
  }

  /** Requests made with the public anon key and no sign-in. */
  asAnon(): Session {
    return this.session("anon", null);
  }

  /** Requests made by the server with the service key (bypasses row-level security). */
  asService(): Session {
    return this.session("service_role", null);
  }

  private session(role: DbRole, userId: string | null): Session {
    const db = this.db;

    /** Same thing PostgREST / the Storage API do at the start of every request. */
    async function becomeCaller(tx: Transaction) {
      await tx.exec(`set local role ${role}`);
      const claims: Record<string, string> = { role };
      if (userId) claims.sub = userId;
      await tx.query(
        `select set_config('request.jwt.claims', $1, true),
                set_config('request.jwt.claim.role', $2, true),
                set_config('request.jwt.claim.sub', $3, true)`,
        [JSON.stringify(claims), role, userId ?? ""],
      );
    }

    const session: Session = {
      async run<T extends Row = Row>(sql: string, params: unknown[] = []) {
        return db.transaction(async (tx) => {
          await becomeCaller(tx);
          const res = await tx.query<T>(sql, params);
          return { rows: res.rows, affectedRows: res.affectedRows ?? 0 };
        });
      },
      async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
        return (await session.run<T>(sql, params)).rows;
      },
      async transaction<R>(work: (q: Querier) => Promise<R>) {
        return db.transaction(async (tx) => {
          await becomeCaller(tx);
          return work({
            query: async <T extends Row = Row>(sql: string, params: unknown[] = []) =>
              (await tx.query<T>(sql, params)).rows,
          });
        });
      },
    };
    return session;
  }
}
