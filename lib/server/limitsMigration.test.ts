// lib/server/limitsMigration.test.ts
// Runs the REAL migration files (supabase/migrations/001, 002, 003) on a real
// Postgres (PGlite) and checks that migration 003 does exactly what lib/limits.ts
// says it does. Nobody can try 003 on the live Supabase project until the owner
// pastes it into the SQL editor, so this is where a mistake gets caught.
//
// The "drift guard" tests read every number from LIMITS, so if a number in
// lib/limits.ts and the SQL ever disagree, one of them goes red.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CV_ALLOWED_MIME_TYPES, LIMITS, LIMIT_ERROR_CODE } from "@/lib/limits";
import { PgHarness, pgError, type Session } from "./testing/pgHarness";

const CHECK_VIOLATION = "23514";
const RLS_DENIED = "42501";
const UNIQUE_VIOLATION = "23505";
const LIMIT_MESSAGE_START = "FireHunt limit:";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const JSON_COLUMNS = new Set(["contacts", "analysis"]);

/** Build "insert into <table> (cols) values (...) returning id" from a plain object. */
function buildInsert(table: string, values: Record<string, unknown>) {
  const cols = Object.keys(values);
  if (cols.length === 0) {
    return { sql: `insert into ${table} default values returning id`, params: [] as unknown[] };
  }
  const marks = cols.map((c, i) => (JSON_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
  return {
    sql: `insert into ${table} (${cols.join(", ")}) values (${marks.join(", ")}) returning id`,
    params: cols.map((c) => values[c]),
  };
}

/** Insert one job as this user. JSON columns are passed as JSON text (or null). */
function insertJob(s: Session, values: Record<string, unknown> = {}) {
  const { sql, params } = buildInsert("jobs", values);
  return s.query<{ id: string }>(sql, params);
}

/** Insert one CV record whose path is the correct "<user_id>/<id>" unless overridden. */
function insertCv(s: Session, userId: string, values: Record<string, unknown> = {}) {
  const id = (values.id as string | undefined) ?? randomUUID();
  const { sql, params } = buildInsert("cvs", { id, path: `${userId}/${id}`, ...values });
  return s.query<{ id: string }>(sql, params);
}

const insertRow = (table: "jobs" | "cvs", s: Session, userId: string, values: Record<string, unknown>) =>
  table === "jobs" ? insertJob(s, values) : insertCv(s, userId, values);

/** Add n jobs in ONE statement (like a batch sync). */
const fillJobs = (s: Session, n: number) =>
  s.query("insert into jobs (title) select 'job ' || g from generate_series(1, $1::int) g", [n]);

/** Add n CV records in ONE statement, each with a correct path. */
const fillCvs = (s: Session, n: number) =>
  s.query(
    `with ids as (select gen_random_uuid() as id from generate_series(1, $1::int))
     insert into cvs (id, name, path)
     select id, 'cv', auth.uid()::text || '/' || id::text from ids`,
    [n],
  );

/** Rows the signed-in user can see in a table (row-level security applies). */
async function count(s: Session, table: string): Promise<number> {
  const rows = await s.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0].n;
}

async function idsOf(s: Session, table: string): Promise<string[]> {
  return (await s.query<{ id: string }>(`select id from ${table} order by id`)).map((r) => r.id);
}

type UpsertRow = { id: string; user_id: string; label: string };

/** Batch upsert, the way PostgREST sends it: one INSERT ... ON CONFLICT DO UPDATE statement. */
function upsertJobs(s: Session, rows: UpsertRow[]) {
  return s.run(
    `insert into jobs (id, user_id, title)
     select id, user_id, label from json_to_recordset($1::json) as t(id uuid, user_id uuid, label text)
     on conflict (id) do update set user_id = excluded.user_id, title = excluded.title`,
    [JSON.stringify(rows)],
  );
}

function upsertCvs(s: Session, rows: UpsertRow[]) {
  return s.run(
    `insert into cvs (id, user_id, name, path)
     select id, user_id, label, user_id::text || '/' || id::text
       from json_to_recordset($1::json) as t(id uuid, user_id uuid, label text)
     on conflict (id) do update
       set user_id = excluded.user_id, name = excluded.name, path = excluded.path`,
    [JSON.stringify(rows)],
  );
}

/** A text value of exactly n characters (not bytes, not UTF-16 units). */
const chars = (n: number, ch = "a") => ch.repeat(n);

// ---------------------------------------------------------------------------
// Which constraint belongs to which number in lib/limits.ts.
// This table is the drift guard: it must cover EVERY entry of LIMITS.job and
// LIMITS.cv, and every check constraint the migration creates.
// ---------------------------------------------------------------------------

type TextCase = {
  limit: string; // which entry of LIMITS this is, e.g. "job.title"
  table: "jobs" | "cvs";
  column: string;
  max: number;
  constraint: string;
};

const TEXT_FIELDS: TextCase[] = [
  { limit: "job.title", table: "jobs", column: "title", max: LIMITS.job.title, constraint: "jobs_title_len" },
  { limit: "job.company", table: "jobs", column: "company", max: LIMITS.job.company, constraint: "jobs_company_len" },
  { limit: "job.country", table: "jobs", column: "country", max: LIMITS.job.country, constraint: "jobs_country_len" },
  { limit: "job.url", table: "jobs", column: "url", max: LIMITS.job.url, constraint: "jobs_url_len" },
  { limit: "job.salary", table: "jobs", column: "salary", max: LIMITS.job.salary, constraint: "jobs_salary_len" },
  { limit: "job.status", table: "jobs", column: "status", max: LIMITS.job.status, constraint: "jobs_status_len" },
  { limit: "job.notes", table: "jobs", column: "notes", max: LIMITS.job.notes, constraint: "jobs_notes_len" },
  { limit: "job.date", table: "jobs", column: "deadline", max: LIMITS.job.date, constraint: "jobs_deadline_len" },
  { limit: "job.date", table: "jobs", column: "follow_up_date", max: LIMITS.job.date, constraint: "jobs_follow_up_len" },
  { limit: "job.cvId", table: "jobs", column: "cv_id", max: LIMITS.job.cvId, constraint: "jobs_cv_id_len" },
  { limit: "cv.name", table: "cvs", column: "name", max: LIMITS.cv.name, constraint: "cvs_name_len" },
  { limit: "cv.role", table: "cvs", column: "role", max: LIMITS.cv.role, constraint: "cvs_role_len" },
  { limit: "cv.type", table: "cvs", column: "type", max: LIMITS.cv.type, constraint: "cvs_type_len" },
];

type JsonCase = {
  limit: string;
  column: "contacts" | "analysis";
  max: number;
  constraint: string;
};

const JSON_FIELDS: JsonCase[] = [
  { limit: "job.contactsJson", column: "contacts", max: LIMITS.job.contactsJson, constraint: "jobs_contacts_size" },
  { limit: "job.analysisJson", column: "analysis", max: LIMITS.job.analysisJson, constraint: "jobs_analysis_size" },
];

const OTHER_CONSTRAINTS = ["cvs_size_range", "cvs_path_shape"];

// ===========================================================================
// 1) The migration applies cleanly, and applying it again changes nothing.
// ===========================================================================

/** Everything 003 creates or changes, as plain data, so two states can be compared. */
async function schemaSnapshot(pg: PgHarness) {
  return {
    constraints: await pg.admin(
      `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def, convalidated
         from pg_constraint
        where connamespace = 'public'::regnamespace and contype = 'c'
        order by 1, 2`,
    ),
    triggers: await pg.admin(
      `select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def, tgenabled
         from pg_trigger where not tgisinternal order by 1, 2`,
    ),
    policies: await pg.admin(
      `select schemaname, tablename, policyname, cmd, roles::text as roles, qual, with_check
         from pg_policies order by 1, 2, 3`,
    ),
    functions: await pg.admin(
      `select proname, prosrc, proconfig::text as config
         from pg_proc where pronamespace = 'public'::regnamespace order by 1`,
    ),
    bucket: await pg.admin(
      "select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id",
    ),
  };
}

describe("applying migration 003", () => {
  let pg: PgHarness;
  let firstRunNotices: string[];
  beforeAll(async () => {
    pg = await PgHarness.createMigrated(["001_init.sql", "002_ai_and_rate_limits.sql"]);
    // If 003 had a typo, this line would throw and every test below would fail.
    firstRunNotices = await pg.applyMigration("003_limits.sql");
  }, 60_000);
  afterAll(() => pg.close());

  it("applies cleanly on top of 001 + 002, with no warnings on an empty database", async () => {
    expect(firstRunNotices.filter((n) => n.includes("FireHunt"))).toEqual([]);

    const unvalidated = await pg.admin(
      "select conname from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c' and not convalidated",
    );
    expect(unvalidated).toEqual([]);
  });

  it("creates exactly the constraints, triggers and policies the tests know about", async () => {
    const constraints = await pg.admin<{ conname: string }>(
      "select conname from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c' order by conname",
    );
    const expected = [
      ...TEXT_FIELDS.map((c) => c.constraint),
      ...JSON_FIELDS.map((c) => c.constraint),
      ...OTHER_CONSTRAINTS,
    ].sort();
    expect(constraints.map((c) => c.conname)).toEqual(expected);

    const triggers = await pg.admin<{ tgname: string }>(
      "select tgname from pg_trigger where not tgisinternal order by tgname",
    );
    expect(triggers.map((t) => t.tgname)).toEqual(["cvs_row_cap", "jobs_row_cap"]);

    const storagePolicies = await pg.admin<{ policyname: string }>(
      "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname",
    );
    expect(storagePolicies.map((p) => p.policyname)).toEqual([
      "cv delete own",
      "cv insert own",
      "cv read own",
      "cv update own",
    ]);
  });

  it("running it a second time is a no-op (idempotent)", async () => {
    const before = await schemaSnapshot(pg);
    const notices = await pg.applyMigration("003_limits.sql");
    const after = await schemaSnapshot(pg);

    expect(after).toEqual(before);
    expect(notices.filter((n) => n.includes("FireHunt"))).toEqual([]);

    // And it still enforces afterwards (a re-run did not quietly drop anything).
    const userId = await pg.createUser();
    const s = pg.asUser(userId);
    const err = await pgError(insertJob(s, { title: chars(LIMITS.job.title + 1) }));
    expect(err.code).toBe(CHECK_VIOLATION);
  });

  it("replaying the whole sequence 001, 002, 003 again leaves the same state", async () => {
    const before = await schemaSnapshot(pg);
    for (const file of ["001_init.sql", "002_ai_and_rate_limits.sql", "003_limits.sql"] as const) {
      await pg.applyMigration(file);
    }
    expect(await schemaSnapshot(pg)).toEqual(before);
  });
});

describe("applying migration 003 in the wrong order", () => {
  it("fails as a whole, leaving nothing half-applied, when 002 has not been run", async () => {
    const pg = await PgHarness.createMigrated(["001_init.sql"]);
    try {
      const before = await schemaSnapshot(pg);

      // 003 needs the jobs.contacts / jobs.analysis columns that 002 adds.
      const err = await pgError(pg.applyMigration("003_limits.sql"));
      expect(err.message).toMatch(/contacts/);

      // The script is one transaction: the rules that ran before the failure were undone too.
      expect(await schemaSnapshot(pg)).toEqual(before);
    } finally {
      await pg.close();
    }
  });
});

// ===========================================================================
// Everything below runs against one database with all three migrations applied.
// Each test uses brand-new accounts, so tests do not affect each other.
// ===========================================================================

describe("limits enforced by the database", () => {
  let pg: PgHarness;

  beforeAll(async () => {
    pg = await PgHarness.createMigrated();
  }, 60_000);
  afterAll(() => pg.close());

  async function account() {
    const id = await pg.createUser();
    return { id, s: pg.asUser(id) };
  }

  /** JSON text which Postgres will print (jsonb::text) as exactly n characters. */
  async function jsonWithTextLength(n: number, filler = "x"): Promise<string> {
    // jsonb prints {"a": "..."}: 7 characters before the filler and 2 after it.
    const json = JSON.stringify({ a: filler.repeat(n - 9) });
    const [{ len }] = await pg.admin<{ len: number }>(
      "select char_length($1::jsonb::text)::int as len",
      [json],
    );
    expect(len).toBe(n);
    return json;
  }

  // -------------------------------------------------------------------------
  describe("field sizes (drift guard against lib/limits.ts)", () => {
    it("the test table covers every entry of LIMITS.job and LIMITS.cv", () => {
      const covered = new Set([...TEXT_FIELDS, ...JSON_FIELDS].map((c) => c.limit));
      const declared = [
        ...Object.keys(LIMITS.job).map((k) => `job.${k}`),
        ...Object.keys(LIMITS.cv).map((k) => `cv.${k}`),
      ];
      expect([...covered].sort()).toEqual(declared.sort());
    });

    it.each(TEXT_FIELDS)(
      "$constraint: exactly $max characters is accepted, one more is rejected",
      async ({ table, column, max, constraint }) => {
        const { id, s } = await account();

        await insertRow(table, s, id, { [column]: chars(max) });

        const err = await pgError(insertRow(table, s, id, { [column]: chars(max + 1) }));
        expect(err.code).toBe(CHECK_VIOLATION);
        expect(err.constraint).toBe(constraint);
      },
    );

    it.each(TEXT_FIELDS)(
      "$constraint: an UPDATE past $max characters is rejected too",
      async ({ table, column, max, constraint }) => {
        const { id, s } = await account();
        const [row] = await insertRow(table, s, id, { [column]: "short" });

        await s.query(`update ${table} set ${column} = $1 where id = $2`, [chars(max), row.id]);
        const err = await pgError(
          s.query(`update ${table} set ${column} = $1 where id = $2`, [chars(max + 1), row.id]),
        );
        expect(err.code).toBe(CHECK_VIOLATION);
        expect(err.constraint).toBe(constraint);
      },
    );

    it.each(JSON_FIELDS)(
      "$constraint: exactly $max characters of jsonb text is accepted, one more is rejected",
      async ({ column, max, constraint }) => {
        const { s } = await account();

        await insertJob(s, { [column]: await jsonWithTextLength(max) });

        const err = await pgError(insertJob(s, { [column]: await jsonWithTextLength(max + 1) }));
        expect(err.code).toBe(CHECK_VIOLATION);
        expect(err.constraint).toBe(constraint);
      },
    );

    it.each(JSON_FIELDS)(
      "$constraint: the size is measured on jsonb text, which is LONGER than JSON.stringify",
      async ({ column, max, constraint }) => {
        // JSON.stringify prints {"a":"..."} with no spaces; Postgres prints {"a": "..."}.
        // So a value whose JSON.stringify length is exactly the cap is one character
        // too long once stored. This is why the app clamps well below the cap.
        const { s } = await account();
        const compact = JSON.stringify({ a: "x".repeat(max - 8) });
        expect(compact.length).toBe(max);

        const err = await pgError(insertJob(s, { [column]: compact }));
        expect(err.code).toBe(CHECK_VIOLATION);
        expect(err.constraint).toBe(constraint);
      },
    );

    it("jsonb text is at most 1.5x the compact JSON, so the app's 80% clamp is safe for objects but not for arrays of tiny numbers", async () => {
      const shapes = {
        objectOfStrings: JSON.stringify({ name: "Ana Example", email: "ana@example.test", phone: "+10000000000" }),
        arrayOfObjects: JSON.stringify(
          Array.from({ length: 40 }, (_, i) => ({ name: `Person ${i}`, role: "Recruiter" })),
        ),
        arrayOfDigits: JSON.stringify(Array.from({ length: 1000 }, () => 1)),
      };
      const ratio: Record<string, number> = {};
      for (const [name, json] of Object.entries(shapes)) {
        const [{ len }] = await pg.admin<{ len: number }>(
          "select char_length($1::jsonb::text)::int as len",
          [json],
        );
        ratio[name] = len / json.length;
      }
      // Realistic, text-heavy JSON grows by well under 25%, so clamping at 80% of the cap holds.
      expect(ratio.objectOfStrings).toBeLessThanOrEqual(1.25);
      expect(ratio.arrayOfObjects).toBeLessThanOrEqual(1.25);
      // The worst possible shape (a long list of one-digit numbers) grows by 50%.
      expect(ratio.arrayOfDigits).toBeGreaterThan(1.25);
      expect(ratio.arrayOfDigits).toBeLessThanOrEqual(1.5);
    });

    it("cvs.size: 0 through LIMITS.cvRecordMaxBytes is accepted, over it or negative is rejected", async () => {
      const { id, s } = await account();

      await insertCv(s, id, { size: 0 });
      await insertCv(s, id, { size: LIMITS.cvFileBytes }); // what the bucket allows
      await insertCv(s, id, { size: LIMITS.cvRecordMaxBytes }); // old, larger CVs stay editable

      for (const bad of [LIMITS.cvRecordMaxBytes + 1, -1]) {
        const err = await pgError(insertCv(s, id, { size: bad }));
        expect(err.code).toBe(CHECK_VIOLATION);
        expect(err.constraint).toBe("cvs_size_range");
      }
    });

    it("cvs.path must be exactly '<user_id>/<id>'", async () => {
      const { id, s } = await account();
      const other = await pg.createUser();

      await insertCv(s, id); // the correct shape (insertCv builds it)

      // Each wrong path changes ONE thing about the right one, so every part of the rule is pinned.
      const wrongPaths: Record<string, (rowId: string) => string> = {
        "a different CV's id": () => `${id}/${randomUUID()}`,
        "somebody else's folder, right id": (rowId) => `${other}/${rowId}`,
        "an extra segment": (rowId) => `${id}/${rowId}/extra`,
        "a leading slash": (rowId) => `/${id}/${rowId}`,
        "upper-case id (not the canonical form)": (rowId) => `${id}/${rowId.toUpperCase()}`,
        "no folder": (rowId) => rowId,
        "the user folder only": () => `${id}/`,
        "empty": () => "",
      };
      for (const [what, makePath] of Object.entries(wrongPaths)) {
        const rowId = randomUUID();
        const err = await pgError(insertCv(s, id, { id: rowId, path: makePath(rowId) }));
        expect(err.constraint, what).toBe("cvs_path_shape");
        expect(err.code, what).toBe(CHECK_VIOLATION);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("a bare row (all defaults) fits every limit", async () => {
      const { s } = await account();
      await insertJob(s, {});
    });

    it("NULL deadline, follow-up date, CV link, contacts and analysis are accepted", async () => {
      const { s } = await account();
      await insertJob(s, { deadline: null, follow_up_date: null, cv_id: null, contacts: null, analysis: null });
    });

    it("JSON null and tiny JSON values are accepted", async () => {
      const { s } = await account();
      await insertJob(s, { contacts: "null", analysis: "[]" });
      await insertJob(s, { contacts: "{}", analysis: "0" });
    });

    it("empty strings are accepted in every text column", async () => {
      const { id, s } = await account();
      const jobCols = Object.fromEntries(
        TEXT_FIELDS.filter((c) => c.table === "jobs").map((c) => [c.column, ""]),
      );
      const cvCols = Object.fromEntries(
        TEXT_FIELDS.filter((c) => c.table === "cvs").map((c) => [c.column, ""]),
      );
      await insertJob(s, jobCols);
      await insertCv(s, id, cvCols);
    });

    it("counts characters, not bytes and not UTF-16 units: Arabic and emoji", async () => {
      const { s } = await account();
      const max = LIMITS.job.title;

      const samples = {
        arabic: chars(max, "م"), // 2 bytes per character in UTF-8
        emoji: chars(max, "😀"), // 4 bytes, and 2 UTF-16 units, per character
        family: "👨‍👩‍👧".repeat(max / 5), // 5 code points (3 people + 2 joiners) per repeat
      };
      for (const text of Object.values(samples)) {
        expect(Array.from(text).length).toBe(max);
        // The app clamps with .length, which is never smaller than the real character count.
        expect(text.length).toBeGreaterThanOrEqual(max);
        await insertJob(s, { title: text });
      }
      expect(samples.emoji.length).toBe(max * 2);

      for (const text of Object.values(samples)) {
        const err = await pgError(insertJob(s, { title: text + "x" }));
        expect(err.constraint).toBe("jobs_title_len");
      }
    });

    it.each(TEXT_FIELDS)(
      "$constraint counts characters, not bytes (Arabic is 2 bytes per character)",
      async ({ table, column, max, constraint }) => {
        const { id, s } = await account();
        await insertRow(table, s, id, { [column]: chars(max, "م") });
        const err = await pgError(insertRow(table, s, id, { [column]: chars(max + 1, "م") }));
        expect(err.constraint).toBe(constraint);
      },
    );

    it.each(JSON_FIELDS)(
      "$constraint counts characters, not bytes (emoji inside the JSON)",
      async ({ column, max, constraint }) => {
        const { s } = await account();
        await insertJob(s, { [column]: await jsonWithTextLength(max, "😀") });
        const err = await pgError(insertJob(s, { [column]: await jsonWithTextLength(max + 1, "😀") }));
        expect(err.constraint).toBe(constraint);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe.each([
    {
      table: "jobs",
      cap: LIMITS.jobsPerUser,
      noun: "jobs",
      fill: fillJobs,
      upsert: upsertJobs,
      labelColumn: "title",
    },
    {
      table: "cvs",
      cap: LIMITS.cvsPerUser,
      noun: "CVs",
      fill: fillCvs,
      upsert: upsertCvs,
      labelColumn: "name",
    },
  ] as const)("row cap: $table", ({ table, cap, noun, fill, upsert, labelColumn }) => {
    const labels = async (s: Session) =>
      Object.fromEntries(
        (await s.query<{ id: string; label: string }>(`select id, ${labelColumn} as label from ${table}`)).map(
          (r) => [r.id, r.label],
        ),
      );

    it("accepts rows up to the cap, then rejects the next NEW row with a limit error", async () => {
      const { s } = await account();

      await fill(s, cap);
      expect(await count(s, table)).toBe(cap);

      const err = await pgError(fill(s, 1));
      expect(err.code).toBe(LIMIT_ERROR_CODE);
      expect(err.code).toBe("54000");
      expect(err.message.startsWith(LIMIT_MESSAGE_START)).toBe(true);
      expect(err.message).toContain(`${cap} ${noun}`);
      expect(await count(s, table)).toBe(cap);
    });

    it("one statement that would cross the cap stores nothing", async () => {
      const { s } = await account();
      await fill(s, cap - 2);

      const err = await pgError(fill(s, 5));
      expect(err.code).toBe(LIMIT_ERROR_CODE);
      expect(await count(s, table)).toBe(cap - 2);
    });

    it("an account sitting exactly at the cap can still upsert and update its existing rows", async () => {
      const { id, s } = await account();
      await fill(s, cap);
      const ids = await idsOf(s, table);

      // INSERT ... ON CONFLICT DO UPDATE for every existing id, as the sync does.
      const result = await upsert(
        s,
        ids.map((rowId) => ({ id: rowId, user_id: id, label: "renamed" })),
      );
      expect(result.affectedRows).toBe(cap);
      expect(Object.values(await labels(s)).every((l) => l === "renamed")).toBe(true);
      expect(await count(s, table)).toBe(cap);

      // A plain UPDATE has no insert trigger at all.
      await s.query(`update ${table} set ${labelColumn} = 'edited' where id = $1`, [ids[0]]);
    });

    it("a batch upsert mixing existing and new ids that crosses the cap is rejected whole", async () => {
      const { id, s } = await account();
      await fill(s, cap - 2);
      const [existing] = await idsOf(s, table);
      const fresh = [randomUUID(), randomUUID(), randomUUID()];

      const err = await pgError(
        upsert(s, [
          { id: existing, user_id: id, label: "renamed" },
          ...fresh.map((rowId) => ({ id: rowId, user_id: id, label: "new" })),
        ]),
      );
      expect(err.code).toBe(LIMIT_ERROR_CODE);

      // Atomic: not even the existing row's rename, nor the new rows that fitted, were kept.
      expect(await count(s, table)).toBe(cap - 2);
      const after = await labels(s);
      expect(after[existing]).not.toBe("renamed");
      for (const rowId of fresh) expect(after[rowId]).toBeUndefined();
    });

    it("a batch upsert mixing existing and new ids that lands exactly on the cap is accepted", async () => {
      const { id, s } = await account();
      await fill(s, cap - 2);
      const [existing] = await idsOf(s, table);
      const fresh = [randomUUID(), randomUUID()];

      await upsert(s, [
        { id: existing, user_id: id, label: "renamed" },
        ...fresh.map((rowId) => ({ id: rowId, user_id: id, label: "new" })),
      ]);

      expect(await count(s, table)).toBe(cap);
      const after = await labels(s);
      expect(after[existing]).toBe("renamed");
      for (const rowId of fresh) expect(after[rowId]).toBe("new");
    });

    it("caps are per account: one account at the cap does not stop another, and both can be full", async () => {
      const a = await account();
      const b = await account();

      await fill(a.s, cap);
      await fill(b.s, 1); // B is unaffected by A being full
      await fill(b.s, cap - 1); // and B can fill up too: more than `cap` rows now exist in total

      expect(await count(a.s, table)).toBe(cap);
      expect(await count(b.s, table)).toBe(cap);
      const [{ total }] = await pg.admin<{ total: number }>(
        `select count(*)::int as total from ${table} where user_id = any($1::uuid[])`,
        [[a.id, b.id]],
      );
      expect(total).toBe(cap * 2);

      expect((await pgError(fill(a.s, 1))).code).toBe(LIMIT_ERROR_CODE);
      expect((await pgError(fill(b.s, 1))).code).toBe(LIMIT_ERROR_CODE);
    });

    it("deleting a row frees exactly one slot", async () => {
      const { s } = await account();
      await fill(s, cap);
      const [first] = await idsOf(s, table);

      const deleted = await s.run(`delete from ${table} where id = $1`, [first]);
      expect(deleted.affectedRows).toBe(1);

      await fill(s, 1);
      expect(await count(s, table)).toBe(cap);
      expect((await pgError(fill(s, 1))).code).toBe(LIMIT_ERROR_CODE);
    });

    it("re-using an id you already have at the cap gets the ordinary duplicate-key error", async () => {
      const { id, s } = await account();
      await fill(s, cap);
      const [existing] = await idsOf(s, table);

      const err = await pgError(
        table === "jobs"
          ? insertJob(s, { id: existing })
          : insertCv(s, id, { id: existing }),
      );
      expect(err.code).toBe(UNIQUE_VIOLATION);
    });
  });

  describe("row cap details", () => {
    it("the cap also applies to the server's service key", async () => {
      const { id, s } = await account();
      await fillJobs(s, LIMITS.jobsPerUser);

      const err = await pgError(
        pg.asService().query("insert into jobs (user_id, title) values ($1, 'x')", [id]),
      );
      expect(err.code).toBe(LIMIT_ERROR_CODE);
    });

    it("counts per account even when row-level security is bypassed (service key)", async () => {
      // With the service key the trigger can see everybody's rows, so it must filter by
      // account itself: one full account must not block a different account.
      const full = await account();
      const other = await pg.createUser();
      await fillJobs(full.s, LIMITS.jobsPerUser);

      await pg.asService().query("insert into jobs (user_id, title) values ($1, 'x')", [other]);
      expect(await pg.admin("select 1 from jobs where user_id = $1", [other])).toHaveLength(1);
    });

    it("takes a per-account, per-table advisory lock that is held until the request ends", async () => {
      // This is what makes the count exact when two requests race. PGlite has a single
      // connection, so we cannot race two requests here; we check the lock is taken.
      const a = await pg.createUser();
      const b = await pg.createUser();
      const advisoryLocks = async (q: { query: Session["query"] }) =>
        (
          await q.query<{ n: number }>(
            "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
          )
        )[0].n;

      const seen = await pg.asService().transaction(async (q) => {
        const steps = [await advisoryLocks(q)];
        await q.query("insert into jobs (user_id, title) values ($1, 'x')", [a]);
        steps.push(await advisoryLocks(q));
        await q.query("insert into jobs (user_id, title) values ($1, 'y')", [a]);
        steps.push(await advisoryLocks(q)); // same account and table: same lock
        await q.query("insert into jobs (user_id, title) values ($1, 'z')", [b]);
        steps.push(await advisoryLocks(q)); // another account: another lock
        const cvId = randomUUID();
        await q.query("insert into cvs (id, user_id, path) values ($1, $2, $3)", [cvId, a, `${a}/${cvId}`]);
        steps.push(await advisoryLocks(q)); // same account, other table: another lock
        return steps;
      });
      expect(seen).toEqual([0, 1, 1, 2, 3]);

      // The transaction is over: the locks are gone.
      const [{ n }] = await pg.admin<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
      );
      expect(n).toBe(0);
    });

    it("the trigger function cannot be called directly by a signed-in user", async () => {
      const { s } = await account();
      const err = await pgError(s.query("select public.enforce_row_cap()"));
      expect(err.message).toMatch(/trigger functions can only be called as triggers/i);
    });
  });

  // -------------------------------------------------------------------------
  describe("row-level security still holds with the new constraints and triggers", () => {
    it("user A cannot insert a job or CV that belongs to user B", async () => {
      const a = await account();
      const b = await account();

      const jobErr = await pgError(insertJob(a.s, { user_id: b.id, title: "planted" }));
      expect(jobErr.code).toBe(RLS_DENIED);

      const cvId = randomUUID();
      const cvErr = await pgError(insertCv(a.s, a.id, { id: cvId, user_id: b.id, path: `${b.id}/${cvId}` }));
      expect(cvErr.code).toBe(RLS_DENIED);

      expect(await count(b.s, "jobs")).toBe(0);
      expect(await count(b.s, "cvs")).toBe(0);
    });

    it("user A cannot take over B's job or CV by upserting its id", async () => {
      const a = await account();
      const b = await account();
      const [bJob] = await insertJob(b.s, { title: "B's job" });
      const [bCv] = await insertCv(b.s, b.id, { name: "B's cv" });

      const jobErr = await pgError(upsertJobs(a.s, [{ id: bJob.id, user_id: a.id, label: "stolen" }]));
      expect(jobErr.code).toBe(RLS_DENIED);
      const cvErr = await pgError(upsertCvs(a.s, [{ id: bCv.id, user_id: a.id, label: "stolen" }]));
      expect(cvErr.code).toBe(RLS_DENIED);

      const jobs = await pg.admin("select user_id, title from jobs where id = $1", [bJob.id]);
      expect(jobs).toEqual([{ user_id: b.id, title: "B's job" }]);
      const cvs = await pg.admin("select user_id, name from cvs where id = $1", [bCv.id]);
      expect(cvs).toEqual([{ user_id: b.id, name: "B's cv" }]);
    });

    it("user A cannot see, edit or delete B's rows", async () => {
      const a = await account();
      const b = await account();
      const [bJob] = await insertJob(b.s, { title: "B's job" });
      const [bCv] = await insertCv(b.s, b.id, {});
      await insertJob(a.s, { title: "A's job" });

      expect(await count(a.s, "jobs")).toBe(1);
      expect(await a.s.query("select 1 from jobs where id = $1", [bJob.id])).toEqual([]);
      expect(await a.s.query("select 1 from cvs where id = $1", [bCv.id])).toEqual([]);

      const upd = await a.s.run("update jobs set title = 'hacked' where id = $1", [bJob.id]);
      expect(upd.affectedRows).toBe(0);
      const del = await a.s.run("delete from cvs where id = $1", [bCv.id]);
      expect(del.affectedRows).toBe(0);

      expect(await count(b.s, "jobs")).toBe(1);
      expect(await count(b.s, "cvs")).toBe(1);
    });

    it("the count trigger cannot be used to probe how full B is", async () => {
      const a = await account();
      const b = await account();
      await fillJobs(b.s, LIMITS.jobsPerUser); // B is completely full
      const [bJob] = await b.s.query<{ id: string }>("select id from jobs limit 1");

      // Pretending to be B: refused by row-level security, exactly as if B were empty.
      const spoof = await pgError(insertJob(a.s, { user_id: b.id }));
      expect(spoof.code).toBe(RLS_DENIED);

      // A is not full, so A learns nothing about B's rows from the limit error either.
      const grab = await pgError(upsertJobs(a.s, [{ id: bJob.id, user_id: a.id, label: "x" }]));
      expect(grab.code).toBe(RLS_DENIED);

      // When A IS full, B's real id and a random id are answered identically.
      await fillJobs(a.s, LIMITS.jobsPerUser);
      const withBId = await pgError(upsertJobs(a.s, [{ id: bJob.id, user_id: a.id, label: "x" }]));
      const withRandomId = await pgError(upsertJobs(a.s, [{ id: randomUUID(), user_id: a.id, label: "x" }]));
      expect(withBId.code).toBe(LIMIT_ERROR_CODE);
      expect(withBId).toEqual(withRandomId);
    });

    it("signed-out visitors (anon key) can neither read nor write", async () => {
      const a = await account();
      await insertJob(a.s, { title: "mine" });
      const anon = pg.asAnon();

      expect(await count(anon, "jobs")).toBe(0);
      expect(await count(anon, "cvs")).toBe(0);
      const err = await pgError(anon.query("insert into jobs (title) values ('x')"));
      expect(err.code).toBe(RLS_DENIED);
    });
  });

  // -------------------------------------------------------------------------
  describe("CV file storage", () => {
    const cvFilesPerUser = LIMITS.cvFilesPerUser;

    /** A CV record, saved the way the app now does it: BEFORE the file. Returns its id. */
    const addRecord = async (s: Session, userId: string) => (await insertCv(s, userId))[0].id;

    /** Add one file, like one Storage API upload (a single-row insert) at "<folder>/<name>". */
    const putFile = (s: Session, folder: string, name: string, size = 1) =>
      s.query(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('cvs', $1, auth.uid(), $2::jsonb) returning id`,
        [`${folder}/${name}`, JSON.stringify({ size })],
      );

    /** Replace a file, the way storage upsert does. */
    const replaceFile = (s: Session, folder: string, name: string, size: number) =>
      s.run(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('cvs', $1, auth.uid(), $2::jsonb)
         on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now()`,
        [`${folder}/${name}`, JSON.stringify({ size })],
      );

    /** One complete, honest upload: the record, then its file. Returns the record id. */
    const upload = async (s: Session, userId: string) => {
      const id = await addRecord(s, userId);
      await putFile(s, userId, id);
      return id;
    };

    /** n stray files with no CV record (leftovers from earlier testing), added by the admin. */
    const strayFiles = (userId: string, n: number, bucket = "cvs") =>
      pg.admin(
        `insert into storage.objects (bucket_id, name, owner)
         select $3, $1::text || '/stray-' || g, $1::uuid from generate_series(1, $2::int) g`,
        [userId, n, bucket],
      );

    const fileCount = (s: Session) => count(s, "storage.objects");

    it("the cvs bucket carries the size and type limits from lib/limits.ts", async () => {
      const [bucket] = await pg.admin<{
        file_size_limit: number | string | bigint;
        allowed_mime_types: string[];
        public: boolean;
      }>("select file_size_limit, allowed_mime_types, public from storage.buckets where id = 'cvs'");

      expect(Number(bucket.file_size_limit)).toBe(LIMITS.cvFileBytes);
      expect(bucket.allowed_mime_types).toHaveLength(CV_ALLOWED_MIME_TYPES.length);
      expect([...bucket.allowed_mime_types].sort()).toEqual([...CV_ALLOWED_MIME_TYPES].sort());
      expect(bucket.public).toBe(false); // still private
    });

    it("stores a file for a CV record the user already has", async () => {
      const { id, s } = await account();
      await upload(s, id);
      expect(await fileCount(s)).toBe(1);
    });

    it("refuses a file that has no CV record: made-up names, nested folders, a record that does not match", async () => {
      const { id, s } = await account();
      expect((await pgError(putFile(s, id, "cv-1"))).code).toBe(RLS_DENIED);
      expect((await pgError(putFile(s, `${id}/nested`, "cv-2"))).code).toBe(RLS_DENIED);
      // A real record exists, but the file is stored under a different name.
      await addRecord(s, id);
      expect((await pgError(putFile(s, id, randomUUID()))).code).toBe(RLS_DENIED);
      expect(await fileCount(s)).toBe(0);
    });

    it("the file's record must be the user's own: someone else's record number does not help", async () => {
      const a = await account();
      const b = await account();
      const bRecord = await addRecord(b.s, b.id);
      // Into B's folder: the folder rule stops it.
      expect((await pgError(putFile(a.s, b.id, bRecord))).code).toBe(RLS_DENIED);
      // Into A's own folder, but under B's record number: A has no such record.
      expect((await pgError(putFile(a.s, a.id, bRecord))).code).toBe(RLS_DENIED);
      expect(await fileCount(a.s)).toBe(0);
    });

    it("still confines users to their own folder", async () => {
      const a = await account();
      const b = await account();

      // No folder at all, and a different bucket: refused.
      const rootLevel = await pgError(
        a.s.query("insert into storage.objects (bucket_id, name, owner) values ('cvs', 'loose-file', auth.uid())"),
      );
      expect(rootLevel.code).toBe(RLS_DENIED);
      await pg.admin("insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing");
      const otherBucket = await pgError(
        a.s.query("insert into storage.objects (bucket_id, name, owner) values ('other', $1, auth.uid())", [
          `${a.id}/x`,
        ]),
      );
      expect(otherBucket.code).toBe(RLS_DENIED);

      // Replacing a file in B's folder is refused.
      const bRecord = await upload(b.s, b.id);
      expect((await pgError(replaceFile(a.s, b.id, bRecord, 5))).code).toBe(RLS_DENIED);

      // A cannot see B's files, and cannot move one of their own files into B's folder.
      expect(await fileCount(a.s)).toBe(0);
      const aRecord = await upload(a.s, a.id);
      const rename = await pgError(
        a.s.query("update storage.objects set name = $1 where name = $2", [`${b.id}/moved`, `${a.id}/${aRecord}`]),
      );
      expect(rename.code).toBe(RLS_DENIED);
    });

    it("the CV record cap is what caps the files: no 11th record, so no 11th file", async () => {
      const { id, s } = await account();
      for (let i = 0; i < LIMITS.cvsPerUser; i++) await upload(s, id);
      expect(await fileCount(s)).toBe(LIMITS.cvsPerUser);

      expect((await pgError(insertCv(s, id))).code).toBe(LIMIT_ERROR_CODE); // no 11th record...
      expect((await pgError(putFile(s, id, randomUUID()))).code).toBe(RLS_DENIED); // ...so no file for one
      expect(await fileCount(s)).toBe(LIMITS.cvsPerUser);
    });

    it("a multi-row insert needs a record for EVERY file, so it cannot get around the cap", async () => {
      const { id, s } = await account();
      const r1 = await addRecord(s, id);
      const r2 = await addRecord(s, id);
      const err = await pgError(
        s.query(
          `insert into storage.objects (bucket_id, name, owner)
           select 'cvs', $1::text || '/' || n, auth.uid() from unnest($2::text[]) n`,
          [id, [r1, r2, randomUUID()]], // the third has no record
        ),
      );
      expect(err.code).toBe(RLS_DENIED);
      expect(await fileCount(s)).toBe(0); // all or nothing
    });

    it("the stray-file cap is a little higher than the number of CV records, so one leftover cannot lock someone out", () => {
      expect(LIMITS.cvFilesPerUser).toBeGreaterThan(LIMITS.cvsPerUser);
    });

    it("with stray files already at the cap, a NEW file is denied but REPLACING a file you have still works", async () => {
      const { id, s } = await account();
      const keep = await upload(s, id);
      await strayFiles(id, cvFilesPerUser - 1); // now exactly at the cap
      expect(await fileCount(s)).toBe(cvFilesPerUser);

      // A new record's first file is a NEW file: over the cap.
      const fresh = await addRecord(s, id);
      expect((await pgError(putFile(s, id, fresh))).code).toBe(RLS_DENIED);

      // Replacing the file that already exists is fine (storage upsert).
      const result = await replaceFile(s, id, keep, 4242);
      expect(result.affectedRows).toBe(1);
      expect(await fileCount(s)).toBe(cvFilesPerUser);
      const [row] = await s.query<{ metadata: { size: number } }>(
        "select metadata from storage.objects where name = $1",
        [`${id}/${keep}`],
      );
      expect(row.metadata.size).toBe(4242);

      // Deleting one stray file makes room for exactly one new file.
      const del = await s.run("delete from storage.objects where name = $1", [`${id}/stray-1`]);
      expect(del.affectedRows).toBe(1);
      await putFile(s, id, fresh);
      expect(await fileCount(s)).toBe(cvFilesPerUser);
    });

    it("counts files per account: someone else being full does not matter", async () => {
      const a = await account();
      const b = await account();
      await strayFiles(a.id, cvFilesPerUser);
      await upload(b.s, b.id);
      expect(await fileCount(b.s)).toBe(1);
    });

    it("files in other buckets do not count against the CV cap", async () => {
      const { id, s } = await account();
      await pg.admin("insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing");
      await strayFiles(id, cvFilesPerUser + 5, "other");
      await upload(s, id); // not blocked, although the other bucket holds more files than the cap
      expect(await fileCount(s)).toBe(1); // the user only sees the CV bucket
      const [{ n }] = await pg.admin<{ n: number }>(
        "select count(*)::int as n from storage.objects where name like $1",
        [`${id}/%`],
      );
      expect(n).toBe(cvFilesPerUser + 5 + 1); // everything really is stored
    });

    it("signed-out visitors cannot upload", async () => {
      const { id } = await account();
      const err = await pgError(putFile(pg.asAnon(), id, randomUUID()));
      expect(err.code).toBe(RLS_DENIED);
    });

    it("deleting a CV record leaves its file behind as a stray: it can be deleted but no longer replaced", async () => {
      // This is also why the cap on files is stricter than the cap on records.
      const { id, s } = await account();
      const recordId = await upload(s, id);
      await s.run("delete from cvs where id = $1", [recordId]);

      expect(await fileCount(s)).toBe(1); // the file stays
      expect((await pgError(replaceFile(s, id, recordId, 9))).code).toBe(RLS_DENIED);
      const del = await s.run("delete from storage.objects where name = $1", [`${id}/${recordId}`]);
      expect(del.affectedRows).toBe(1);
    });
  });
});

// ===========================================================================
// 3) Data that already exists when the migration is applied ("legacy data").
// ===========================================================================

const noticesAbout = (notices: string[]) => notices.filter((n) => n.includes("FireHunt"));

describe("legacy data: rows that already exist before migration 003", () => {
  let pg: PgHarness;
  let notices: string[];

  // Accounts and rows seeded BEFORE 003 is applied.
  const ids = {
    user: "",
    // each oversize job is used by exactly one test
    jobKeepOversize: randomUUID(),
    jobUpsertUntouched: randomUUID(),
    jobFix: randomUUID(),
    jobDelete: randomUUID(),
    jobGood: randomUUID(),
    cvBigFile: randomUUID(),
    cvOddPath: randomUUID(),
    // an account already above every cap
    crowded: "",
  };
  const OVERSIZE = LIMITS.job.title + 100;

  beforeAll(async () => {
    pg = await PgHarness.createMigrated(["001_init.sql", "002_ai_and_rate_limits.sql"]);
    ids.user = await pg.createUser();
    ids.crowded = await pg.createUser();

    for (const id of [ids.jobKeepOversize, ids.jobUpsertUntouched, ids.jobFix, ids.jobDelete]) {
      await pg.admin("insert into jobs (id, user_id, title) values ($1, $2, $3)", [id, ids.user, chars(OVERSIZE)]);
    }
    await pg.admin("insert into jobs (id, user_id, title) values ($1, $2, 'fine')", [ids.jobGood, ids.user]);
    await pg.admin("insert into cvs (id, user_id, name, size, path) values ($1, $2, 'big', $3, $4)", [
      ids.cvBigFile,
      ids.user,
      LIMITS.cvRecordMaxBytes + 1_000_000,
      `${ids.user}/${ids.cvBigFile}`,
    ]);
    await pg.admin("insert into cvs (id, user_id, name, size, path) values ($1, $2, 'odd', 10, 'old-style-path')", [
      ids.cvOddPath,
      ids.user,
    ]);

    // An account that already holds more than the caps allow.
    await pg.admin(
      "insert into jobs (user_id, title) select $1, 'j' || g from generate_series(1, $2::int) g",
      [ids.crowded, LIMITS.jobsPerUser + 5],
    );
    await pg.admin(
      `insert into cvs (id, user_id, name, path)
       select id, $1::uuid, 'cv', $1::text || '/' || id::text
         from (select gen_random_uuid() as id from generate_series(1, $2::int)) t`,
      [ids.crowded, LIMITS.cvsPerUser + 2],
    );
    // ...and more stored files than the file cap allows: one for each of the first
    // cvsPerUser records, plus stray files with no record, 5 over the cap in total.
    await pg.admin(
      `insert into storage.objects (bucket_id, name, owner)
       select 'cvs', path, user_id from (select path, user_id from cvs where user_id = $1 order by id limit $2) t`,
      [ids.crowded, LIMITS.cvsPerUser],
    );
    await pg.admin(
      `insert into storage.objects (bucket_id, name, owner)
       select 'cvs', $1::text || '/f' || g, $1::uuid from generate_series(1, $2::int) g`,
      [ids.crowded, LIMITS.cvFilesPerUser + 5 - LIMITS.cvsPerUser],
    );

    notices = await pg.applyMigration("003_limits.sql");
  }, 60_000);
  afterAll(() => pg.close());

  it("does not fail, warns about the rules existing rows break, and leaves those rows alone", async () => {
    const warnings = noticesAbout(notices).filter((n) => n.includes("break the rule"));
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("jobs_title_len");
    expect(warnings.join("\n")).toContain("cvs_size_range");
    expect(warnings.join("\n")).toContain("cvs_path_shape");

    const rows = await pg.admin<{ len: number }>("select char_length(title)::int as len from jobs where id = $1", [
      ids.jobKeepOversize,
    ]);
    expect(rows[0].len).toBe(OVERSIZE);
    const cv = await pg.admin<{ size: number; path: string }>("select size, path from cvs where id in ($1, $2) order by name", [
      ids.cvBigFile,
      ids.cvOddPath,
    ]);
    expect(cv.map((c) => Number(c.size))).toEqual([LIMITS.cvRecordMaxBytes + 1_000_000, 10]);
    expect(cv[1].path).toBe("old-style-path");
  });

  it("leaves exactly the broken rules unvalidated and keeps every other rule validated", async () => {
    const rows = await pg.admin<{ conname: string; convalidated: boolean }>(
      "select conname, convalidated from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c' order by conname",
    );
    const unvalidated = rows.filter((r) => !r.convalidated).map((r) => r.conname);
    expect(unvalidated).toEqual(["cvs_path_shape", "cvs_size_range", "jobs_title_len"]);
    expect(rows.length).toBe(
      TEXT_FIELDS.length + JSON_FIELDS.length + OTHER_CONSTRAINTS.length,
    );
  });

  it("still enforces the rules for NEW rows", async () => {
    const s = pg.asUser(ids.user);
    const err = await pgError(insertJob(s, { title: chars(LIMITS.job.title + 1) }));
    expect(err.constraint).toBe("jobs_title_len");

    const bigCv = await pgError(insertCv(s, ids.user, { size: LIMITS.cvRecordMaxBytes + 1 }));
    expect(bigCv.constraint).toBe("cvs_size_range");

    await insertJob(s, { title: chars(LIMITS.job.title) });
  });

  it("rejects an UPDATE of a legacy row that leaves it oversize", async () => {
    const s = pg.asUser(ids.user);

    // Even an edit to a different column is checked against the whole row.
    const status = await pgError(
      s.query("update jobs set status = 'applied' where id = $1", [ids.jobKeepOversize]),
    );
    expect(status.code).toBe(CHECK_VIOLATION);
    expect(status.constraint).toBe("jobs_title_len");

    // Trimming it, but not enough, is still refused.
    const stillTooLong = await pgError(
      s.query("update jobs set title = $1 where id = $2", [chars(LIMITS.job.title + 1), ids.jobKeepOversize]),
    );
    expect(stillTooLong.constraint).toBe("jobs_title_len");

    // Re-saving the untouched oversize row (what a sync upsert does) is refused as well.
    const resave = await pgError(
      upsertJobs(s, [{ id: ids.jobUpsertUntouched, user_id: ids.user, label: chars(OVERSIZE) }]),
    );
    expect(resave.constraint).toBe("jobs_title_len");

    // The rows are unchanged.
    const [row] = await pg.admin<{ len: number; status: string }>(
      "select char_length(title)::int as len, status from jobs where id = $1",
      [ids.jobKeepOversize],
    );
    expect(row).toEqual({ len: OVERSIZE, status: "interested" });
  });

  it("accepts an UPDATE that fixes a legacy row, and lets the user delete one", async () => {
    const s = pg.asUser(ids.user);

    await s.query("update jobs set title = $1 where id = $2", [chars(LIMITS.job.title), ids.jobFix]);
    await s.query("update jobs set status = 'applied' where id = $1", [ids.jobFix]); // later edits are fine

    const del = await s.run("delete from jobs where id = $1", [ids.jobDelete]);
    expect(del.affectedRows).toBe(1);

    // Rows that were never broken are not affected by the others being broken.
    await s.query("update jobs set status = 'applied' where id = $1", [ids.jobGood]);
  });

  it("does the same for legacy CV records (oversize file size, old-style path)", async () => {
    const s = pg.asUser(ids.user);

    const rename = await pgError(s.query("update cvs set name = 'renamed' where id = $1", [ids.cvBigFile]));
    expect(rename.constraint).toBe("cvs_size_range");
    const odd = await pgError(s.query("update cvs set name = 'renamed' where id = $1", [ids.cvOddPath]));
    expect(odd.constraint).toBe("cvs_path_shape");

    await s.query("update cvs set size = $1 where id = $2", [LIMITS.cvRecordMaxBytes, ids.cvBigFile]);
    await s.query("update cvs set path = $1 where id = $2", [`${ids.user}/${ids.cvOddPath}`, ids.cvOddPath]);
    await s.query("update cvs set name = 'renamed' where id = $1", [ids.cvOddPath]);
  });

  it("an account already ABOVE the row caps keeps its rows, can edit them, cannot add, and gets back in once under", async () => {
    const s = pg.asUser(ids.crowded);
    const crowdedJobs = LIMITS.jobsPerUser + 5;
    expect(await count(s, "jobs")).toBe(crowdedJobs);

    // Cannot add...
    expect((await pgError(fillJobs(s, 1))).code).toBe(LIMIT_ERROR_CODE);
    // ...but can still edit and re-save what it has.
    const jobIds = await idsOf(s, "jobs");
    await upsertJobs(s, jobIds.slice(0, 20).map((id) => ({ id, user_id: ids.crowded, label: "resaved" })));
    await s.query("update jobs set status = 'applied'");

    // Deleting down to exactly the cap is not enough; one more slot is.
    await s.query("delete from jobs where id = any($1::uuid[])", [jobIds.slice(0, 5)]);
    expect((await pgError(fillJobs(s, 1))).code).toBe(LIMIT_ERROR_CODE);
    await s.query("delete from jobs where id = $1", [jobIds[5]]);
    await fillJobs(s, 1);
    expect((await pgError(fillJobs(s, 1))).code).toBe(LIMIT_ERROR_CODE);

    const crowdedCvs = LIMITS.cvsPerUser + 2;
    expect(await count(s, "cvs")).toBe(crowdedCvs);
    expect((await pgError(fillCvs(s, 1))).code).toBe(LIMIT_ERROR_CODE);
    const cvIds = await idsOf(s, "cvs");
    await upsertCvs(s, cvIds.map((id) => ({ id, user_id: ids.crowded, label: "resaved" })));
  });

  it("tells the owner which accounts are already over a cap (a notice per cap, naming the limit)", () => {
    const heads = noticesAbout(notices).filter((n) => !n.includes("break the rule"));
    const crowdedText = heads.filter((n) => n.includes(ids.crowded)).join("\n");
    expect(crowdedText).toContain(`limit ${LIMITS.jobsPerUser})`);
    expect(crowdedText).toContain(`limit ${LIMITS.cvsPerUser})`);
    expect(crowdedText).toContain(`limit ${LIMITS.cvFilesPerUser})`);
    // The account that is within every cap is not mentioned.
    expect(heads.some((n) => n.includes(ids.user))).toBe(false);
  });

  it("an account already above the FILE cap can replace and delete files but not add new ones", async () => {
    const s = pg.asUser(ids.crowded);
    const folder = ids.crowded;
    const files = LIMITS.cvFilesPerUser + 5;
    expect(await count(s, "storage.objects")).toBe(files);

    const put = (path: string) =>
      s.query("insert into storage.objects (bucket_id, name, owner) values ('cvs', $1, auth.uid())", [path]);

    // A record that has no file yet: its first file is a NEW file, and the account is over the cap.
    const [{ path: unbacked }] = await pg.admin<{ path: string }>(
      `select path from cvs c where user_id = $1
          and not exists (select 1 from storage.objects o where o.bucket_id = 'cvs' and o.name = c.path) limit 1`,
      [ids.crowded],
    );
    expect((await pgError(put(unbacked))).code).toBe(RLS_DENIED);

    // Replacing a file that already has a record works.
    const [{ path: backed }] = await pg.admin<{ path: string }>(
      `select path from cvs c where user_id = $1
          and exists (select 1 from storage.objects o where o.bucket_id = 'cvs' and o.name = c.path) limit 1`,
      [ids.crowded],
    );
    const replace = await s.run(
      `insert into storage.objects (bucket_id, name, owner, metadata)
       values ('cvs', $1, auth.uid(), '{"size": 7}')
       on conflict (bucket_id, name) do update set metadata = excluded.metadata`,
      [backed],
    );
    expect(replace.affectedRows).toBe(1);

    // Deleting 5 stray files brings it to exactly the cap: still full. One more leaves room for one.
    await s.query("delete from storage.objects where name = any($1::text[])", [
      Array.from({ length: 5 }, (_, i) => `${folder}/f${i + 1}`),
    ]);
    expect(await count(s, "storage.objects")).toBe(LIMITS.cvFilesPerUser);
    expect((await pgError(put(unbacked))).code).toBe(RLS_DENIED);
    await s.query("delete from storage.objects where name = $1", [`${folder}/f6`]);
    await put(unbacked);
  });

  it("applied the bucket limits to the bucket that already existed", async () => {
    const [bucket] = await pg.admin<{ file_size_limit: number; allowed_mime_types: string[] }>(
      "select file_size_limit, allowed_mime_types from storage.buckets where id = 'cvs'",
    );
    expect(Number(bucket.file_size_limit)).toBe(LIMITS.cvFileBytes);
    expect([...bucket.allowed_mime_types].sort()).toEqual([...CV_ALLOWED_MIME_TYPES].sort());
  });
});

describe("legacy data: re-running 003 after the old rows were fixed", () => {
  let pg: PgHarness;
  let userId: string;
  let jobId: string;
  const cvId = randomUUID();

  const convalidated = async () =>
    Object.fromEntries(
      (
        await pg.admin<{ conname: string; convalidated: boolean }>(
          "select conname, convalidated from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c'",
        )
      ).map((r) => [r.conname, r.convalidated]),
    );

  beforeAll(async () => {
    pg = await PgHarness.createMigrated(["001_init.sql", "002_ai_and_rate_limits.sql"]);
    userId = await pg.createUser();
    jobId = (
      await pg.admin<{ id: string }>(
        "insert into jobs (user_id, title, notes) values ($1, $2, $3) returning id",
        [userId, chars(LIMITS.job.title + 1), chars(LIMITS.job.notes + 1)],
      )
    )[0].id;
    await pg.admin("insert into cvs (id, user_id, size, path) values ($1, $2, -5, 'elsewhere')", [cvId, userId]);
  }, 60_000);
  afterAll(() => pg.close());

  it("keeps the broken rules unvalidated while rows still break them, then validates them once the rows are fixed", async () => {
    // First run: four rules cannot be validated yet (title, notes, size, path).
    const first = noticesAbout(await pg.applyMigration("003_limits.sql"));
    expect(first).toHaveLength(4);
    let state = await convalidated();
    expect(state.jobs_title_len).toBe(false);
    expect(state.jobs_notes_len).toBe(false);
    expect(state.cvs_size_range).toBe(false);
    expect(state.cvs_path_shape).toBe(false);
    expect(state.jobs_company_len).toBe(true);

    // Running it again while the data is still bad changes nothing and does not fail.
    const again = noticesAbout(await pg.applyMigration("003_limits.sql"));
    expect(again).toHaveLength(4);
    expect(await convalidated()).toEqual(state);

    // A legacy row has to be fixed in EVERY broken field at once: fixing only the title
    // is refused, because the row still breaks the notes rule.
    const partial = await pgError(
      pg.admin("update jobs set title = 'ok' where id = $1", [jobId]),
    );
    expect(partial.constraint).toBe("jobs_notes_len");
    expect((await convalidated()).jobs_title_len).toBe(false);

    await pg.admin("update jobs set title = 'ok', notes = 'ok' where id = $1", [jobId]);
    await pg.admin("update cvs set size = 100, path = $2 where id = $1", [cvId, `${userId}/${cvId}`]);

    const last = noticesAbout(await pg.applyMigration("003_limits.sql"));
    expect(last).toEqual([]);
    state = await convalidated();
    expect(Object.values(state).every((v) => v === true)).toBe(true);
    expect(Object.keys(state)).toHaveLength(
      TEXT_FIELDS.length + JSON_FIELDS.length + OTHER_CONSTRAINTS.length,
    );
  });
});
