// lib/server/limitsIntegration.test.ts
// Do the app's guards and the database AGREE?
//
// lib/limitGuards.ts (what the browser sends) and supabase/migrations/003_limits.sql
// (what the database accepts) are written by hand, in two languages, and kept in step
// by hand. Each has its own tests, but nothing else proves they fit together. This file
// does: it runs the real migrations (001, 002, 003) on a real Postgres (PGlite) and puts
// the app's real sync code on the other end of the wire.
//
// What is real here, and what is a model:
//   - REAL: the SQL (every constraint, trigger and policy), the app's clampJobForCloud /
//     toRow / upsertRemoteJobs / fetchRemoteJobs / uploadRemoteCv / describeLimitError,
//     and the error objects Postgres raises.
//   - MODEL: the transport. A tiny stand-in for the Supabase client sends rows the way
//     PostgREST does (ONE `INSERT ... SELECT FROM json_populate_recordset(...) ON CONFLICT
//     DO UPDATE` statement for a whole batch, so one bad row sinks the lot) and applies
//     the Storage service's two checks (file size, declared file type) from the bucket row
//     in the database. The real PostgREST and Storage services are not run, so anything
//     they do on top of this (for example how PostgREST reads a lone surrogate in a JSON
//     body) is not covered here.
//
// Three kinds of test:
//   1. "the client's rows are accepted": many adversarial jobs (fixed seeds) through the
//      app's guards must always be accepted, and an honest value must never be changed.
//   2. "the DB is the authority": the same kind of data WITHOUT the guards is refused,
//      exactly when Postgres' own measurement says it is too big.
//   3. "the errors are understood": the errors Postgres really raises are turned into
//      the right sentence by describeLimitError.

import { PostgrestError, StorageApiError } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cvStoragePath, deleteRemoteCv, uploadRemoteCv } from "@/lib/cvsRemote";
import { CV_ROLES } from "@/lib/cvs";
import type { Job } from "@/lib/jobs";
import { fetchRemoteJobs, toRow, upsertRemoteJobs } from "@/lib/jobsRemote";
import {
  canonicalCvMime,
  clampJobForCloud,
  describeLimitError,
  isCvUploadable,
} from "@/lib/limitGuards";
import {
  CV_ALLOWED_MIME_TYPES,
  CV_MIME_BY_EXTENSION,
  LIMIT_ERROR_CODE,
  LIMITS,
} from "@/lib/limits";
import { PgHarness, type Row, type Session } from "./testing/pgHarness";

// A real database is slow to start and some batches are large.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The app's sync code reads its Supabase client from "@/lib/supabase"; hand it the model
// of Supabase built below instead of a network client.
const wiring = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase", () => ({
  get supabase() {
    return wiring.client;
  },
  syncEnabled: true,
  getAccessToken: async () => null,
}));

const CLIENT_JSON_MARGIN = 0.8; // the client keeps JSON under 80% of the database cap
const ISO = "2026-10-01T00:00:00.000Z";
const J = LIMITS.job;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Characters the way Postgres counts them: code points, not UTF-16 units. */
const cpLen = (s: string) => Array.from(s).length;

// ===========================================================================
// The model of Supabase between the app's code and the database
// ===========================================================================

type RawPgError = { code?: string; message: string; detail?: string; hint?: string; constraint?: string };

/** What supabase-js hands back when PostgREST relays a Postgres error. */
function asPostgrestError(err: unknown): PostgrestError {
  const e = err as RawPgError;
  return new PostgrestError({
    message: e.message,
    details: e.detail ?? "",
    hint: e.hint ?? "",
    code: e.code ?? "",
  });
}

/** Await something that must fail, and return the raw error the database raised. */
async function failureOf(pending: Promise<unknown>): Promise<RawPgError> {
  try {
    await pending;
  } catch (err) {
    return err as RawPgError;
  }
  throw new Error("Expected the database to refuse this, but it accepted it.");
}

/** The statement PostgREST runs for an upsert: the whole batch is ONE statement. */
function upsertStatement(table: "jobs" | "cvs", rows: Row[]) {
  // supabase-js lists the union of the rows' keys; a key a row lacks becomes NULL.
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const list = cols.map((c) => `"${c}"`).join(", ");
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => `"${c}" = excluded."${c}"`)
    .join(", ");
  return {
    sql:
      `insert into public.${table} (${list}) ` +
      `select ${list} from json_populate_recordset(null::public.${table}, $1::json) ` +
      `on conflict (id) do update set ${updates}`,
    params: [JSON.stringify(rows)],
  };
}

function wireUpsert(s: Session, table: "jobs" | "cvs", rows: Row[]) {
  const { sql, params } = upsertStatement(table, rows);
  return s.run(sql, params);
}

/**
 * Every row of a table, the way PostgREST returns them: ONE JSON document. (Reading
 * columns straight out of PGlite is not the same thing: PGlite's text decoder drops a
 * byte-order mark at the very start of a column value, which real PostgREST never does
 * to text inside a JSON body. Going through JSON keeps this model honest.)
 */
async function selectAllAsJson(s: Session, table: "jobs" | "cvs"): Promise<Row[]> {
  const [res] = await s.query<{ data: Row[] }>(
    `select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) as data from public.${table} t`,
  );
  return res.data;
}

/** A row without its updated_at, which is stamped with the current time on every conversion. */
const withoutStamp = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== "updated_at"));

