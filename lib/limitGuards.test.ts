import { readFileSync } from "node:fs";
import { PostgrestError, StorageApiError } from "@supabase/supabase-js";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalCvMime,
  clampCvForCloud,
  clampCvName,
  clampJobForCloud,
  clampText,
  describeLimitError,
  isCvUploadable,
  normalizeImportedCv,
  normalizeImportedJobs,
} from "./limitGuards";
import { CV_MIME_BY_EXTENSION, LIMITS } from "./limits";
import { toRow } from "./jobsRemote";
import type { StoredContact } from "./contacts";
import type { Job } from "./jobs";

const baseJob: Job = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Product Manager",
  company: "Acme",
  country: "Australia",
  url: "https://example.com/job",
  salary: "A$150k",
  status: "applied",
  notes: "Call back on Monday.",
  dateAdded: "2026-10-01T00:00:00.000Z",
};

const contact = (i: number): StoredContact => ({
  type: "email",
  value: `person${i}@example.com`,
  name: `Person ${i}`,
  role: "Recruiter",
});

const analysis = {
  fit_score: 72,
  verdict: "A decent fit.",
  strengths: [{ point: "p", job_requirement: "r", cv_evidence: "e" }],
  gaps: [],
  tailored_bullets: [],
  outreach: { email_subject: "s", email_body: "b", whatsapp_message: "w" },
  generated_at: "2026-10-01T00:00:00.000Z",
  cv_id: "cv1",
  cv_name: "CV.pdf",
  model: "test-model",
  removed_unverified: 0,
  confidence: "high" as const,
};

/** Cut a long text to `n` characters so a test can say "ends at the limit". */
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

describe("clampText", () => {
  it("returns short text untouched and cuts long text to the limit", () => {
    expect(clampText("hello", 10)).toBe("hello");
    expect(clampText("hello", 5)).toBe("hello");
    expect(clampText("hello world", 5)).toBe("hello");
    expect(clampText("hello", 0)).toBe("");
  });

  it("turns anything that is not a string into an empty string", () => {
    for (const v of [undefined, null, 42, true, {}, [], ["a"]]) {
      expect(clampText(v, 10)).toBe("");
    }
  });

  it("treats a nonsense limit as zero instead of throwing", () => {
    expect(clampText("abc", Number.NaN)).toBe("");
    expect(clampText("abc", -5)).toBe("");
  });

  it("never cuts an emoji in half (a lone half is rejected by the database)", () => {
    const text = "a" + "😀".repeat(10); // 1 + 20 UTF-16 units
    const cut = clampText(text, 4); // would land between the halves of the 2nd emoji
    expect(cut).toBe("a😀");
    expect(cut.length).toBeLessThanOrEqual(4);
    // Every surrogate in the result is half of a complete pair.
    expect(cut.isWellFormed()).toBe(true);
    expect(clampText(text, 5)).toBe("a😀😀");
  });
});

describe("clampCvName / clampCvForCloud", () => {
  it("keeps the file extension when it has to shorten the name", () => {
    const name = rep("resume ", 400) + ".docx";
    const out = clampCvName(name);
    expect(out.length).toBe(LIMITS.cv.name);
    expect(out.endsWith(".docx")).toBe(true);
  });

  it("leaves a normal name alone and copes with non-strings", () => {
    expect(clampCvName("My CV.pdf")).toBe("My CV.pdf");
    expect(clampCvName(undefined)).toBe("");
    expect(clampCvName("x".repeat(400)).length).toBe(LIMITS.cv.name);
  });

  it("trims name, role and type to the CV limits and keeps other fields", () => {
    const cv = clampCvForCloud({
      name: "n".repeat(500),
      role: "r".repeat(100),
      type: "t".repeat(500),
      extra: 7,
    });
    expect(cv.name.length).toBe(LIMITS.cv.name);
    expect(cv.role.length).toBe(LIMITS.cv.role);
    expect(cv.type.length).toBe(LIMITS.cv.type);
    expect(cv.extra).toBe(7);
  });
});