/** Just enough of the Supabase client for lib/jobsRemote.ts and lib/cvsRemote.ts. */
function fakeSupabase(pg: PgHarness, userId: string) {
  const s = pg.asUser(userId);
  const failed = (e: unknown) => ({ data: null, error: asPostgrestError(e) });

  /** The Storage service's own checks, read from the bucket row; then the insert it
   *  makes (under the caller's row-level security) into storage.objects. */
  async function upload(path: string, body: Blob, options?: { upsert?: boolean }) {
    const [bucket] = await pg.admin<{ file_size_limit: unknown; allowed_mime_types: string[] | null }>(
      "select file_size_limit, allowed_mime_types from storage.buckets where id = 'cvs'",
    );
    if (bucket.file_size_limit != null && body.size > Number(bucket.file_size_limit)) {
      return { data: null, error: new StorageApiError("The object exceeded the maximum allowed size", 413, "413") };
    }
    // For a Blob, supabase-js sends the Blob's OWN type (the `contentType` option is ignored).
    const mime = body.type || "application/octet-stream";
    if (bucket.allowed_mime_types && !bucket.allowed_mime_types.includes(mime)) {
      return { data: null, error: new StorageApiError(`mime type ${mime} is not supported`, 415, "415") };
    }
    try {
      await s.run(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('cvs', $1, auth.uid(), $2::jsonb)` +
          (options?.upsert
            ? ` on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now()`
            : ""),
        [path, JSON.stringify({ size: body.size, mimetype: mime })],
      );
    } catch (e) {
      return { data: null, error: new StorageApiError((e as Error).message, 403, "403") };
    }
    return { data: { path }, error: null };
  }

  return {
    from(table: "jobs" | "cvs") {
      return {
        upsert: async (rows: Row | Row[]) => {
          try {
            await wireUpsert(s, table, Array.isArray(rows) ? rows : [rows]);
            return { error: null };
          } catch (e) {
            return { error: asPostgrestError(e) };
          }
        },
        // Awaitable on its own (read everything), or chained as
        // select(...).eq(column, value).maybeSingle() (does this record exist?).
        select: () => {
          const all = async () => {
            try {
              return { data: await selectAllAsJson(s, table), error: null };
            } catch (e) {
              return failed(e);
            }
          };
          return {
            then: (resolve: (v: Awaited<ReturnType<typeof all>>) => unknown, reject?: (e: unknown) => unknown) =>
              all().then(resolve, reject),
            eq: (column: string, value: unknown) => ({
              maybeSingle: async () => {
                const res = await all();
                if (res.error) return res;
                const rows = (res.data as Row[]).filter((r) => r[column] === value);
                return { data: rows[0] ?? null, error: null };
              },
            }),
          };
        },
        delete: () => ({
          eq: async (column: string, value: unknown) => {
            try {
              await s.run(`delete from public.${table} where ${column} = $1`, [value]);
              return { error: null };
            } catch (e) {
              return { error: asPostgrestError(e) };
            }
          },
        }),
      };
    },
    storage: {
      // The bucket name is accepted but ignored: this model has only the CV bucket.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      from: (_bucket: string) => ({
        upload,
        remove: async (paths: string[]) => {
          await s.run("delete from storage.objects where bucket_id = 'cvs' and name = any($1::text[])", [paths]);
          return { data: null, error: null };
        },
      }),
    },
  };
}

// ===========================================================================
// Deterministic data (no Math.random anywhere in the data)
// ===========================================================================

function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof makeRng>;

/** Each entry is exactly ONE code point (so n picks are exactly n Postgres characters). */
const CODE_POINTS: readonly string[] = [
  "a", "b", "Z", "0", "9", " ", "-", "_", ".", "/", ":", "@",
  "é", "ñ", "ü", "ß", "日", "本", "한", "я",
  "م", "ع", "ر", "ب", "َ", // Arabic letters and a combining vowel mark
  "\u0301", "\u0308", "\u200d", "\u200b", // combining accents, joiner, zero-width space
  "😀", "🔥", "👨", "👩", "🇦", // astral: 2 UTF-16 units each
  "𝒜", "𠀀", "\u{1F3FD}", // astral: math letter, rare CJK, skin-tone modifier
  "\u2028", "\u2029", "\ufeff", "\u00a0",
  "\"", "\\", "\n", "\r", "\t", "'", "<", ">", "&", "%",
  "\u0001", "\u001f", "\u007f", // control characters that are legal in Postgres text
];

function randomText(rng: Rng, codePoints: number): string {
  const out: string[] = new Array(Math.max(0, codePoints));
  for (let i = 0; i < out.length; i++) out[i] = rng.pick(CODE_POINTS);
  return out.join("");
}

function randomUuid(rng: Rng): string {
  const hex = (n: number) => Array.from({ length: n }, () => rng.int(0, 15).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${rng.pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
}

/** Ids for hand-written data. Row ids are unique across the whole database, so every
 *  caller takes its own scope. */
let scopeCounter = 0;
const newScope = () => ++scopeCounter;
const idFor = (scope: number, i: number) =>
  `00000000-0000-4000-8000-${scope.toString(16).padStart(6, "0")}${i.toString(16).padStart(6, "0")}`;

const MALFORMED: readonly unknown[] = [
  undefined, null, 0, 42, -1, NaN, true, false, {}, [], ["x"], { a: 1 },
];

/** Ways to make a text value for a field whose limit is `max` characters. */
const TEXT_MODES: Record<string, (rng: Rng, max: number) => unknown> = {
  "empty": () => "",
  "short": (rng) => randomText(rng, rng.int(1, 40)),
  "ascii-exact": (_rng, max) => "a".repeat(max),
  "ascii-one-over": (_rng, max) => "a".repeat(max + 1),
  "mixed-exact": (rng, max) => randomText(rng, max),
  "mixed-one-under": (rng, max) => randomText(rng, max - 1),
  "mixed-one-over": (rng, max) => randomText(rng, max + 1),
  "mixed-far-over": (rng, max) => randomText(rng, max * rng.int(2, 3)),
  "arabic-exact": (_rng, max) => "م".repeat(max),
  "arabic-over": (rng, max) => "م".repeat(max + rng.int(1, 50)),
  "emoji-exact": (_rng, max) => "😀".repeat(max), // max characters, 2*max UTF-16 units
  // An emoji whose two halves sit on either side of the cut.
  "emoji-on-the-cut": (rng, max) => "a".repeat(Math.max(0, max - rng.int(1, 3))) + "😀😀😀" + "tail",
  "combining": (_rng, max) => "e\u0301".repeat(Math.floor(max / 2) + 2),
  "zwj-family": (_rng, max) => "👨\u200d👩\u200d👧".repeat(Math.ceil((max + 1) / 5)),
  "json-special": (rng, max) =>
    Array.from({ length: max + rng.int(0, 5) }, () => rng.pick(['"', "\\", "\n", "\r", "\t", "/", " ", "\u2028"])).join(""),
  "astral-mix": (rng, max) =>
    Array.from({ length: max + rng.int(0, 3) }, () => rng.pick(["𝒜", "𠀀", "😀", "🇦"])).join(""),
  "malformed": (rng) => rng.pick(MALFORMED),
};
const TEXT_MODE_NAMES = Object.keys(TEXT_MODES);
/** The modes that stay within the limit as Postgres counts it (used to mix honest and
 *  oversize values in the tests that need some rows to be accepted). */
const CALM_TEXT_MODE_NAMES = [
  "empty", "short", "ascii-exact", "mixed-exact", "mixed-one-under", "arabic-exact",
  "emoji-exact", "combining", "malformed",
];

const STATUS_IDS = ["interested", "applied", "interview", "offer", "rejected"];

const contactOf = (i: number): Record<string, unknown> => ({
  type: i % 3 === 0 ? "phone" : "email",
  value: i % 3 === 0 ? `+1555000${String(i % 10000).padStart(4, "0")}` : `person${i}@example.test`,
  name: i % 4 === 0 ? "" : `Person ${i}`,
  role: ["", "Recruiter", "Hiring manager"][i % 3],
});

type Generated = { job: Job; modes: string[] };

/** The shape of a saved fit analysis, with `extra` merged over it. */
const analysisWith = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  fit_score: 72,
  verdict: "A decent fit.",
  strengths: [{ point: "p", job_requirement: "r", cv_evidence: "e" }],
  gaps: [],
  tailored_bullets: [],
  outreach: { email_subject: "s", email_body: "b", whatsapp_message: "w" },
  generated_at: ISO,
  cv_id: "cv1",
  cv_name: "CV.pdf",
  model: "test-model",
  removed_unverified: 0,
  confidence: "high",
  ...extra,
});

const ENVELOPE_CHARS = JSON.stringify(analysisWith({ verdict: "" })).length;

const CONTACT_MODES = [
  "absent", "null", "not-an-array", "empty", "honest", "many-tiny", "many-ordinary",
  "long-values", "multibyte", "junk-entries", "extra-fields",
];
const CALM_CONTACT_MODES = ["absent", "null", "not-an-array", "empty", "honest"];

function genContacts(rng: Rng, calm: number): { value: unknown; mode: string } {
  const mode = rng.pick(rng.chance(calm) ? CALM_CONTACT_MODES : CONTACT_MODES);
  const list = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
  switch (mode) {
    case "absent":
      return { value: undefined, mode };
    case "null":
      return { value: null, mode };
    case "not-an-array":
      return { value: rng.pick([{ type: "email" }, "a@b.co", 7, true]), mode };
    case "empty":
      return { value: [], mode };
    case "honest":
      return { value: list(rng.int(1, 5), contactOf), mode };
    case "many-tiny":
      return { value: list(rng.int(200, 2000), () => ({ type: "email", value: "a@b.co", name: "", role: "" })), mode };
    case "many-ordinary":
      return { value: list(rng.int(30, 400), contactOf), mode };
    case "long-values":
      return {
        value: list(rng.int(2, 6), (i) => ({ ...contactOf(i), value: randomText(rng, rng.int(100, 6000)) })),
        mode,
      };
    case "multibyte":
      return {
        value: list(rng.int(5, 200), (i) => ({
          ...contactOf(i),
          name: "م".repeat(rng.int(1, 40)),
          role: "😀".repeat(rng.int(1, 10)),
        })),
        mode,
      };
    case "junk-entries":
      return {
        value: list(rng.int(20, 300), (i) =>
          i % 4 === 0
            ? rng.pick([null, 5, "x", [], {}, { type: "fax", value: "1" }, { type: "email" }, { type: "email", value: 5 }])
            : contactOf(i),
        ),
        mode,
      };
    default:
      return {
        value: list(rng.int(10, 300), (i) => ({
          ...contactOf(i),
          meta: { a: [1, 2, 3], b: { c: "d" } },
          tags: ["x", "y"],
        })),
        mode,
      };
  }
}

const ANALYSIS_MODES = [
  "absent", "null", "not-a-record", "honest", "medium", "near-margin", "over-margin", "huge",
  "many-strengths", "digits", "nested", "escapes", "multibyte",
];
const CALM_ANALYSIS_MODES = ["absent", "null", "not-a-record", "honest", "medium"];

function genAnalysis(rng: Rng, calm: number): { value: unknown; mode: string } {
  const mode = rng.pick(rng.chance(calm) ? CALM_ANALYSIS_MODES : ANALYSIS_MODES);
  const margin = Math.floor(J.analysisJson * CLIENT_JSON_MARGIN);
  switch (mode) {
    case "absent":
      return { value: undefined, mode };
    case "null":
      return { value: null, mode };
    case "not-a-record":
      return { value: rng.pick([[], "analysis", 5, true]), mode };
    case "honest":
      return { value: analysisWith({ verdict: randomText(rng, rng.int(20, 2000)) }), mode };
    case "medium":
      return { value: analysisWith({ verdict: randomText(rng, rng.int(5000, 12000)) }), mode };
    case "near-margin":
      return { value: analysisWith({ verdict: "v".repeat(margin - ENVELOPE_CHARS + rng.int(-300, 300)) }), mode };
    case "over-margin":
      return { value: analysisWith({ verdict: "v".repeat(margin + rng.int(1000, 20000)) }), mode };
    case "huge":
      return { value: analysisWith({ verdict: "v".repeat(400_000) }), mode };
    case "many-strengths":
      return {
        value: analysisWith({
          strengths: Array.from({ length: rng.int(5, 400) }, (_, i) => ({
            point: `point ${i}`,
            job_requirement: "requirement",
            cv_evidence: "evidence",
          })),
        }),
        mode,
      };
    case "digits":
      // Postgres prints a space after every comma, so a list of digits is its worst case.
      return { value: analysisWith({ scores: new Array<number>(rng.int(1000, 20000)).fill(1) }), mode };
    case "nested":
      return {
        value: analysisWith({
          grid: Array.from({ length: rng.int(100, 4000) }, () => [[1, 1], { a: 1 }]),
        }),
        mode,
      };
    case "escapes":
      return { value: analysisWith({ verdict: '"\\\n'.repeat(rng.int(100, 12000)) }), mode };
    default:
      return { value: analysisWith({ verdict: "😀".repeat(rng.int(100, 20000)) }), mode };
  }
}

/** `calm` = the chance (0..1) that each field is drawn from the well-behaved modes only. */
function genJob(rng: Rng, taken: Set<string>, calm = 0): Generated {
  const modes: string[] = [];
  const text = (field: string, max: number): unknown => {
    const mode = rng.pick(rng.chance(calm) ? CALM_TEXT_MODE_NAMES : TEXT_MODE_NAMES);
    modes.push(`${field}:${mode}`);
    return TEXT_MODES[mode](rng, max);
  };
  let id = randomUuid(rng);
  while (taken.has(id)) id = randomUuid(rng);
  taken.add(id);

  const raw: Record<string, unknown> = {
    id,
    title: text("title", J.title),
    company: text("company", J.company),
    country: text("country", J.country),
    url: text("url", J.url),
    salary: text("salary", J.salary),
    status: rng.chance(0.5) ? rng.pick(STATUS_IDS) : text("status", J.status),
    notes: text("notes", J.notes),
    dateAdded: ISO,
  };
  if (rng.chance(0.7)) raw.deadline = text("deadline", J.date);
  if (rng.chance(0.7)) raw.followUpDate = text("followUpDate", J.date);
  if (rng.chance(0.7)) raw.cvId = text("cvId", J.cvId);
  const contacts = genContacts(rng, calm);
  modes.push(`contacts:${contacts.mode}`);
  if (contacts.value !== undefined) raw.contacts = contacts.value;
  const analysis = genAnalysis(rng, calm);
  modes.push(`analysis:${analysis.mode}`);
  if (analysis.value !== undefined) raw.analysis = analysis.value;
  return { job: raw as unknown as Job, modes };
}

function genBatch(seed: number, size: number, calm = 0): Generated[] {
  const rng = makeRng(seed);
  const taken = new Set<string>();
  return Array.from({ length: size }, () => genJob(rng, taken, calm));
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
const BATCH = 25;

/** An ordinary, well-behaved job. */
const honestJob = (scope: number, i: number, over: Record<string, unknown> = {}): Job =>
  ({
    id: idFor(scope, i),
    title: `Product Manager ${i}`,
    company: "Acme Example",
    country: "Australia",
    url: `https://example.test/jobs/${i}`,
    salary: "A$150k",
    status: "applied",
    notes: "Call back on Monday.",
    dateAdded: ISO,
    ...over,
  }) as Job;

// ===========================================================================
// The map between lib/limits.ts and the SQL (so a new constraint cannot be missed)
// ===========================================================================

type TextColumn = {
  limitKey: string;
  field: string; // the Job field
  column: string;
  max: number;
  constraint: string;
  /** A word the friendly message must contain to be about this field. */
  word: string;
  optional: boolean;
};

const JOB_TEXT: TextColumn[] = [
  { limitKey: "job.title", field: "title", column: "title", max: J.title, constraint: "jobs_title_len", word: "title", optional: false },
  { limitKey: "job.company", field: "company", column: "company", max: J.company, constraint: "jobs_company_len", word: "company", optional: false },
  { limitKey: "job.country", field: "country", column: "country", max: J.country, constraint: "jobs_country_len", word: "country", optional: false },
  { limitKey: "job.url", field: "url", column: "url", max: J.url, constraint: "jobs_url_len", word: "link", optional: false },
  { limitKey: "job.salary", field: "salary", column: "salary", max: J.salary, constraint: "jobs_salary_len", word: "salary", optional: false },
  { limitKey: "job.status", field: "status", column: "status", max: J.status, constraint: "jobs_status_len", word: "status", optional: false },
  { limitKey: "job.notes", field: "notes", column: "notes", max: J.notes, constraint: "jobs_notes_len", word: "notes", optional: false },
  { limitKey: "job.date", field: "deadline", column: "deadline", max: J.date, constraint: "jobs_deadline_len", word: "deadline", optional: true },
  { limitKey: "job.date", field: "followUpDate", column: "follow_up_date", max: J.date, constraint: "jobs_follow_up_len", word: "follow-up", optional: true },
  { limitKey: "job.cvId", field: "cvId", column: "cv_id", max: J.cvId, constraint: "jobs_cv_id_len", word: "CV", optional: true },
];

const JOB_JSON = [
  { limitKey: "job.contactsJson", column: "contacts", max: J.contactsJson, constraint: "jobs_contacts_size", word: "contacts" },
  { limitKey: "job.analysisJson", column: "analysis", max: J.analysisJson, constraint: "jobs_analysis_size", word: "analysis" },
] as const;

const CV_TEXT = [
  { limitKey: "cv.name", column: "name", max: LIMITS.cv.name, constraint: "cvs_name_len", word: "name" },
  { limitKey: "cv.role", column: "role", max: LIMITS.cv.role, constraint: "cvs_role_len", word: "role" },
  { limitKey: "cv.type", column: "type", max: LIMITS.cv.type, constraint: "cvs_type_len", word: "type" },
] as const;

// ===========================================================================
// Everything below talks to one database with all three migrations applied.
// Each test takes brand-new accounts, so tests do not affect each other.
// ===========================================================================

let pg: PgHarness;
let emailCounter = 0;

beforeAll(async () => {
  pg = await PgHarness.createMigrated();
}, 120_000);
afterAll(() => pg.close());

type Account = { id: string; s: Session };

/** A new account; the app's sync code now talks to the database as this account. */
async function newAccount(): Promise<Account> {
  const id = await pg.createUser(`person-${++emailCounter}@example.test`);
  const account = { id, s: pg.asUser(id) };
  actAs(account);
  return account;
}
const actAs = (a: Account) => {
  wiring.client = fakeSupabase(pg, a.id);
};

const countOf = async (s: Session, table: string) =>
  (await s.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0].n;

/** How long Postgres prints this value as jsonb text, which is what the caps measure. */
async function dbJsonLength(value: unknown): Promise<number> {
  const rows = await pg.admin<{ n: number }>("select char_length($1::jsonb::text)::int as n", [
    JSON.stringify(value),
  ]);
  return rows[0].n;
}

/** Largest n in [0, hi] for which `size(n) <= max` (size must grow with n). */
async function largestN(size: (n: number) => number | Promise<number>, max: number, hi = 40_000): Promise<number> {
  let lo = 0;
  let top = hi;
  while (lo < top) {
    const mid = Math.ceil((lo + top) / 2);
    if ((await size(mid)) <= max) lo = mid;
    else top = mid - 1;
  }
  return lo;
}

// ===========================================================================
// 0) The test's own map is complete
// ===========================================================================

describe("this file knows every limit the migration defines", () => {
  it("covers every entry of LIMITS.job and LIMITS.cv", () => {
    const covered = new Set([...JOB_TEXT, ...JOB_JSON, ...CV_TEXT].map((c) => c.limitKey));
    const declared = [
      ...Object.keys(LIMITS.job).map((k) => `job.${k}`),
      ...Object.keys(LIMITS.cv).map((k) => `cv.${k}`),
    ];
    expect([...covered].sort()).toEqual(declared.sort());
  });

  it("covers every CHECK constraint in the migrated database", async () => {
    const rows = await pg.admin<{ conname: string }>(
      "select conname from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c' order by conname",
    );
    const known = [
      ...JOB_TEXT.map((c) => c.constraint),
      ...JOB_JSON.map((c) => c.constraint),
      ...CV_TEXT.map((c) => c.constraint),
      "cvs_size_range",
      "cvs_path_shape",
    ].sort();
    expect(rows.map((r) => r.conname)).toEqual(known);
  });

  it("the generator is deterministic and its building blocks are what they claim", () => {
    expect(JSON.stringify(genBatch(7, 10))).toBe(JSON.stringify(genBatch(7, 10)));
    expect(JSON.stringify(genBatch(7, 10))).not.toBe(JSON.stringify(genBatch(8, 10)));
    for (const cp of CODE_POINTS) expect(cpLen(cp), JSON.stringify(cp)).toBe(1);
    const rng = makeRng(99);
    expect(cpLen(randomText(rng, 777))).toBe(777);
    expect(cpLen(TEXT_MODES["emoji-exact"](rng, 50) as string)).toBe(50);
  });

  it("the seeds really do reach the edges (so the property tests below are not vacuous)", () => {
    const stats = {
      fields: 0,
      overTheLimit: 0,
      exactlyAtTheLimit: 0,
      notStrings: 0,
      astralOverUtf16Limit: 0,
      contactsTrimmed: 0,
      contactsKeptWhole: 0,
      analysisDropped: 0,
      analysisKept: 0,
    };
    for (const seed of SEEDS) {
      for (const { job } of genBatch(seed, BATCH)) {
        const j = job as unknown as Record<string, unknown>;
        for (const c of JOB_TEXT) {
          const v = j[c.field];
          if (v === undefined) continue;
          stats.fields++;
          if (typeof v !== "string") stats.notStrings++;
          else {
            if (cpLen(v) > c.max) stats.overTheLimit++;
            if (cpLen(v) === c.max) stats.exactlyAtTheLimit++;
            if (cpLen(v) <= c.max && v.length > c.max) stats.astralOverUtf16Limit++;
          }
        }
        const clamped = clampJobForCloud(job);
        if (Array.isArray(j.contacts) && j.contacts.length > 0) {
          if ((clamped.contacts?.length ?? 0) < j.contacts.length) stats.contactsTrimmed++;
          else stats.contactsKeptWhole++;
        }
        if (isRecord(j.analysis)) {
          if (clamped.analysis) stats.analysisKept++;
          else stats.analysisDropped++;
        }
      }
    }
    expect(stats.overTheLimit).toBeGreaterThan(300);
    expect(stats.exactlyAtTheLimit).toBeGreaterThan(40);
    expect(stats.notStrings).toBeGreaterThan(80);
    expect(stats.astralOverUtf16Limit).toBeGreaterThan(20);
    expect(stats.contactsTrimmed).toBeGreaterThan(20);
    expect(stats.contactsKeptWhole).toBeGreaterThan(20);
    expect(stats.analysisDropped).toBeGreaterThan(20);
    expect(stats.analysisKept).toBeGreaterThan(20);
  });
});

// ===========================================================================
// 1) What the client sends, the database accepts
// ===========================================================================

/** What should have been stored for one text field. Empty list = fine. */
function textProblems(name: string, raw: unknown, max: number, stored: unknown, optional: boolean): string[] {
  if (typeof raw !== "string") {
    const want = optional ? undefined : "";
    return stored === want ? [] : [`${name}: a non-string should become ${JSON.stringify(want)}, got ${JSON.stringify(stored)?.slice(0, 40)}`];
  }
  if (typeof stored !== "string") return [`${name}: nothing was stored`];
  // Fits by JavaScript's count (which is never smaller than Postgres'): must be untouched.
  if (raw.length <= max) return stored === raw ? [] : [`${name}: an honest value was changed`];
  const problems: string[] = [];
  if (!raw.startsWith(stored)) problems.push(`${name}: the stored text is not the start of the original`);
  if (cpLen(stored) > max) problems.push(`${name}: stored ${cpLen(stored)} characters, over ${max}`);
  // Cutting by UTF-16 units may lose one unit (an emoji half), never more.
  if (stored.length < max - 1) problems.push(`${name}: cut to ${stored.length}, far below ${max}`);
  return problems;
}

/** Contacts the app is expected to keep: the well-formed entries, in order. */
function wellFormedContacts(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => isRecord(e) && (e.type === "email" || e.type === "phone") && typeof e.value === "string")
    .map((e) => ({
      ...(e as Record<string, unknown>),
      name: typeof (e as Record<string, unknown>).name === "string" ? (e as Record<string, unknown>).name : "",
      role: typeof (e as Record<string, unknown>).role === "string" ? (e as Record<string, unknown>).role : "",
    }));
}

/** Postgres prints jsonb at most 1.5 times longer than JSON.stringify (a space after
 *  each comma and colon, and there are never more of those than half the characters). */
const COMFORTABLE = (cap: number) => Math.floor(cap / 1.5);

/** The same value with every object's keys in alphabetical order. jsonb does not keep
 *  the order keys were written in, so two copies of the same JSON can only be compared
 *  after both are put in one order. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function checkStored(g: Generated, stored: Job | undefined): string[] {
  if (!stored) return ["the job was not stored at all"];
  const raw = g.job as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const c of JOB_TEXT) {
    const got = (stored as unknown as Record<string, unknown>)[c.field];
    out.push(...textProblems(c.field, raw[c.field], c.max, got, c.optional));
  }

  // Contacts: always a prefix of the well-formed entries; nothing lost when they are small.
  const wanted = wellFormedContacts(raw.contacts);
  const gotContacts = stored.contacts ?? [];
  if (!sameJson(gotContacts, wanted.slice(0, gotContacts.length))) {
    out.push("contacts: what was stored is not the start of the well-formed originals");
  }
  if (JSON.stringify(wanted).length <= COMFORTABLE(J.contactsJson) && gotContacts.length !== wanted.length) {
    out.push(`contacts: ${wanted.length} small contacts were sent as ${gotContacts.length}`);
  }

  // Analysis: kept whole or left out, never cut; always kept when comfortably small.
  if (isRecord(raw.analysis)) {
    const whole = sameJson(stored.analysis, raw.analysis);
    if (stored.analysis !== undefined && !whole) out.push("analysis: stored but changed");
    const size = JSON.stringify(raw.analysis).length;
    if (size <= Math.min(COMFORTABLE(J.analysisJson), J.analysisJson * CLIENT_JSON_MARGIN) && !whole) {
      out.push(`analysis: a small analysis (${size} characters of JSON) was dropped`);
    }
  } else if (stored.analysis !== undefined) {
    out.push("analysis: something that is not an analysis was stored");
  }
  return out;
}

/** Save one generated job on its own, to find out which job of a failed batch is guilty. */
async function culprits(gen: Generated[], userId: string): Promise<string[]> {
  const found: string[] = [];
  for (let i = 0; i < gen.length; i++) {
    try {
      await upsertRemoteJobs([gen[i].job], userId);
    } catch (e) {
      const err = e as RawPgError;
      found.push(`job #${i} [${gen[i].modes.join(", ")}] -> ${err.code} ${String(err.message).slice(0, 140)}`);
    }
  }
  return found;
}

describe("what the client sends, the database accepts (fixed seeds)", () => {
  it.each(SEEDS)(
    "seed %i: a batch of adversarial jobs is accepted, honest values survive, and reading them back and saving again changes nothing",
    async (seed) => {
      const { id, s } = await newAccount();
      const gen = genBatch(seed, BATCH);

      try {
        await upsertRemoteJobs(gen.map((g) => g.job), id);
      } catch (batchError) {
        const guilty = await culprits(gen, id);
        throw new Error(
          `The database refused a batch the client built (${(batchError as RawPgError).code}: ${String(
            (batchError as RawPgError).message,
          ).slice(0, 160)}).\n${guilty.join("\n") || "(no single job reproduces it)"}`,
        );
      }

      expect(await countOf(s, "jobs")).toBe(BATCH);

      // Read back through the app's own code and compare with what was meant to be stored.
      const stored = await fetchRemoteJobs();
      const byId = new Map(stored.map((j) => [j.id, j]));
      const problems = gen.flatMap((g, i) =>
        checkStored(g, byId.get(g.job.id)).map((p) => `job #${i} [${g.modes.join(", ")}]: ${p}`),
      );
      expect(problems).toEqual([]);

      // What the app reads back is what it will push on the next sync: that must be
      // accepted too, and must not change anything (clamping twice = clamping once).
      const before = await selectAllAsJson(s, "jobs");
      await upsertRemoteJobs(stored, id);
      const after = await selectAllAsJson(s, "jobs");
      const strip = (rows: Row[]) => rows.map(withoutStamp);
      expect(strip(after)).toEqual(strip(before));
    },
  );

  it("clamping already-clamped jobs gives the same rows (toRow is a fixed point)", () => {
    for (const seed of SEEDS) {
      for (const { job } of genBatch(seed, BATCH)) {
        const once = clampJobForCloud(job);
        expect(clampJobForCloud(once)).toEqual(once);
        const rowOnce = withoutStamp(toRow(job, "u"));
        const rowTwice = withoutStamp(toRow(once, "u"));
        expect(rowTwice).toEqual(rowOnce);
      }
    }
  });

  it("a batch of jobs sitting EXACTLY at every limit (several alphabets) is accepted and kept whole", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const margin = Math.floor(J.analysisJson * CLIENT_JSON_MARGIN);
    const full = (ch: string) => ({
      title: ch.repeat(J.title),
      company: ch.repeat(J.company),
      country: ch.repeat(J.country),
      url: ch.repeat(J.url),
      salary: ch.repeat(J.salary),
      status: ch.repeat(J.status),
      notes: ch.repeat(J.notes),
      deadline: ch.repeat(J.date),
      followUpDate: ch.repeat(J.date),
      cvId: ch.repeat(J.cvId),
    });
    const jobs = [
      honestJob(scope, 1, { ...full("a"), analysis: analysisWith({ verdict: "v".repeat(margin - ENVELOPE_CHARS) }) }),
      honestJob(scope, 2, full("م")), // 2 bytes per character in UTF-8
      honestJob(scope, 3, full("é")),
      honestJob(scope, 4, full("日")), // 3 bytes
      honestJob(scope, 5, full("\u0301")), // a lone combining mark is still a character
    ];
    await upsertRemoteJobs(jobs, id);
    expect(await countOf(s, "jobs")).toBe(jobs.length);

    const stored = new Map((await fetchRemoteJobs()).map((j) => [j.id, j]));
    for (const job of jobs) {
      const got = stored.get(job.id)!;
      for (const c of JOB_TEXT) {
        expect(got[c.field as keyof Job], `${c.field} of ${job.id}`).toBe(job[c.field as keyof Job]);
      }
    }
    expect(stored.get(jobs[0].id)!.analysis).toEqual(jobs[0].analysis);
  });

  it("emoji at their character limit are cut to fewer characters, never to more (JavaScript counts 2 per emoji)", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    // 😀 is ONE character to Postgres but 2 UTF-16 units to the app: the app cuts at half
    // the characters Postgres would have allowed. That is the safe direction.
    const job = honestJob(scope, 1, { title: "😀".repeat(J.title), notes: "😀".repeat(J.notes) });
    await upsertRemoteJobs([job], id);
    const [row] = await s.query<{ t: number; n: number }>(
      "select char_length(title)::int as t, char_length(notes)::int as n from jobs",
    );
    expect(row.t).toBe(J.title / 2);
    expect(row.n).toBe(J.notes / 2);
  });

  it("a cut that lands inside an emoji drops the whole emoji instead of leaving half of one", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    for (let k = 1; k <= 3; k++) {
      const job = honestJob(scope, k, { title: "a".repeat(J.title - k) + "😀😀😀" });
      await upsertRemoteJobs([job], id); // a half emoji would be refused by the database
    }
    expect(await countOf(s, "jobs")).toBe(3);
  });

  it("a job sent twice, or a whole batch sent twice, is simply updated", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const jobs = Array.from({ length: 40 }, (_, i) => honestJob(scope, i));
    await upsertRemoteJobs(jobs, id);
    await upsertRemoteJobs(jobs.map((j) => ({ ...j, notes: "edited", status: "interview" as const })), id);
    expect(await countOf(s, "jobs")).toBe(40);
    const notes = await s.query<{ notes: string }>("select distinct notes from jobs");
    expect(notes).toEqual([{ notes: "edited" }]);
  });
});

// ===========================================================================
// 1b) Worst-case JSON, just under the client's 80% margin
// ===========================================================================

describe("worst-case JSON that sits just under the client's 80% margin", () => {
  const marginOf = (cap: number) => Math.floor(cap * CLIENT_JSON_MARGIN);

  const CONTACT_SHAPES: { name: string; entry: (i: number) => Record<string, unknown> }[] = [
    { name: "the tiniest possible entries", entry: () => ({ type: "email", value: "a@b.co", name: "", role: "" }) },
    { name: "ordinary entries", entry: (i) => contactOf(i) },
    { name: "Arabic names", entry: (i) => ({ ...contactOf(i), name: "م".repeat(30) }) },
    { name: "emoji roles (2 UTF-16 units, 1 character each)", entry: (i) => ({ ...contactOf(i), role: "😀".repeat(20) }) },
    { name: "quotes and backslashes (escaped by JSON)", entry: (i) => ({ ...contactOf(i), name: '"\\'.repeat(20) }) },
    // 100 digits: Postgres prints this entry ~36% longer than JSON.stringify does, so the
    // exact (spaced) check, not the 80% margin, is what decides how many fit.
    { name: "extra fields that are lists of digits", entry: (i) => ({ ...contactOf(i), scores: new Array<number>(100).fill(1) }) },
    { name: "extra nested objects", entry: (i) => ({ ...contactOf(i), meta: { a: { b: { c: 1 } }, d: [1, [2, [3]]] } }) },
  ];

  it("contacts: the largest list under the margin is accepted, and trimmed only when Postgres would refuse it", async () => {
    const { id } = await newAccount();
    const scope = newScope();
    const cap = J.contactsJson;
    let wholeKept = 0;
    let trimmed = 0;

    for (const [index, shape] of CONTACT_SHAPES.entries()) {
      const list = (n: number) => Array.from({ length: n }, (_, i) => shape.entry(i));
      const n = await largestN((k) => JSON.stringify(list(k)).length, marginOf(cap), 3000);
      const contacts = list(n);
      expect(JSON.stringify(contacts).length, shape.name).toBeLessThanOrEqual(marginOf(cap));
      expect(n, shape.name).toBeGreaterThan(3);

      const row = toRow(honestJob(scope, index, { contacts }), id);
      const sent = (row.contacts ?? []) as unknown as Record<string, unknown>[];
      const dbLengthOfAll = await dbJsonLength(contacts);

      if (dbLengthOfAll <= cap) {
        // Fits both rules: the client must not throw anything away.
        expect(sent, shape.name).toEqual(contacts);
        wholeKept++;
      } else {
        // Over the cap once Postgres spaces it out: trimmed, but only as far as needed.
        expect(sent.length, shape.name).toBeLessThan(n);
        expect(await dbJsonLength(sent), shape.name).toBeLessThanOrEqual(cap);
        expect(await dbJsonLength(list(sent.length + 1)), `${shape.name}: trimmed more than needed`).toBeGreaterThan(cap);
        trimmed++;
      }
      // Whatever the client decided, the database takes it.
      await upsertRemoteJobs([honestJob(scope, index, { contacts })], id);
    }
    expect(wholeKept).toBeGreaterThanOrEqual(4);
    expect(trimmed).toBeGreaterThanOrEqual(1);
  });

  const ANALYSIS_SHAPES: { name: string; build: (n: number) => Record<string, unknown> }[] = [
    { name: "one long verdict", build: (n) => ({ verdict: "v".repeat(n) }) },
    { name: "Arabic verdict", build: (n) => ({ verdict: "م".repeat(n) }) },
    { name: "emoji verdict", build: (n) => ({ verdict: "😀".repeat(n) }) },
    { name: "verdict full of quotes, backslashes and newlines", build: (n) => ({ verdict: '"\\\n'.repeat(n) }) },
    {
      name: "many strengths",
      build: (n) => ({
        strengths: Array.from({ length: n }, (_, i) => ({ point: `p${i}`, job_requirement: "r", cv_evidence: "e" })),
      }),
    },
    { name: "a list of digits (the worst spacing)", build: (n) => ({ scores: new Array<number>(n).fill(1) }) },
    { name: "a list of nulls", build: (n) => ({ scores: new Array<null>(n).fill(null) }) },
    { name: "a list of empty strings", build: (n) => ({ scores: new Array<string>(n).fill("") }) },
    { name: "a list of booleans", build: (n) => ({ scores: new Array<boolean>(n).fill(true) }) },
    { name: "nested lists", build: (n) => ({ grid: Array.from({ length: n }, () => [1, [2]]) }) },
    { name: "many small keys", build: (n) => ({ keys: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1])) }) },
  ];

  it("analysis: the largest object under the margin is accepted, and left out only when Postgres would refuse it", async () => {
    const { id } = await newAccount();
    const scope = newScope();
    const cap = J.analysisJson;
    let kept = 0;
    let dropped = 0;

    for (const [index, shape] of ANALYSIS_SHAPES.entries()) {
      const analysisOf = (n: number) => analysisWith(shape.build(n));
      const n = await largestN((k) => JSON.stringify(analysisOf(k)).length, marginOf(cap), 40_000);
      expect(n, shape.name).toBeGreaterThan(50);

      for (const count of [n, n + 1]) {
        const analysis = analysisOf(count);
        const row = toRow(honestJob(scope, index * 2 + (count - n), { analysis }), id);
        if (count === n) {
          const dbLengthOfAll = await dbJsonLength(analysis);
          if (dbLengthOfAll <= cap) {
            expect(row.analysis, shape.name).toEqual(analysis);
            kept++;
          } else {
            expect(row, shape.name).not.toHaveProperty("analysis");
            dropped++;
          }
        }
        if (row.analysis) expect(await dbJsonLength(row.analysis), shape.name).toBeLessThanOrEqual(cap);
        await upsertRemoteJobs([honestJob(scope, index * 2 + (count - n), { analysis })], id);
      }
    }
    expect(kept).toBeGreaterThanOrEqual(6);
    expect(dropped).toBeGreaterThanOrEqual(1);
  });

  it("contacts: the client's spaced-length check agrees with Postgres to the character", async () => {
    // Entries whose JSON grows by ~36% when Postgres prints it, so the exact check (not
    // the 80% margin) is what decides how many fit.
    const { id } = await newAccount();
    const scope = newScope();
    const cap = J.contactsJson;
    const entry = (i: number) => ({ ...contactOf(i), scores: new Array<number>(100).fill(1) });
    const list = (n: number) => Array.from({ length: n }, (_, i) => entry(i));
    const best = await largestN(async (k) => dbJsonLength(list(k)), cap, 200);
    expect(JSON.stringify(list(best)).length, "precondition: the exact check must be what binds").toBeLessThanOrEqual(marginOf(cap));
    expect(JSON.stringify(list(best + 1)).length, "precondition").toBeLessThanOrEqual(marginOf(cap));

    for (const n of [best - 1, best, best + 1, best + 2]) {
      const row = toRow(honestJob(scope, n, { contacts: list(n) }), id);
      const sent = (row.contacts ?? []) as unknown[];
      expect(sent.length, `with ${n} contacts`).toBe(Math.min(n, best));
      await upsertRemoteJobs([honestJob(scope, 1000 + n, { contacts: list(n) })], id);
    }
  });

  it("analysis: the client's spaced-length check agrees with Postgres to the character", async () => {
    const { id } = await newAccount();
    const scope = newScope();
    const cap = J.analysisJson;
    const analysisOf = (n: number) => analysisWith({ scores: new Array<number>(n).fill(1) });
    const best = await largestN(async (k) => dbJsonLength(analysisOf(k)), cap, 30_000);
    expect(JSON.stringify(analysisOf(best + 3)).length, "precondition: the exact check must be what binds").toBeLessThanOrEqual(marginOf(cap));

    for (const n of [best - 2, best - 1, best, best + 1, best + 2]) {
      const row = toRow(honestJob(scope, n, { analysis: analysisOf(n) }), id);
      expect("analysis" in row, `with ${n} digits`).toBe(n <= best);
      await upsertRemoteJobs([honestJob(scope, 100_000 + n, { analysis: analysisOf(n) })], id);
    }
  });
});