describe("canonicalCvMime", () => {
  it("maps each accepted extension to its file type, ignoring capitalisation", () => {
    expect(canonicalCvMime("cv.pdf")).toBe(CV_MIME_BY_EXTENSION[".pdf"]);
    expect(canonicalCvMime("CV.PDF")).toBe("application/pdf");
    expect(canonicalCvMime("cv.doc")).toBe("application/msword");
    expect(canonicalCvMime("My CV (final).DocX")).toBe(CV_MIME_BY_EXTENSION[".docx"]);
  });

  it("does not mistake .docx for .doc, or .doc for .docx", () => {
    expect(canonicalCvMime("a.docx")).not.toBe(canonicalCvMime("a.doc"));
    expect(canonicalCvMime("a.docx")).toContain("wordprocessingml");
    expect(canonicalCvMime("a.doc")).toBe("application/msword");
  });

  it("only looks at the real ending of the name", () => {
    expect(canonicalCvMime("resume.pdf.exe")).toBeNull();
    expect(canonicalCvMime("notes.txt")).toBeNull();
    expect(canonicalCvMime("pdf")).toBeNull();
    expect(canonicalCvMime("")).toBeNull();
    expect(canonicalCvMime("cv.pdf ")).toBeNull();
    expect(canonicalCvMime("cv.docx.doc")).toBe("application/msword");
  });

  it("tolerates things that are not names", () => {
    for (const v of [undefined, null, 5, {}, []]) expect(canonicalCvMime(v)).toBeNull();
  });
});

describe("isCvUploadable", () => {
  it("accepts a right-typed file up to the size limit", () => {
    expect(isCvUploadable("cv.pdf", 1000)).toBe(true);
    expect(isCvUploadable("cv.docx", LIMITS.cvFileBytes)).toBe(true);
  });

  it("refuses a file over the limit, of the wrong type, or with a nonsense size", () => {
    expect(isCvUploadable("cv.pdf", LIMITS.cvFileBytes + 1)).toBe(false);
    expect(isCvUploadable("cv.txt", 10)).toBe(false);
    expect(isCvUploadable("cv.pdf", -1)).toBe(false);
    expect(isCvUploadable("cv.pdf", Number.NaN)).toBe(false);
    expect(isCvUploadable("cv.pdf", undefined)).toBe(false);
  });
});