// ===========================================================================
// 1c) Things the database cannot store at all, or stores at another length
//     The client's size checks measure with JSON.stringify and JavaScript's string
//     length. A few values are not the same size (or not storable at all) once they
//     reach Postgres. Each test below is the behaviour an honest user needs: whatever
//     the app holds, syncing must not be refused.
// ===========================================================================

/** Save jobs through the app's own code. null = the database took them; otherwise what
 *  it said (the refusal sinks the WHOLE batch, so one bad job blocks every job). */
async function refusalOf(jobs: Job[], userId: string): Promise<string | null> {
  try {
    await upsertRemoteJobs(jobs, userId);
    return null;
  } catch (e) {
    const r = e as RawPgError;
    return `${r.code}: ${String(r.message).slice(0, 120)}`;
  }
}

describe("text Postgres cannot store: NUL characters and half an emoji", () => {
  const HOSTILE_TEXT = [
    { what: "a NUL character", text: "before\u0000after" },
    { what: "half an emoji (a lone surrogate) in the middle", text: "before\ud83dafter" },
    { what: "half an emoji at the very end", text: "text ends with half an emoji \ud83d" },
  ];
  // The keys are job fields AND column names, so the same object serves both the app's
  // job and the unguarded row.
  const PLACES: { where: string; build: (t: string) => Record<string, unknown> }[] = [
    { where: "title", build: (t) => ({ title: t }) },
    { where: "notes", build: (t) => ({ notes: t }) },
    { where: "url", build: (t) => ({ url: t }) },
    { where: "deadline", build: (t) => ({ deadline: t }) },
    { where: "a contact's name", build: (t) => ({ contacts: [{ type: "email", value: "a@example.test", name: t, role: "" }] }) },
    { where: "the analysis verdict", build: (t) => ({ analysis: analysisWith({ verdict: t }) }) },
  ];
  const CASES = HOSTILE_TEXT.flatMap((h) => PLACES.map((p) => ({ ...h, ...p })));

  it.each(CASES)("ground truth: Postgres itself refuses $what in $where", async ({ text, build }) => {
    // Without the app in the way: this is a limit of the database, not of the client.
    const { id, s } = await newAccount();
    const scope = newScope();
    const err = await failureOf(wireUpsert(s, "jobs", [{ ...toRow(honestJob(scope, 1), id), ...build(text) }]));
    expect(err.code).toMatch(/^22/); // a data exception: not a limit, and not a permissions problem
    expect(await countOf(s, "jobs")).toBe(0);
  });

  it.each(CASES)("$what in $where does not stop the job from syncing", async ({ text, build }) => {
    const { id, s } = await newAccount();
    const scope = newScope();
    // One good job and one with the awkward text, in one batch: if the second is refused,
    // the first is lost too (the whole batch is one statement).
    const refusal = await refusalOf([honestJob(scope, 1), honestJob(scope, 2, build(text))], id);
    expect(refusal, "the app sent it and the database refused the whole batch").toBeNull();
    expect(await countOf(s, "jobs")).toBe(2);
  });
});

describe("numbers that Postgres prints at a very different length", () => {
  // JSON.stringify writes 1e300 in 5 characters ("1e+300"); Postgres prints the same
  // number as a 1 followed by 300 zeros. So JSON that looks tiny to the client can be
  // enormous to the database.
  const NUMBERS = [1e300, 1e21, 5e-324, 1.5e-7];

  it("ground truth: the same number is far longer as jsonb text than as JSON.stringify writes it", async () => {
    expect(JSON.stringify([1e300]).length).toBe(8);
    expect(await dbJsonLength([1e300])).toBe(303);
    expect(await dbJsonLength([5e-324])).toBeGreaterThan(300);
    expect(await dbJsonLength([1e21])).toBe(24);
    expect(await dbJsonLength([1.5e-7])).toBe(12);
  });

  const CASES = NUMBERS.flatMap((x) => [
    { field: "analysis", x, extra: { analysis: analysisWith({ scores: new Array<number>(4000).fill(x) }) } },
    {
      field: "contacts",
      x,
      extra: { contacts: Array.from({ length: 60 }, (_, i) => ({ ...contactOf(i), weight: x })) },
    },
  ]);

  it.each(CASES)("$field full of $x is not refused for being too big", async ({ extra }) => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const refusal = await refusalOf([honestJob(scope, 1, extra)], id);
    expect(refusal, "the app sent it and the database refused the whole batch").toBeNull();

    // Whatever JSON was kept is within the caps as Postgres measures it.
    const [r] = await s.query<{ c: number | null; a: number | null }>(
      "select char_length(contacts::text)::int as c, char_length(analysis::text)::int as a from jobs",
    );
    expect(r.c ?? 0).toBeLessThanOrEqual(J.contactsJson);
    expect(r.a ?? 0).toBeLessThanOrEqual(J.analysisJson);
  });

  it("ordinary decimals and big whole numbers in an analysis are fine", async () => {
    const { id } = await newAccount();
    const scope = newScope();
    const analysis = analysisWith({ ratios: [0.5, 0.25, 1234567.891, 9007199254740991, -3, 0], nested: { n: 99.5 } });
    await upsertRemoteJobs([honestJob(scope, 1, { analysis })], id);
    const [stored] = await fetchRemoteJobs();
    expect(stored.analysis).toEqual(analysis);
  });
});