describe("clampJobForCloud", () => {
  const full: Job = {
    ...baseJob,
    deadline: "2026-10-20",
    followUpDate: "2026-10-10",
    cvId: "cv1",
    contacts: [contact(1), contact(2)],
    analysis,
  };

  it("returns a new job with identical values when everything is within limits", () => {
    for (const j of [baseJob, full]) {
      const out = clampJobForCloud(j);
      expect(out).not.toBe(j);
      expect(out).toStrictEqual(j);
    }
  });

  it("keeps a job that sits exactly at every limit unchanged", () => {
    const edge: Job = {
      ...baseJob,
      title: "t".repeat(LIMITS.job.title),
      company: "c".repeat(LIMITS.job.company),
      country: "y".repeat(LIMITS.job.country),
      url: "u".repeat(LIMITS.job.url),
      salary: "s".repeat(LIMITS.job.salary),
      status: "applied",
      notes: "n".repeat(LIMITS.job.notes),
      deadline: "d".repeat(LIMITS.job.date),
      followUpDate: "f".repeat(LIMITS.job.date),
      cvId: "v".repeat(LIMITS.job.cvId),
    };
    expect(clampJobForCloud(edge)).toStrictEqual(edge);
  });

  it.each([
    ["title", LIMITS.job.title],
    ["company", LIMITS.job.company],
    ["country", LIMITS.job.country],
    ["url", LIMITS.job.url],
    ["salary", LIMITS.job.salary],
    ["notes", LIMITS.job.notes],
    ["status", LIMITS.job.status],
    ["deadline", LIMITS.job.date],
    ["followUpDate", LIMITS.job.date],
    ["cvId", LIMITS.job.cvId],
  ] as const)("cuts %s to %i characters", (field, max) => {
    const out = clampJobForCloud({ ...baseJob, [field]: "z".repeat(max * 3) } as Job);
    expect((out as unknown as Record<string, string>)[field]).toBe("z".repeat(max));
  });

  it("only changes the field that was too long", () => {
    const out = clampJobForCloud({ ...baseJob, notes: "n".repeat(50_000) });
    expect(out).toStrictEqual({ ...baseJob, notes: "n".repeat(LIMITS.job.notes) });
  });

  it("does not modify the job it was given", () => {
    const input: Job = { ...baseJob, notes: "n".repeat(50_000), contacts: [contact(1)] };
    const copy = structuredClone(input);
    clampJobForCloud(input);
    expect(input).toStrictEqual(copy);
  });

  it("drops contacts from the end until the rest fit, keeping valid JSON", () => {
    const many = Array.from({ length: 400 }, (_, i) => contact(i));
    const out = clampJobForCloud({ ...baseJob, contacts: many });
    const kept = out.contacts ?? [];
    const cap = LIMITS.job.contactsJson * 0.8;

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(many.length);
    expect(kept).toStrictEqual(many.slice(0, kept.length)); // a prefix, in order
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(cap);
    expect(JSON.parse(JSON.stringify(kept))).toStrictEqual(kept);
    // ...and it is as many as fit: one more would go over.
    expect(JSON.stringify(many.slice(0, kept.length + 1)).length).toBeGreaterThan(cap);
  });

  it("leaves contacts out entirely when not even one fits", () => {
    const huge: StoredContact = { ...contact(1), name: "N".repeat(20_000) };
    const out = clampJobForCloud({ ...baseJob, contacts: [huge, contact(2)] });
    expect(out.contacts).toStrictEqual([]);
    expect(toRow(out, "u")).not.toHaveProperty("contacts");
  });

  it("drops entries that are not contacts, since the UI would choke on them", () => {
    const messy = [
      null,
      7,
      "email",
      { type: "fax", value: "123" },
      { type: "email" },
      { type: "email", value: "a@b.com" }, // name / role missing: repaired, not dropped
      contact(9),
    ] as unknown as StoredContact[];
    const out = clampJobForCloud({ ...baseJob, contacts: messy });
    expect(out.contacts).toStrictEqual([
      { type: "email", value: "a@b.com", name: "", role: "" },
      contact(9),
    ]);
  });

  it("leaves the fit analysis out when it is too big, because JSON cannot be cut", () => {
    const big = { ...analysis, verdict: "v".repeat(LIMITS.job.analysisJson) };
    const out = clampJobForCloud({ ...baseJob, analysis: big });
    expect(out).not.toHaveProperty("analysis");
  });

  it("applies the 80% margin to the analysis, not just the raw cap", () => {
    const sizeOf = (a: object) => JSON.stringify(a).length;
    const cap = LIMITS.job.analysisJson;
    const room = (target: number) => ({
      ...analysis,
      verdict: "v".repeat(target - sizeOf({ ...analysis, verdict: "" })),
    });
    const justUnder = room(cap * 0.8);
    const justOver = room(cap * 0.8 + 1);
    expect(sizeOf(justUnder)).toBe(cap * 0.8);
    expect(clampJobForCloud({ ...baseJob, analysis: justUnder }).analysis).toBeDefined();
    expect(clampJobForCloud({ ...baseJob, analysis: justOver }).analysis).toBeUndefined();
  });

  it("measures JSON the way Postgres prints it (a space after every : and ,)", () => {
    // 15,000 ones: 30,001 characters of JSON (under the 32,000 margin) but 45,000 once
    // Postgres adds a space after each comma — over the 40,000 cap.
    const spaced = { ...analysis, strengths: Array.from({ length: 15_000 }, () => 1) };
    expect(JSON.stringify(spaced).length).toBeLessThan(LIMITS.job.analysisJson * 0.8);
    expect(clampJobForCloud({ ...baseJob, analysis: spaced as never })).not.toHaveProperty(
      "analysis",
    );
  });

  it("is idempotent", () => {
    const pathological: Job = {
      ...baseJob,
      title: "😀".repeat(900),
      notes: "n".repeat(60_000),
      url: "u".repeat(5_000),
      contacts: Array.from({ length: 300 }, (_, i) => contact(i)),
      analysis: { ...analysis, verdict: "v".repeat(50_000) },
    };
    for (const j of [baseJob, pathological]) {
      const once = clampJobForCloud(j);
      expect(clampJobForCloud(once)).toStrictEqual(once);
    }
  });

  it("never throws on malformed data from localStorage", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const weird: unknown[] = [
      null,
      undefined,
      0,
      "text",
      [],
      {},
      { title: { a: 1 }, notes: 5, status: null, url: ["x"] },
      { contacts: "oops" },
      { contacts: { length: 3 } },
      { contacts: [null, undefined, 3] },
      { contacts: [{ type: "email", value: "a@b.com", big: BigInt(10) }] },
      { analysis: "oops" },
      { analysis: [1, 2, 3] },
      { analysis: circular },
      { analysis: { n: BigInt(10) } },
      { deadline: 5, followUpDate: {}, cvId: [] },
    ];
    for (const w of weird) {
      expect(() => clampJobForCloud(w as Job)).not.toThrow();
      const out = clampJobForCloud(w as Job);
      expect(typeof out.title).toBe("string");
      expect(typeof out.notes).toBe("string");
      expect(out.analysis === undefined || typeof out.analysis === "object").toBe(true);
      expect(Array.isArray(out.contacts) || out.contacts === undefined).toBe(true);
    }
  });
});