// ===========================================================================
// 2) The database is the authority: rows that skip the guards are refused
// ===========================================================================

describe("rows that skip the client's guards are refused by the database", () => {
  const alphabets = [
    { name: "ASCII", make: (n: number) => "a".repeat(n) },
    { name: "Arabic (2 bytes a character)", make: (n: number) => "م".repeat(n) },
    { name: "emoji (4 bytes, 2 UTF-16 units)", make: (n: number) => "😀".repeat(n) },
    { name: "combining marks", make: (n: number) => "e\u0301".repeat(Math.ceil(n / 2)).slice(0, n) },
  ];

  describe.each(JOB_TEXT)("$constraint", ({ column, max, constraint }) => {
    it.each(alphabets)("raw $name: exactly the limit is accepted, one more is refused", async ({ make }) => {
      const { id, s } = await newAccount();
      const scope = newScope();
      const row = (value: string, i: number) => ({ ...toRow(honestJob(scope, i), id), [column]: value });

      const exact = cpLen(make(max)) === max ? make(max) : Array.from(make(max)).slice(0, max).join("");
      expect(cpLen(exact)).toBe(max);
      await wireUpsert(s, "jobs", [row(exact, 1)]);

      const err = await failureOf(wireUpsert(s, "jobs", [row(exact + "x", 2)]));
      expect(err.code).toBe("23514");
      expect(err.constraint).toBe(constraint);
      expect(await countOf(s, "jobs")).toBe(1);
    });
  });

  it.each(JOB_JSON)("$constraint: raw JSON over the cap (as Postgres prints it) is refused", async ({ column, max, constraint }) => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const wrap = (verdict: string) =>
      column === "analysis"
        ? analysisWith({ verdict })
        : [{ type: "email", value: "a@example.test", name: verdict, role: "" }];
    const sized = async (n: number) => wrap("x".repeat(n));
    const fitting = await largestN(async (k) => dbJsonLength(await sized(k)), max, max);

    await wireUpsert(s, "jobs", [{ ...toRow(honestJob(scope, 1), id), [column]: await sized(fitting) }]);
    const err = await failureOf(
      wireUpsert(s, "jobs", [{ ...toRow(honestJob(scope, 2), id), [column]: await sized(fitting + 1) }]),
    );
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe(constraint);
  });

  it.each(JOB_JSON)(
    "$constraint: JSON that is under the cap as JSON.stringify writes it can still be over as Postgres prints it",
    async ({ column, max, constraint }) => {
      const { id, s } = await newAccount();
      const scope = newScope();
      // A list of digits: 2 characters each in JSON.stringify, 3 in Postgres.
      const digits = (n: number) => (column === "analysis" ? analysisWith({ scores: new Array<number>(n).fill(1) }) : new Array<number>(n).fill(1));
      const n = await largestN((k) => JSON.stringify(digits(k)).length, max - 1, max);
      const value = digits(n);
      expect(JSON.stringify(value).length).toBeLessThan(max);
      expect(await dbJsonLength(value)).toBeGreaterThan(max);

      const err = await failureOf(
        wireUpsert(s, "jobs", [{ ...toRow(honestJob(scope, 1), id), [column]: value }]),
      );
      expect(err.constraint).toBe(constraint);
      // ...which is exactly why the client stays under 80% and also counts the spaces.
      const { updated_at: _u, ...clamped } = toRow(honestJob(scope, 2, { [column]: value }), id);
      void _u;
      await wireUpsert(s, "jobs", [clamped]);
    },
  );

  it.each(CV_TEXT)("$constraint: a CV record over $max characters is refused", async ({ column, max, constraint }) => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const cvRow = (value: string, i: number) => {
      const cvId = idFor(scope, i);
      return {
        id: cvId,
        user_id: id,
        name: "cv.pdf",
        role: "general",
        type: "application/pdf",
        size: 10,
        date_added: ISO,
        path: cvStoragePath(id, cvId),
        updated_at: ISO,
        [column]: value,
      };
    };
    await wireUpsert(s, "cvs", [cvRow("a".repeat(max), 1)]);
    const err = await failureOf(wireUpsert(s, "cvs", [cvRow("a".repeat(max + 1), 2)]));
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe(constraint);
  });

  it("property: an unguarded row is refused exactly when Postgres' own measurement says a field is too big", async () => {
    // For generated jobs, build the row the app would have sent WITHOUT its guards. The
    // prediction does not use any of the app's code: characters are counted as code
    // points and JSON is measured by asking Postgres.
    const rawRow = (job: Job, userId: string): Row => {
      const row: Row = { ...toRow(job, userId) };
      const j = job as unknown as Record<string, unknown>;
      for (const c of JOB_TEXT) if (typeof j[c.field] === "string") row[c.column] = j[c.field];
      if (Array.isArray(j.contacts) && j.contacts.length > 0) row.contacts = j.contacts;
      if (isRecord(j.analysis)) row.analysis = j.analysis;
      return row;
    };

    let refused = 0;
    let accepted = 0;
    for (const seed of [101, 102, 103, 104]) {
      const { id, s } = await newAccount();
      // calm = 0.93: most fields are fine, so some whole jobs are fine and some are not.
      for (const g of genBatch(seed, BATCH, 0.93)) {
        const row = rawRow(g.job, id);
        const broken: string[] = [];
        for (const c of JOB_TEXT) {
          const v = row[c.column];
          if (typeof v === "string" && cpLen(v) > c.max) broken.push(c.constraint);
        }
        for (const c of JOB_JSON) {
          const v = row[c.column];
          if (v !== undefined && v !== null && (await dbJsonLength(v)) > c.max) broken.push(c.constraint);
        }

        if (broken.length === 0) {
          await wireUpsert(s, "jobs", [row]);
          accepted++;
        } else {
          const err = await failureOf(wireUpsert(s, "jobs", [row]));
          expect(err.code, g.modes.join(", ")).toBe("23514");
          expect(broken, `${err.constraint} was refused but is not in the predicted list`).toContain(err.constraint);
          refused++;
        }
      }
    }
    expect(refused).toBeGreaterThan(40);
    expect(accepted).toBeGreaterThan(5);
  });

  it("one refused row sinks the whole batch; the client's guards are what keep the others safe", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const good = [honestJob(scope, 1), honestJob(scope, 3)];
    const bad = honestJob(scope, 2, { notes: "n".repeat(J.notes + 1) });

    // Without the guard: three rows go in as ONE statement, the middle one is too long.
    const unguarded = [good[0], bad, good[1]].map((j) => ({
      ...toRow(j, id),
      notes: (j as Job).notes,
    }));
    const err = await failureOf(wireUpsert(s, "jobs", unguarded));
    expect(err.constraint).toBe("jobs_notes_len");
    expect(await countOf(s, "jobs")).toBe(0);

    // With it (the real code path): all three are stored.
    await upsertRemoteJobs([good[0], bad, good[1]], id);
    expect(await countOf(s, "jobs")).toBe(3);
  });

  it("the database refuses a CV record whose file path is not '<your id>/<cv id>'", async () => {
    const { id, s } = await newAccount();
    const cvId = idFor(newScope(), 1);
    const err = await failureOf(
      wireUpsert(s, "cvs", [
        { id: cvId, user_id: id, name: "cv.pdf", role: "general", type: "", size: 1, date_added: ISO, path: `${id}/${cvId}`.toUpperCase(), updated_at: ISO },
      ]),
    );
    expect(err.constraint).toBe("cvs_path_shape");
    // The app's own path builder produces the shape the database wants, even for an
    // upper-case id (say, from a hand-edited backup).
    const shouty = cvId.toUpperCase();
    expect(cvStoragePath(id.toUpperCase(), shouty)).toBe(`${id}/${cvId}`);
    await wireUpsert(s, "cvs", [
      { id: shouty, user_id: id, name: "cv.pdf", role: "general", type: "", size: 1, date_added: ISO, path: cvStoragePath(id, shouty), updated_at: ISO },
    ]);
  });
});

// ===========================================================================
// 3) Row caps, through the app's real sync code
// ===========================================================================

describe("row caps through the app's own sync code", () => {
  it(`${LIMITS.jobsPerUser} jobs sync, re-syncing at the cap works, and the next new job is refused and explained`, async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const jobs = Array.from({ length: LIMITS.jobsPerUser }, (_, i) => honestJob(scope, i));

    await upsertRemoteJobs(jobs, id); // exactly the cap, as one batch
    expect(await countOf(s, "jobs")).toBe(LIMITS.jobsPerUser);

    // An account at its cap can still edit and re-save everything it has.
    await upsertRemoteJobs(jobs.map((j) => ({ ...j, notes: "edited at the cap" })), id);
    expect(await countOf(s, "jobs")).toBe(LIMITS.jobsPerUser);

    // One new job: refused, with a sentence the person can act on.
    const newcomer = honestJob(scope, LIMITS.jobsPerUser);
    const err = await upsertRemoteJobs([newcomer], id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect((err as RawPgError).code).toBe(LIMIT_ERROR_CODE);
    expect(describeLimitError(err, "job")).toBe(
      `An account can keep at most ${LIMITS.jobsPerUser} jobs. Delete some to add more.`,
    );

    // A batch that mixes an edit with that new job is refused whole: the edit is lost too.
    const mixed = [{ ...jobs[0], notes: "should not be saved" }, newcomer];
    await expect(upsertRemoteJobs(mixed, id)).rejects.toMatchObject({ code: LIMIT_ERROR_CODE });
    const [first] = await s.query<{ notes: string }>("select notes from jobs where id = $1", [jobs[0].id]);
    expect(first.notes).toBe("edited at the cap");

    // Deleting one makes exactly one slot.
    await s.query("delete from jobs where id = $1", [jobs[1].id]);
    await upsertRemoteJobs([newcomer], id);
    expect(await countOf(s, "jobs")).toBe(LIMITS.jobsPerUser);
  });

  it("a first sync of more than the cap stores nothing at all", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const jobs = Array.from({ length: LIMITS.jobsPerUser + 1 }, (_, i) => honestJob(scope, i));
    const err = await upsertRemoteJobs(jobs, id).then(() => null, (e: unknown) => e);
    expect(describeLimitError(err, "job")).toContain(`${LIMITS.jobsPerUser} jobs`);
    expect(await countOf(s, "jobs")).toBe(0);
  });
});

// ===========================================================================
// 4) describeLimitError reads the REAL errors
// ===========================================================================

describe("describeLimitError explains the errors Postgres really raises", () => {
  /** A row that breaks exactly one rule, built the way the app would build it. */
  type Violation = {
    constraint: string;
    table: "jobs" | "cvs";
    word: string;
    limitText: string;
    row: (userId: string, scope: number) => Row;
  };

  const cvRow = (userId: string, scope: number, over: Row): Row => {
    const id = idFor(scope, 1);
    return {
      id,
      user_id: userId,
      name: "cv.pdf",
      role: "general",
      type: "application/pdf",
      size: 10,
      date_added: ISO,
      path: cvStoragePath(userId, id),
      updated_at: ISO,
      ...over,
    };
  };

  const VIOLATIONS: Violation[] = [
    ...JOB_TEXT.map((c) => ({
      constraint: c.constraint,
      table: "jobs" as const,
      word: c.word,
      limitText: `max ${c.max.toLocaleString("en-US")} characters`,
      row: (userId: string, scope: number): Row => ({
        ...toRow(honestJob(scope, 1), userId),
        [c.column]: "x".repeat(c.max + 1),
      }),
    })),
    ...JOB_JSON.map((c) => ({
      constraint: c.constraint,
      table: "jobs" as const,
      word: c.word,
      limitText: `max ${c.max.toLocaleString("en-US")} characters`,
      row: (userId: string, scope: number): Row => ({
        ...toRow(honestJob(scope, 1), userId),
        [c.column]:
          c.column === "analysis"
            ? analysisWith({ verdict: "x".repeat(c.max) })
            : [{ type: "email", value: "x".repeat(c.max), name: "", role: "" }],
      }),
    })),
    ...CV_TEXT.map((c) => ({
      constraint: c.constraint,
      table: "cvs" as const,
      word: c.word,
      limitText: `max ${c.max.toLocaleString("en-US")} characters`,
      row: (userId: string, scope: number): Row => cvRow(userId, scope, { [c.column]: "x".repeat(c.max + 1) }),
    })),
    {
      constraint: "cvs_size_range",
      table: "cvs",
      word: "too large",
      limitText: "10.0 MB",
      row: (userId, scope) => cvRow(userId, scope, { size: LIMITS.cvRecordMaxBytes + 1 }),
    },
  ];

  it.each(VIOLATIONS)("$constraint: the real error is turned into a sentence naming the field and the limit", async (v) => {
    const { id, s } = await newAccount();
    const raw = await failureOf(wireUpsert(s, v.table, [v.row(id, newScope())]));
    expect(raw.code).toBe("23514");
    expect(raw.constraint).toBe(v.constraint);

    const err = asPostgrestError(raw);
    for (const context of ["job", "cv-upload", "cv-record", undefined] as const) {
      const message = describeLimitError(err, context);
      expect(message, `${v.constraint} (${context})`).not.toBeNull();
      expect(message).toContain(v.word);
      expect(message).toContain(v.limitText);
    }
  });

  it("cvs_path_shape is deliberately left unexplained (the app builds that path itself)", async () => {
    const { id, s } = await newAccount();
    const raw = await failureOf(wireUpsert(s, "cvs", [cvRow(id, newScope(), { path: "somewhere/else" })]));
    expect(raw.constraint).toBe("cvs_path_shape");
    expect(describeLimitError(asPostgrestError(raw), "cv-record")).toBeNull();
  });

  it("the job cap: the database's 54000 error becomes the exact sentence", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    await wireUpsert(s, "jobs", Array.from({ length: LIMITS.jobsPerUser }, (_, i) => toRow(honestJob(scope, i), id)));
    const raw = await failureOf(wireUpsert(s, "jobs", [toRow(honestJob(scope, 9999), id)]));
    expect(raw.code).toBe("54000");
    expect(raw.message.startsWith("FireHunt limit:")).toBe(true);

    const err = asPostgrestError(raw);
    const sentence = `An account can keep at most ${LIMITS.jobsPerUser} jobs. Delete some to add more.`;
    expect(describeLimitError(err, "job")).toBe(sentence);
    expect(describeLimitError(err)).toBe(sentence);
    expect(describeLimitError(err, "cv-upload")).toBe(sentence);
  });

  it("the CV cap: the database's 54000 error becomes the exact sentence", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const cv = (i: number) => cvRow(id, scope, { id: idFor(scope, i), path: cvStoragePath(id, idFor(scope, i)) });
    await wireUpsert(s, "cvs", Array.from({ length: LIMITS.cvsPerUser }, (_, i) => cv(i)));
    const raw = await failureOf(wireUpsert(s, "cvs", [cv(99)]));
    expect(raw.code).toBe("54000");

    const sentence = `An account can keep at most ${LIMITS.cvsPerUser} CVs. Delete some to add more.`;
    expect(describeLimitError(asPostgrestError(raw), "cv-upload")).toBe(sentence);
  });

  it("the file cap: the real row-level-security refusal becomes the 'too many files' sentence, for uploads only", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    // Stray files with no CV record (leftovers from earlier testing) fill the folder.
    await pg.admin(
      `insert into storage.objects (bucket_id, name, owner)
       select 'cvs', $1::text || '/stray-' || g, $1::uuid from generate_series(1, $2::int) g`,
      [id, LIMITS.cvFilesPerUser],
    );
    // A new CV: its record is saved (the app does that first), then its file is a NEW file.
    const recordId = idFor(scope, 1);
    await wireUpsert(s, "cvs", [cvRow(id, scope, { id: recordId, path: cvStoragePath(id, recordId) })]);
    const raw = await failureOf(
      s.query("insert into storage.objects (bucket_id, name, owner) values ('cvs', $1, auth.uid())", [
        `${id}/${recordId}`,
      ]),
    );
    expect(raw.code).toBe("42501");

    // Storage relays the refusal as a 403 (older versions: HTTP 400 with a body code of 403).
    for (const err of [
      new StorageApiError(raw.message, 403, "403"),
      new StorageApiError(raw.message, 400, "403"),
    ]) {
      expect(describeLimitError(err, "cv-upload")).toContain(`${LIMITS.cvFilesPerUser} CV files`);
      expect(describeLimitError(err, "job")).toBeNull();
      expect(describeLimitError(err)).toBeNull();
    }
  });

  it("errors that are not limits are left alone (null), so the caller keeps its own message", async () => {
    const { id, s } = await newAccount();
    const other = await newAccount();
    actAs({ id, s });
    const scope = newScope();
    const job = toRow(honestJob(scope, 1), id);
    await wireUpsert(s, "jobs", [job]);

    const errors = [
      // not a uuid
      await failureOf(wireUpsert(s, "jobs", [{ ...job, id: "job-1" }])),
      // a required column sent as null
      await failureOf(wireUpsert(s, "jobs", [{ ...toRow(honestJob(scope, 2), id), title: null }])),
      // somebody else's row
      await failureOf(wireUpsert(other.s, "jobs", [{ ...job, user_id: other.id }])),
      // a duplicate key, from a plain insert
      await failureOf(
        s.query("insert into jobs (id, user_id) values ($1, $2)", [job.id, id]),
      ),
    ];
    expect(errors.map((e) => e.code)).toEqual(["22P02", "23502", "42501", "23505"]);
    for (const raw of errors) {
      const err = asPostgrestError(raw);
      for (const context of ["job", "cv-upload", "cv-record", undefined] as const) {
        expect(describeLimitError(err, context), `${raw.code} (${context})`).toBeNull();
      }
    }
  });
});

// ===========================================================================
// 5) CV files and records, through the app's real upload code
// ===========================================================================