describe("normalizeImportedJobs", () => {
  const NOW = "2026-11-01T00:00:00.000Z";

  it("passes good jobs through unchanged", () => {
    const good: Job[] = [baseJob, { ...baseJob, id: "22222222-2222-4222-8222-222222222222" }];
    expect(normalizeImportedJobs(good, NOW)).toStrictEqual({ jobs: good, skipped: 0 });
  });

  it("skips entries that are not jobs, and repeated ids, and says how many", () => {
    const raw = [
      baseJob,
      null,
      5,
      "job",
      {},
      { id: "" },
      { id: 12 },
      { ...baseJob, title: "Same id again" },
    ];
    const { jobs, skipped } = normalizeImportedJobs(raw, NOW);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe("Product Manager");
    expect(skipped).toBe(7);
  });

  it("gives back an empty list when the backup's jobs are not a list", () => {
    for (const v of [undefined, null, "x", 5, {}]) {
      expect(normalizeImportedJobs(v, NOW)).toStrictEqual({ jobs: [], skipped: 0 });
    }
  });

  it("repairs a bad status or date instead of losing the job", () => {
    const { jobs } = normalizeImportedJobs(
      [
        { ...baseJob, status: "wishlist" },
        { ...baseJob, id: "b", dateAdded: "not a date" },
        { ...baseJob, id: "c", dateAdded: undefined, status: undefined },
      ],
      NOW,
    );
    expect(jobs.map((j) => j.status)).toStrictEqual(["interested", "applied", "interested"]);
    expect(jobs[0].dateAdded).toBe(baseJob.dateAdded);
    expect(jobs[1].dateAdded).toBe(NOW);
    expect(jobs[2].dateAdded).toBe(NOW);
  });

  it("trims oversize records so they cannot block cloud sync later", () => {
    const { jobs } = normalizeImportedJobs(
      [
        {
          ...baseJob,
          notes: "n".repeat(100_000),
          contacts: Array.from({ length: 500 }, (_, i) => contact(i)),
        },
      ],
      NOW,
    );
    expect(jobs[0].notes.length).toBe(LIMITS.job.notes);
    expect(JSON.stringify(jobs[0].contacts).length).toBeLessThanOrEqual(
      LIMITS.job.contactsJson * 0.8,
    );
  });

  it("keeps a real analysis but drops one the analysis window could not open", () => {
    const { jobs } = normalizeImportedJobs(
      [
        { ...baseJob, analysis },
        { ...baseJob, id: "b", analysis: { fit_score: 50 } },
        { ...baseJob, id: "c", analysis: "garbage" },
      ],
      NOW,
    );
    expect(jobs[0].analysis).toStrictEqual(analysis);
    expect(jobs[1]).not.toHaveProperty("analysis");
    expect(jobs[2]).not.toHaveProperty("analysis");
  });
});

describe("normalizeImportedCv", () => {
  const NOW = "2026-11-01T00:00:00.000Z";
  const good = {
    id: "cv1",
    name: "My CV.pdf",
    role: "tech",
    type: "application/pdf",
    size: 1234,
    dateAdded: "2026-10-01T00:00:00.000Z",
    dataUrl: "data:application/pdf;base64,AAAA",
  };

  it("passes a good CV through unchanged", () => {
    expect(normalizeImportedCv(good, NOW)).toStrictEqual(good);
  });

  it("repairs missing details but rejects entries with no id or no file", () => {
    expect(
      normalizeImportedCv({ id: "x", dataUrl: "data:,a", role: "astronaut", size: -4 }, NOW),
    ).toStrictEqual({
      id: "x",
      name: "CV",
      role: "general",
      type: "",
      size: 0,
      dateAdded: NOW,
      dataUrl: "data:,a",
    });
    for (const bad of [null, 3, "cv", {}, { id: "x" }, { dataUrl: "d" }, { id: 1, dataUrl: "d" }]) {
      expect(normalizeImportedCv(bad, NOW)).toBeNull();
    }
  });

  it("keeps a CV that is too big or the wrong type (it just stays on this device)", () => {
    const odd = { ...good, name: "huge.txt", size: LIMITS.cvFileBytes * 3, type: "text/plain" };
    expect(normalizeImportedCv(odd, NOW)).toStrictEqual(odd);
  });
});

// Real error objects, built the way supabase-js delivers them.
const pgrst = (code: string, message: string, details = "") =>
  new PostgrestError({ message, details, hint: "", code });
const storage = (message: string, status: number, statusCode = String(status)) =>
  new StorageApiError(message, status, statusCode);

describe("describeLimitError", () => {
  describe("row-count limits (Postgres error 54000)", () => {
    it("uses the human sentence from the database message", () => {
      const err = pgrst(
        "54000",
        "FireHunt limit: an account can keep at most 300 jobs. Delete some to add more.",
      );
      expect(describeLimitError(err, "job")).toBe(
        "An account can keep at most 300 jobs. Delete some to add more.",
      );
      expect(describeLimitError(err)).toBe(describeLimitError(err, "job"));
    });

    it("works for CVs, and for a plain-object error", () => {
      expect(
        describeLimitError({
          message: "FireHunt limit: an account can keep at most 10 CVs. Delete some to add more.",
          details: null,
          hint: null,
          code: "54000",
        }),
      ).toBe("An account can keep at most 10 CVs. Delete some to add more.");
    });

    it("still recognises our message when a layer dropped the error code", () => {
      expect(
        describeLimitError(new Error("FireHunt limit: an account can keep at most 300 jobs.")),
      ).toBe("An account can keep at most 300 jobs.");
    });

    it("does not claim other Postgres 54000 errors as ours", () => {
      expect(
        describeLimitError(pgrst("54000", "index row size 3000 exceeds btree version 4 maximum 2704")),
      ).toBeNull();
    });

    it("does not trust the prefix on an unrelated error code", () => {
      expect(describeLimitError(pgrst("42501", "FireHunt limit: nope"))).toBeNull();
    });
  });

  describe("field-size limits (check violation 23514)", () => {
    const violation = (constraint: string, table = "jobs") =>
      pgrst(
        "23514",
        `new row for relation "${table}" violates check constraint "${constraint}"`,
        "Failing row contains (11111111-1111-4111-8111-111111111111, ...).",
      );

    it("names the field and the limit, with thousands separators", () => {
      expect(describeLimitError(violation("jobs_notes_len"), "job")).toBe(
        "A job's notes are too long (max 20,000 characters).",
      );
      expect(describeLimitError(violation("jobs_title_len"))).toBe(
        "A job's title is too long (max 500 characters).",
      );
      expect(describeLimitError(violation("cvs_size_range", "cvs"), "cv-record")).toBe(
        "A CV file is too large (max 10.0 MB).",
      );
    });

    it("uses the numbers from LIMITS, so the two cannot drift apart", () => {
      expect(describeLimitError(violation("jobs_url_len"))).toContain("2,000");
      expect(describeLimitError(violation("jobs_contacts_size"))).toContain("8,000");
      expect(describeLimitError(violation("jobs_analysis_size"))).toContain("40,000");
      expect(describeLimitError(violation("cvs_name_len", "cvs"))).toContain(
        String(LIMITS.cv.name),
      );
    });

    it("says nothing about constraints that are not limits, or are not ours", () => {
      expect(describeLimitError(violation("cvs_path_shape", "cvs"))).toBeNull();
      expect(describeLimitError(violation("some_other_check"))).toBeNull();
      expect(describeLimitError(pgrst("23514", "something else went wrong"))).toBeNull();
    });
  });

  describe("file storage refusals", () => {
    it("explains a file over the size limit (413)", () => {
      const msg = describeLimitError(
        storage("The object exceeded the maximum allowed size", 413),
        "cv-upload",
      );
      expect(msg).toContain("5.0 MB");
      expect(describeLimitError(storage("too big", 413))).toBe(msg); // no context given
      expect(describeLimitError(storage("too big", 413, "Payload too large"), "cv-upload")).toBe(
        msg,
      );
    });

    it("explains a file type the bucket does not accept (415, or a message about mime)", () => {
      const byStatus = describeLimitError(
        storage("mime type text/plain is not supported", 415),
        "cv-upload",
      );
      expect(byStatus).toMatch(/PDF/);
      expect(byStatus).toMatch(/DOCX/);
      expect(
        describeLimitError(storage("mime type text/plain is not supported", 400, "invalid_mime_type")),
      ).toBe(byStatus);
      expect(describeLimitError(storage("Unsupported", 415))).toBe(byStatus);
    });

    it("explains the per-account file cap, only for an upload", () => {
      const rls = storage("new row violates row-level security policy", 403);
      expect(describeLimitError(rls, "cv-upload")).toContain(`${LIMITS.cvFilesPerUser} CV files`);
      // Supabase's Storage API sometimes answers HTTP 400 with a body code of 403.
      expect(
        describeLimitError(storage("new row violates row-level security policy", 400, "403"), "cv-upload"),
      ).toContain(`${LIMITS.cvFilesPerUser} CV files`);
      expect(describeLimitError(rls)).toBeNull();
      expect(describeLimitError(rls, "job")).toBeNull();
      expect(describeLimitError(rls, "cv-record")).toBeNull();
    });

    it("does not blame the limit for other 403s", () => {
      expect(describeLimitError(storage("Invalid JWT", 403), "cv-upload")).toBeNull();
      expect(describeLimitError(storage("Unauthorized", 401), "cv-upload")).toBeNull();
    });

    it("does not read a 413 on a jobs request as a file problem", () => {
      expect(describeLimitError(storage("Request Entity Too Large", 413), "job")).toBeNull();
      expect(describeLimitError(pgrst("PGRST000", "too big"), "cv-record")).toBeNull();
    });

    it("reads status codes that arrive as strings", () => {
      expect(
        describeLimitError({ message: "x", status: "413", statusCode: "413" }, "cv-upload"),
      ).toContain("5.0 MB");
    });
  });

  describe("everything else is left to the caller's generic message", () => {
    it("returns null for ordinary failures and odd inputs", () => {
      const nothing = [
        new TypeError("Failed to fetch"),
        pgrst("23505", 'duplicate key value violates unique constraint "jobs_pkey"'),
        pgrst("PGRST301", "JWT expired"),
        storage("Object not found", 404),
        "some string",
        null,
        undefined,
        42,
        {},
        [],
      ];
      for (const e of nothing) {
        expect(describeLimitError(e, "job")).toBeNull();
        expect(describeLimitError(e, "cv-upload")).toBeNull();
      }
    });

    it("never throws, even if reading the error throws", () => {
      const hostile = {
        get message(): string {
          throw new Error("boom");
        },
      };
      expect(describeLimitError(hostile, "job")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres: what we send must pass the constraints in
// 003_limits.sql, and what the database says must be understood.
// ---------------------------------------------------------------------------
describe("against the real migration (Postgres via PGlite)", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/003_limits.sql", import.meta.url),
    "utf8",
  );
  const USER = "99999999-9999-4999-8999-999999999999";
  let db: PGlite;

  // Only the table-level parts of the migration (field limits and row caps) run here;
  // the storage parts need Supabase's own schema.
  const tableSql = migration.slice(0, migration.indexOf("update storage.buckets"));

  beforeAll(async () => {
    expect(tableSql).toContain("enforce_row_cap");
    db = new PGlite();
    await db.exec(`
      create table public.jobs (
        id uuid primary key, user_id uuid not null,
        title text not null default '', company text not null default '',
        country text not null default '', url text not null default '',
        salary text not null default '', status text not null default 'interested',
        notes text not null default '', date_added timestamptz not null default now(),
        deadline text, follow_up_date text, cv_id text,
        updated_at timestamptz not null default now(),
        contacts jsonb, analysis jsonb
      );
      create table public.cvs (
        id uuid primary key, user_id uuid not null,
        name text not null default '', role text not null default 'general',
        type text not null default '', size bigint not null default 0,
        date_added timestamptz not null default now(), path text not null,
        updated_at timestamptz not null default now()
      );
    `);
    await db.exec(tableSql);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  /** Insert one job the way PostgREST would: JSON columns as jsonb. */
  async function insert(row: Record<string, unknown>) {
    const cols = Object.keys(row);
    const jsonCol = (c: string) => c === "contacts" || c === "analysis";
    await db.query(
      `insert into public.jobs (${cols.join(", ")}) values (${cols
        .map((c, i) => `$${i + 1}${jsonCol(c) ? "::jsonb" : ""}`)
        .join(", ")})`,
      cols.map((c) => (jsonCol(c) ? JSON.stringify(row[c]) : row[c])),
    );
  }

  /** The error supabase-js would hand back for a failed statement. */
  async function failure(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (e) {
      const pg = e as { message: string; code?: string; detail?: string; hint?: string };
      return new PostgrestError({
        message: pg.message,
        details: pg.detail ?? "",
        hint: pg.hint ?? "",
        code: pg.code ?? "",
      });
    }
    throw new Error("expected the database to refuse this, but it accepted it");
  }

  const fresh = (over: Partial<Job> = {}): Job => ({ ...baseJob, id: uuid(), ...over });

  // Every text field of a job, the longest the database allows plus one.
  const FIELDS = [
    ["title", LIMITS.job.title, "jobs_title_len"],
    ["company", LIMITS.job.company, "jobs_company_len"],
    ["country", LIMITS.job.country, "jobs_country_len"],
    ["url", LIMITS.job.url, "jobs_url_len"],
    ["salary", LIMITS.job.salary, "jobs_salary_len"],
    ["status", LIMITS.job.status, "jobs_status_len"],
    ["notes", LIMITS.job.notes, "jobs_notes_len"],
    ["deadline", LIMITS.job.date, "jobs_deadline_len"],
    ["followUpDate", LIMITS.job.date, "jobs_follow_up_len"],
    ["cvId", LIMITS.job.cvId, "jobs_cv_id_len"],
  ] as const;

  it.each(FIELDS)(
    "%s: the database refuses max+1 (and we explain it), accepts what we send instead",
    async (field, max, constraint) => {
      const tooLong = fresh({ [field]: "x".repeat(max + 1) } as Partial<Job>);

      // Without our trimming the database says no, in words we can translate.
      const raw = toRow(tooLong, USER);
      const refused = await failure(() =>
        insert({ ...raw, [rowColumn(field)]: "x".repeat(max + 1) }),
      );
      expect(refused.code).toBe("23514");
      expect(refused.message).toContain(`"${constraint}"`);
      expect(describeLimitError(refused, "job")).toContain(`max ${max.toLocaleString("en-US")}`);

      // With it, the same job goes in.
      await insert(toRow(tooLong, USER));
    },
  );

  function rowColumn(field: string): string {
    return field === "followUpDate" ? "follow_up_date" : field === "cvId" ? "cv_id" : field;
  }

  it("accepts a job at exactly every limit", async () => {
    await insert(
      toRow(
        fresh({
          title: "t".repeat(LIMITS.job.title),
          company: "c".repeat(LIMITS.job.company),
          country: "y".repeat(LIMITS.job.country),
          url: "u".repeat(LIMITS.job.url),
          salary: "s".repeat(LIMITS.job.salary),
          notes: "n".repeat(LIMITS.job.notes),
          deadline: "d".repeat(LIMITS.job.date),
          followUpDate: "f".repeat(LIMITS.job.date),
          cvId: "v".repeat(LIMITS.job.cvId),
        }),
        USER,
      ),
    );
  });

  it("accepts emoji-heavy text that had to be cut (no half-emoji gets through)", async () => {
    // Postgres counts characters, JavaScript counts halves: cutting by JavaScript
    // length is safe, but only if the cut never lands between the two halves.
    const odd = fresh({ title: "a" + "😀".repeat(2000), notes: "é".repeat(30_000) + "😀" });
    await insert(toRow(odd, USER));
    const { rows } = await db.query<{ n: number }>(
      "select char_length(title) as n from public.jobs where id = $1",
      [odd.id],
    );
    expect(rows[0].n).toBeLessThanOrEqual(LIMITS.job.title);
  });

  it("accepts the most contacts we keep, even when they are as small as possible", async () => {
    const tiny: StoredContact[] = Array.from({ length: 2000 }, () => ({
      type: "email",
      value: "a@b.co",
      name: "",
      role: "",
    }));
    const wide = Array.from({ length: 2000 }, (_, i) => contact(i));
    for (const contacts of [tiny, wide]) {
      const row = toRow(fresh({ contacts }), USER);
      expect(JSON.stringify(row.contacts).length).toBeLessThanOrEqual(
        LIMITS.job.contactsJson * 0.8,
      );
      await insert(row);
    }
  });

  it("accepts a large analysis, and survives one built to be as spaced out as possible", async () => {
    const roomy = { ...analysis, verdict: "v".repeat(LIMITS.job.analysisJson * 0.8 - 1000) };
    const rowA = toRow(fresh({ analysis: roomy as never }), USER);
    expect(rowA).toHaveProperty("analysis");
    await insert(rowA);

    // Thousands of tiny values: Postgres prints this far longer than JSON.stringify.
    const spaced = { ...analysis, strengths: Array.from({ length: 15_000 }, () => 1) };
    const rowB = toRow(fresh({ analysis: spaced as never }), USER);
    expect(rowB).not.toHaveProperty("analysis"); // left out rather than risk the batch
    await insert(rowB);
  });

  it("is what makes a whole batch safe: one pathological job does not sink the others", async () => {
    // Insert all rows in ONE statement, as the sync's upsert does.
    const jobs = [
      fresh(),
      fresh({ notes: "n".repeat(90_000), title: "T".repeat(5000) }),
      fresh({ contacts: Array.from({ length: 900 }, (_, i) => contact(i)) }),
    ];
    const rows = jobs.map((j) => toRow(j, USER));
    await db.query(
      `insert into public.jobs (id, user_id, title, company, country, url, salary, status, notes, date_added, contacts)
       select r.id, r.user_id, r.title, r.company, r.country, r.url, r.salary, r.status, r.notes, r.date_added, r.contacts
         from jsonb_to_recordset($1::jsonb) as r(id uuid, user_id uuid, title text, company text, country text, url text, salary text, status text, notes text, date_added timestamptz, contacts jsonb)`,
      [JSON.stringify(rows)],
    );
  });

  it("understands the real error when an account is full (54000)", async () => {
    // A fresh account that already holds the maximum number of jobs.
    const other = "88888888-8888-4888-8888-888888888888";
    await db.query(
      `insert into public.jobs (id, user_id)
       select gen_random_uuid(), $1::uuid from generate_series(1, ${LIMITS.jobsPerUser})`,
      [other],
    );
    const refused = await failure(() =>
      db.query("insert into public.jobs (id, user_id) values (gen_random_uuid(), $1)", [other]),
    );
    expect(refused.code).toBe("54000");
    expect(describeLimitError(refused, "job")).toBe(
      `An account can keep at most ${LIMITS.jobsPerUser} jobs. Delete some to add more.`,
    );
  });

  it("understands the real error for a CV record that breaks a limit", async () => {
    const id = uuid();
    const refused = await failure(() =>
      db.query("insert into public.cvs (id, user_id, name, path) values ($1, $2, $3, $4)", [
        id,
        USER,
        "n".repeat(LIMITS.cv.name + 1),
        `${USER}/${id}`,
      ]),
    );
    expect(describeLimitError(refused, "cv-record")).toBe(
      `A CV's file name is too long (max ${LIMITS.cv.name} characters).`,
    );
    // A file bigger than the limit, with an otherwise valid record.
    const bigId = uuid();
    const tooBig = await failure(() =>
      db.query("insert into public.cvs (id, user_id, size, path) values ($1, $2, $3, $4)", [
        bigId,
        USER,
        LIMITS.cvRecordMaxBytes + 1,
        `${USER}/${bigId}`,
      ]),
    );
    expect(describeLimitError(tooBig, "cv-record")).toBe("A CV file is too large (max 10.0 MB).");
  });

  it("has a friendly message for every limit the migration defines", () => {
    const names = [...migration.matchAll(/\('(?:jobs|cvs)',\s*'((?:jobs|cvs)_\w+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(17);
    for (const name of names) {
      const table = name.startsWith("jobs") ? "jobs" : "cvs";
      const msg = describeLimitError(
        new PostgrestError({
          message: `new row for relation "${table}" violates check constraint "${name}"`,
          details: "",
          hint: "",
          code: "23514",
        }),
      );
      if (name === "cvs_path_shape") expect(msg, name).toBeNull();
      else expect(msg, name).toMatch(/max/);
    }
  });
});