describe("CV uploads through the app's own code", () => {
  const upload = (userId: string, scope: number, i: number, file: File, over: Record<string, unknown> = {}) =>
    uploadRemoteCv({
      userId,
      id: idFor(scope, i),
      name: file.name,
      role: "general",
      type: file.type,
      dateAdded: ISO,
      blob: file,
      ...over,
    });

  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  const bucketRow = async () =>
    (
      await pg.admin<{ file_size_limit: unknown; allowed_mime_types: string[] }>(
        "select file_size_limit, allowed_mime_types from storage.buckets where id = 'cvs'",
      )
    )[0];

  it("the bucket accepts exactly the file types and size the client's helpers promise", async () => {
    const bucket = await bucketRow();
    expect(Number(bucket.file_size_limit)).toBe(LIMITS.cvFileBytes);
    expect([...bucket.allowed_mime_types].sort()).toEqual([...CV_ALLOWED_MIME_TYPES].sort());
    for (const [ext, mime] of Object.entries(CV_MIME_BY_EXTENSION)) {
      expect(bucket.allowed_mime_types, ext).toContain(mime);
      expect(canonicalCvMime(`My CV${ext}`)).toBe(mime);
      expect(canonicalCvMime(`MY CV${ext.toUpperCase()}`)).toBe(mime);
    }
  });

  it("a Word file the browser reports with an empty type uploads fine, because the app declares its type", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const word = new File(["bytes"], "My CV.docx", { type: "" });

    // What would happen WITHOUT the app's typed copy: the server sees an empty type.
    const naked = await (wiring.client as ReturnType<typeof fakeSupabase>).storage.from("cvs").upload(`${id}/naked`, word);
    expect(naked.error).not.toBeNull();
    expect(describeLimitError(naked.error, "cv-upload")).toMatch(/PDF, DOC and DOCX/);

    const path = await upload(id, scope, 1, word);
    expect(path).toBe(`${id}/${idFor(scope, 1)}`);
    const [row] = await s.query<{ type: string; size: unknown; path: string }>("select type, size, path from cvs");
    expect(row.type).toBe(CV_MIME_BY_EXTENSION[".docx"]);
    expect(Number(row.size)).toBe(word.size);
    expect(row.path).toBe(path);
  });

  it("whether the client says a file is uploadable and whether the cloud takes it never disagree", async () => {
    const big = (n: number) => new Uint8Array(n);
    const names = [
      "cv.pdf", "CV.PDF", "cv.doc", "cv.DOCX", "cv.docx", "résumé 日本語.pdf", ".pdf",
      "cv.txt", "cv.png", "cv", "cv.pdf.exe", "cv.pdfx", "cv.", "",
    ];
    const sizes = [0, 1, 4096, LIMITS.cvFileBytes - 1, LIMITS.cvFileBytes, LIMITS.cvFileBytes + 1];
    const seen = { accepted: 0, wrongType: 0, tooBig: 0 };

    for (const name of names) {
      for (const size of sizes) {
        // Only test the two biggest sizes with a few names (they allocate megabytes).
        if (size >= LIMITS.cvFileBytes - 1 && !["cv.pdf", "cv.DOCX", "cv.txt"].includes(name)) continue;
        const { id } = await newAccount();
        const scope = newScope();
        const file = new File([big(size)], name, { type: "" }); // an honest browser: no claim
        const outcome = await refusal(upload(id, scope, 1, file));
        const clientSays = isCvUploadable(name, size);

        expect(outcome === null, `${JSON.stringify(name)} at ${size} bytes: client says ${clientSays}`).toBe(clientSays);
        if (outcome === null) seen.accepted++;
        else {
          const message = describeLimitError(outcome, "cv-upload");
          expect(message, `${JSON.stringify(name)} at ${size}: the refusal must be explained`).not.toBeNull();
          if (size > LIMITS.cvFileBytes) {
            expect(message).toContain("5.0 MB");
            seen.tooBig++;
          } else {
            expect(message).toMatch(/PDF, DOC and DOCX/);
            seen.wrongType++;
          }
        }
      }
    }
    expect(seen.accepted).toBeGreaterThan(20);
    expect(seen.wrongType).toBeGreaterThan(10);
    expect(seen.tooBig).toBe(3);
  });

  it("a long or awkward file name is shortened (keeping its ending) and the record is accepted", async () => {
    const names = [
      "x".repeat(5000) + ".DOC",
      "م".repeat(1000) + ".pdf",
      "😀".repeat(500) + ".docx",
      "e\u0301".repeat(400) + ".pdf",
      "a".repeat(LIMITS.cv.name - 3) + ".pdf", // exactly the limit
      "a".repeat(LIMITS.cv.name - 2) + ".pdf", // one over
      "résumé \"quoted\" \\ back / slash 日本語.pdf",
    ];
    const { id, s } = await newAccount();
    const scope = newScope();
    for (const [i, name] of names.entries()) {
      await upload(id, scope, i, new File(["x"], name, { type: "application/pdf" }));
    }
    const stored = await s.query<{ name: string; n: number }>("select name, char_length(name)::int as n from cvs");
    expect(stored).toHaveLength(names.length);
    for (const row of stored) {
      expect(row.n).toBeLessThanOrEqual(LIMITS.cv.name);
      const original = names.find((n) => n.startsWith(row.name.slice(0, 10)) && n.endsWith(row.name.slice(-4)))!;
      expect(original, row.name.slice(0, 20)).toBeDefined();
      if (original.length <= LIMITS.cv.name) expect(row.name).toBe(original);
    }
  });

  /** The Storage side of the model, for putting files in the bucket without going through the app. */
  const bucketOf = () => (wiring.client as ReturnType<typeof fakeSupabase>).storage.from("cvs");
  const pdf = () => new Blob(["x"], { type: "application/pdf" });
  const filesOf = async (id: string) =>
    (
      await pg.admin<{ n: number }>(
        "select count(*)::int as n from storage.objects where bucket_id = 'cvs' and name like $1",
        [`${id}/%`],
      )
    )[0].n;

  it("at the file cap, replacing a CV you already have still works, and a new one is refused, explained and leaves no record behind", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const file = (n: string) => new File(["x"], n, { type: "application/pdf" });
    // 5 real CVs (record + file) plus stray files with no record fill the folder to the cap.
    const real = 5;
    for (let i = 0; i < real; i++) await upload(id, scope, i, file(`cv-${i}.pdf`));
    await pg.admin(
      `insert into storage.objects (bucket_id, name, owner)
       select 'cvs', $1::text || '/stray-' || g, $1::uuid from generate_series(1, $2::int) g`,
      [id, LIMITS.cvFilesPerUser - real],
    );
    expect(await filesOf(id)).toBe(LIMITS.cvFilesPerUser);

    // Replacing a file you already have adds nothing, so it is allowed.
    await upload(id, scope, 3, file("replaced.pdf"));
    const [row] = await s.query<{ name: string }>("select name from cvs where id = $1", [idFor(scope, 3)]);
    expect(row.name).toBe("replaced.pdf");
    expect(await filesOf(id)).toBe(LIMITS.cvFilesPerUser);

    // A brand-new CV's file would be number 21: refused, the person is told why, and the
    // record that was saved a moment earlier is taken out again.
    const err = await refusal(upload(id, scope, 700, file("one-more.pdf")));
    expect(err).not.toBeNull();
    expect(describeLimitError(err, "cv-upload")).toContain(`${LIMITS.cvFilesPerUser} CV files`);
    expect(await filesOf(id)).toBe(LIMITS.cvFilesPerUser);
    expect(await countOf(s, "cvs")).toBe(real);
    const ghost = await s.query("select 1 from cvs where id = $1", [idFor(scope, 700)]);
    expect(ghost).toHaveLength(0);
  });

  it("an account cannot put a file in another account's folder, or a file with no CV record in its own", async () => {
    const owner = await newAccount();
    const stranger = await newAccount(); // the app now talks to the database as this one
    const up = await bucketOf().upload(`${owner.id}/planted`, pdf());
    expect(up.error).not.toBeNull();
    const planted = await pg.admin("select 1 from storage.objects where bucket_id = 'cvs' and name = $1", [`${owner.id}/planted`]);
    expect(planted).toHaveLength(0);
    // Their own folder is not enough by itself: the file needs a CV record first.
    expect((await bucketOf().upload(`${stranger.id}/mine`, pdf())).error).not.toBeNull();
    // Through the app (record first, then file) it works.
    const path = await upload(stranger.id, newScope(), 1, new File(["x"], "cv.pdf", { type: "application/pdf" }));
    expect(path.startsWith(`${stranger.id}/`)).toBe(true);
    expect(await filesOf(stranger.id)).toBe(1);
  });

  it("uploading a CV again (same id) replaces it, even when the account is full of CV records", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const file = (n: string) => new File(["x"], n, { type: "application/pdf" });
    for (let i = 0; i < LIMITS.cvsPerUser; i++) await upload(id, scope, i, file(`cv-${i}.pdf`));
    expect(await countOf(s, "cvs")).toBe(LIMITS.cvsPerUser);
    await upload(id, scope, 3, file("replaced.pdf")); // same id: replaces file and record
    expect(await countOf(s, "cvs")).toBe(LIMITS.cvsPerUser);
    const [row] = await s.query<{ name: string }>("select name from cvs where id = $1", [idFor(scope, 3)]);
    expect(row.name).toBe("replaced.pdf");
    expect(await filesOf(id)).toBe(LIMITS.cvsPerUser);
  });

  it("an account that fills its CV slots is told clearly, stores nothing extra, and can recover by deleting one", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    const file = (i: number) => new File(["x"], `cv-${i}.pdf`, { type: "application/pdf" });

    for (let i = 0; i < LIMITS.cvsPerUser; i++) await upload(id, scope, i, file(i));

    // The next CV: its record is refused first, so no file is even sent (nothing is left over).
    const recordCap = `An account can keep at most ${LIMITS.cvsPerUser} CVs. Delete some to add more.`;
    for (let i = LIMITS.cvsPerUser; i < LIMITS.cvsPerUser + 3; i++) {
      const err = await refusal(upload(id, scope, i, file(i)));
      expect(describeLimitError(err, "cv-upload"), `attempt ${i + 1}`).toBe(recordCap);
    }
    expect(await countOf(s, "cvs")).toBe(LIMITS.cvsPerUser);
    expect(await filesOf(id)).toBe(LIMITS.cvsPerUser);

    // Deleting one CV (file and record) opens a slot for a new one.
    await deleteRemoteCv(idFor(scope, 0), cvStoragePath(id, idFor(scope, 0)));
    expect(await countOf(s, "cvs")).toBe(LIMITS.cvsPerUser - 1);
    await upload(id, scope, 500, file(500));
    expect(await countOf(s, "cvs")).toBe(LIMITS.cvsPerUser);
    expect(await filesOf(id)).toBe(LIMITS.cvsPerUser);
  });

  it("CV roles from the app are always accepted", async () => {
    const { id, s } = await newAccount();
    const scope = newScope();
    for (const [i, role] of CV_ROLES.entries()) {
      await upload(id, scope, i, new File(["x"], `cv-${i}.pdf`, { type: "application/pdf" }), { role: role.id });
    }
    expect(await countOf(s, "cvs")).toBe(CV_ROLES.length);
  });
});
