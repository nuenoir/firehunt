// lib/limitGuards.ts
// The app's side of the storage limits (numbers in lib/limits.ts, enforced for real
// by supabase/migrations/003_limits.sql).
//
// Two jobs:
//   1. Make sure an honest user's data always fits, by trimming text on its way to the
//      cloud — so one overlong note can never make the whole sync fail.
//   2. When the database does say no, turn its technical error into a sentence a
//      person can act on.
//
// Everything here is pure (no React, no browser APIs) and never throws, because it
// also runs on data that came out of localStorage or a hand-edited backup file, which
// can be missing fields or hold the wrong kinds of values.

import { CV_MIME_BY_EXTENSION, LIMIT_ERROR_CODE, LIMITS } from "./limits";
import { CV_ROLES, formatBytes, type CvRole } from "./cvs";
import { STATUSES, type Job, type JobStatus } from "./jobs";
import type { StoredContact } from "./contacts";
import type { StoredAnalysis } from "./ai/schemas";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Remove what Postgres cannot store: a NUL character is deleted and half an emoji (a
 * "lone surrogate", which a hand-edited file or a text cut in the wrong place can
 * leave behind) becomes the usual replacement character. Either one makes the database
 * reject the whole batch of jobs it arrives in, so no job could sync until it was
 * found. Text without them comes back untouched. A plain loop on purpose: it is easy
 * to check and avoids regular-expression features older browsers lack.
 */
export function cleanText(s: string): string {
  let out = "";
  let start = 0; // everything before this index has already been copied to `out`
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) {
      out += s.slice(start, i);
      start = i + 1;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // a proper pair: keep both halves
      } else {
        out += s.slice(start, i) + "�";
        start = i + 1;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += s.slice(start, i) + "�"; // a second half with no first half
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/**
 * Cut `value` down to at most `max` characters; anything that is not a string becomes
 * "". Postgres counts characters and JavaScript counts UTF-16 units (which is never
 * fewer), so cutting by JavaScript length is always safe. We never cut an emoji in
 * half: a lone half would be rejected by the database and wedge the whole sync.
 */
export function clampText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const value = cleanText(raw);
  const limit = max >= 0 ? Math.floor(max) : 0; // NaN and negatives count as 0
  if (value.length <= limit) return value;
  let end = limit;
  const last = end > 0 ? value.charCodeAt(end - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // first half of a pair: drop it
  return value.slice(0, end);
}

/** Like clampText, but keeps a file's ".pdf" / ".docx" ending when it has to shorten
 *  the name, so the downloaded file still opens in the right program. */
export function clampCvName(name: unknown, max: number = LIMITS.cv.name): string {
  const s = typeof name === "string" ? cleanText(name) : "";
  if (s.length <= max) return s;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
  if (!ext || ext.length >= max) return clampText(s, max);
  return clampText(s, max - ext.length) + ext;
}

/** A CV's text fields, trimmed to what the database accepts. */
export function clampCvForCloud<T extends { name: string; role: string; type: string }>(
  cv: T,
): T {
  return {
    ...cv,
    name: clampCvName(cv.name),
    role: clampText(cv.role, LIMITS.cv.role),
    type: clampText(cv.type, LIMITS.cv.type),
  };
}

// ---------------------------------------------------------------------------
// JSON columns (contacts, analysis)
// ---------------------------------------------------------------------------

// JSON text cannot be cut in the middle without breaking it, so a column that is too
// big loses whole entries (contacts) or is left out (analysis) instead. The database
// measures jsonb AFTER printing it with a space after every ":" and ",", which makes
// it longer than JSON.stringify's output. Staying under 80% of the cap, and also
// checking the spaced length exactly, keeps us clear of that.
const JSON_HEADROOM = 0.8;

/** How many spaces Postgres adds when it prints a JSON text as jsonb (one after every
 *  ":" or "," that is not inside a string). */
function jsonbExtraSpaces(json: string): number {
  let spaces = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    if (inString) {
      if (ch === 92) i++; // backslash: skip the escaped character
      else if (ch === 34) inString = false;
    } else if (ch === 34) {
      inString = true;
    } else if (ch === 44 || ch === 58) {
      spaces++;
    }
  }
  return spaces;
}

/**
 * A copy of a JSON-like value that Postgres will accept as jsonb: every string is
 * cleaned (see cleanText, keys included), a number that JSON.stringify prints short
 * but jsonb prints very long (1e300, 5e-324…) or that is not finite becomes 0, and
 * nesting deeper than any honest record is cut off. Ordinary values come back equal.
 */
function cleanJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return null;
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number") {
    const a = Math.abs(value);
    return Number.isFinite(value) && (a === 0 || (a >= 1e-6 && a < 1e21)) ? value : 0;
  }
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[cleanText(k)] = cleanJson(v, depth + 1);
    }
    return out;
  }
  return null; // functions, symbols, BigInt…
}

/** JSON size of a value, or null when it cannot be turned into JSON at all
 *  (circular references, BigInt…). */
function jsonSize(value: unknown): { chars: number; spaces: number } | null {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") return null;
    return { chars: json.length, spaces: jsonbExtraSpaces(json) };
  } catch {
    return null;
  }
}

function jsonFits(chars: number, spaces: number, cap: number): boolean {
  return chars <= cap * JSON_HEADROOM && chars + spaces <= cap;
}

/** Keep the first contacts that fit; drop the rest. Entries that are not contacts
 *  (null, wrong shape) are dropped too, because the UI would choke on them. */
function fitContacts(contacts: unknown): StoredContact[] | undefined {
  if (!Array.isArray(contacts)) return undefined;
  const cap = LIMITS.job.contactsJson;
  const kept: StoredContact[] = [];
  let chars = 2; // the [ and ]
  let spaces = 0;
  for (const raw of contacts) {
    if (
      !isRecord(raw) ||
      (raw.type !== "email" && raw.type !== "phone") ||
      typeof raw.value !== "string"
    ) {
      continue;
    }
    const entry = cleanJson({
      ...raw,
      type: raw.type,
      value: raw.value,
      name: typeof raw.name === "string" ? raw.name : "",
      role: typeof raw.role === "string" ? raw.role : "",
    }) as StoredContact;
    const size = jsonSize(entry);
    if (!size) continue;
    const comma = kept.length > 0 ? 1 : 0; // the comma between two entries
    if (!jsonFits(chars + size.chars + comma, spaces + size.spaces + comma, cap)) break;
    kept.push(entry);
    chars += size.chars + comma;
    spaces += size.spaces + comma;
  }
  return kept;
}

function fitAnalysis(analysis: unknown): StoredAnalysis | undefined {
  if (!isRecord(analysis)) return undefined;
  const cleaned = cleanJson(analysis);
  const size = jsonSize(cleaned);
  if (!size || !jsonFits(size.chars, size.spaces, LIMITS.job.analysisJson)) return undefined;
  return cleaned as StoredAnalysis;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * A copy of `job` that the database will accept: every text field cut to its limit,
 * contacts trimmed from the end until they fit, and the fit analysis left out if it is
 * too big. A job that is already within the limits comes back with identical values,
 * and clamping twice gives the same result as clamping once.
 */
export function clampJobForCloud(job: Job): Job {
  const j: Record<string, unknown> = isRecord(job) ? job : {};
  const max = LIMITS.job;
  const out: Job = {
    // The id and the added-date are not text limits: sent exactly as they are.
    id: j.id as string,
    title: clampText(j.title, max.title),
    company: clampText(j.company, max.company),
    country: clampText(j.country, max.country),
    url: clampText(j.url, max.url),
    salary: clampText(j.salary, max.salary),
    status: clampText(j.status, max.status) as JobStatus,
    notes: clampText(j.notes, max.notes),
    dateAdded: j.dateAdded as string,
  };
  if (typeof j.cvId === "string") out.cvId = clampText(j.cvId, max.cvId);
  if (typeof j.deadline === "string") out.deadline = clampText(j.deadline, max.date);
  if (typeof j.followUpDate === "string") {
    out.followUpDate = clampText(j.followUpDate, max.date);
  }
  const contacts = fitContacts(j.contacts);
  if (contacts) out.contacts = contacts;
  const analysis = fitAnalysis(j.analysis);
  if (analysis) out.analysis = analysis;
  return out;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATUS_IDS = new Set<string>(STATUSES.map((s) => s.id));

/** Does this look enough like a saved fit analysis for the analysis window to open it? */
function looksLikeAnalysis(a: unknown): boolean {
  return (
    isRecord(a) &&
    typeof a.fit_score === "number" &&
    Array.isArray(a.strengths) &&
    Array.isArray(a.gaps) &&
    Array.isArray(a.tailored_bullets) &&
    isRecord(a.outreach)
  );
}

/**
 * Turn the "jobs" list of a backup file into jobs the app can safely show and sync.
 * Entries that are not jobs at all (no id, repeated id) are skipped and counted;
 * a bad status or date is repaired rather than losing the job; text is cut to the
 * limits so a huge record cannot block cloud sync later.
 */
export function normalizeImportedJobs(
  raw: unknown,
  nowIso: string,
): { jobs: Job[]; skipped: number } {
  const jobs: Job[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    // A repeated id would make the cloud reject the whole upload. Postgres prints ids
    // in lower case, so "ABC…" and "abc…" are the same job there: compare that way and
    // store UUID-shaped ids in lower case.
    const key = isRecord(item) && typeof item.id === "string" ? item.id.toLowerCase() : "";
    if (!isRecord(item) || !key || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const clamped = clampJobForCloud({
      ...item,
      id: UUID_SHAPE.test(key) ? key : item.id,
      status: STATUS_IDS.has(item.status as string) ? item.status : "interested",
      dateAdded:
        typeof item.dateAdded === "string" && Number.isFinite(Date.parse(item.dateAdded))
          ? item.dateAdded
          : nowIso,
    } as unknown as Job);
    if (clamped.analysis && !looksLikeAnalysis(clamped.analysis)) delete clamped.analysis;
    jobs.push(clamped);
  }
  return { jobs, skipped };
}

// ---------------------------------------------------------------------------
// CV files
// ---------------------------------------------------------------------------

/** The file type the CV bucket expects for this file name (".pdf", ".doc", ".docx",
 *  any capitalisation), or null if it is not an accepted CV type. Judged from the
 *  name because browsers often report "" as the type of Word files. */
export function canonicalCvMime(fileName: unknown): string | null {
  if (typeof fileName !== "string") return null;
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = fileName.slice(dot).toLowerCase();
  return Object.prototype.hasOwnProperty.call(CV_MIME_BY_EXTENSION, ext)
    ? CV_MIME_BY_EXTENSION[ext as keyof typeof CV_MIME_BY_EXTENSION]
    : null;
}

/** Would the cloud accept this file? (Right type, and not over the size limit.) */
export function isCvUploadable(fileName: unknown, size: unknown): boolean {
  return (
    canonicalCvMime(fileName) !== null &&
    typeof size === "number" &&
    size >= 0 &&
    size <= LIMITS.cvFileBytes
  );
}

/** One CV from a backup file, checked enough to be saved without surprises; null when
 *  it is not a usable CV (no id or no file). The file itself is not judged here: CVs
 *  over the limit are kept on this device and simply not synced. */
export function normalizeImportedCv(
  raw: unknown,
  nowIso: string,
): {
  id: string;
  name: string;
  role: CvRole;
  type: string;
  size: number;
  dateAdded: string;
  dataUrl: string;
} | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.dataUrl !== "string" ||
    !raw.dataUrl
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name ? raw.name : "CV",
    role: CV_ROLES.some((r) => r.id === raw.role) ? (raw.role as CvRole) : "general",
    type: typeof raw.type === "string" ? raw.type : "",
    size: typeof raw.size === "number" && raw.size >= 0 ? raw.size : 0,
    dateAdded:
      typeof raw.dateAdded === "string" && Number.isFinite(Date.parse(raw.dateAdded))
        ? raw.dateAdded
        : nowIso,
    dataUrl: raw.dataUrl,
  };
}

// ---------------------------------------------------------------------------
// Explaining a refusal
// ---------------------------------------------------------------------------

/** Where the failed request was going, which decides how some errors are read. */
export type LimitContext = "job" | "cv-upload" | "cv-record";

const inThousands = (n: number) => n.toLocaleString("en-US");
const L = LIMITS;

// What to say when the database rejects a field, keyed by the CHECK constraint named in
// the error (they come from supabase/migrations/003_limits.sql). cvs_path_shape is not a
// limit on anything a person types, so it has no entry and is not explained.
const CHECK_MESSAGES: Record<string, string> = {
  jobs_title_len: `A job's title is too long (max ${inThousands(L.job.title)} characters).`,
  jobs_company_len: `A job's company name is too long (max ${inThousands(L.job.company)} characters).`,
  jobs_country_len: `A job's country is too long (max ${inThousands(L.job.country)} characters).`,
  jobs_url_len: `A job's link is too long (max ${inThousands(L.job.url)} characters).`,
  jobs_salary_len: `A job's salary is too long (max ${inThousands(L.job.salary)} characters).`,
  jobs_status_len: `A job's status is too long (max ${inThousands(L.job.status)} characters).`,
  jobs_notes_len: `A job's notes are too long (max ${inThousands(L.job.notes)} characters).`,
  jobs_deadline_len: `A job's deadline is too long (max ${inThousands(L.job.date)} characters).`,
  jobs_follow_up_len: `A job's follow-up date is too long (max ${inThousands(L.job.date)} characters).`,
  jobs_cv_id_len: `A job's attached-CV reference is too long (max ${inThousands(L.job.cvId)} characters).`,
  jobs_contacts_size: `A job's saved contacts take up too much space (max ${inThousands(L.job.contactsJson)} characters).`,
  jobs_analysis_size: `A job's saved fit analysis takes up too much space (max ${inThousands(L.job.analysisJson)} characters).`,
  cvs_name_len: `A CV's file name is too long (max ${inThousands(L.cv.name)} characters).`,
  cvs_role_len: `A CV's role tag is too long (max ${inThousands(L.cv.role)} characters).`,
  cvs_type_len: `A CV's file type is too long (max ${inThousands(L.cv.type)} characters).`,
  cvs_size_range: `A CV file is too large (max ${formatBytes(L.cvRecordMaxBytes)}).`,
};

/** Every HTTP-style number found in an error's `status` / `statusCode` (supabase-js
 *  storage errors carry both; the second is a string such as "413"). */
function httpCodes(e: Record<string, unknown>): number[] {
  const out: number[] = [];
  for (const v of [e.status, e.statusCode]) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}

function explain(err: unknown, context?: LimitContext): string | null {
  const e: Record<string, unknown> =
    typeof err === "string" ? { message: err } : isRecord(err) ? err : {};
  const message = typeof e.message === "string" ? e.message : "";
  const code = typeof e.code === "string" ? e.code : "";

  // 1) A row-count limit raised by our own database trigger. Its message is already
  //    written for people ("FireHunt limit: an account can keep at most 300 jobs…").
  //    A 54000 error without that prefix is some other Postgres limit, not ours.
  const ours = /FireHunt limit:\s*([\s\S]+)/i.exec(message);
  if (ours && (code === "" || code === LIMIT_ERROR_CODE)) {
    const text = ours[1].replace(/\s+/g, " ").trim().slice(0, 300);
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
  }

  // 2) A field that is too long: Postgres names the CHECK constraint that failed.
  const check = /violates check constraint "([^"]+)"/i.exec(message);
  if (check && (code === "" || code === "23514")) {
    return CHECK_MESSAGES[check[1]] ?? null;
  }

  // 3) File storage refusals. Only meaningful for a file upload (or when the caller
  //    doesn't say): a "too large" from a jobs request is a different problem.
  if (context === undefined || context === "cv-upload") {
    const codes = httpCodes(e);
    if (codes.includes(413)) {
      return `That file is larger than the ${formatBytes(L.cvFileBytes)} limit. Please upload a smaller CV.`;
    }
    if (codes.includes(415) || /mime/i.test(message)) {
      return "That file type isn't allowed. Only PDF, DOC and DOCX files can be uploaded.";
    }
    // Storage reports "not allowed" when the folder already holds the maximum number
    // of files; the same message can also mean an expired sign-in, hence "may have".
    if (
      context === "cv-upload" &&
      codes.includes(403) &&
      /row[\s-]level security/i.test(message)
    ) {
      return `Couldn't upload this CV. You may have reached the limit of ${L.cvFilesPerUser} CV files; delete some and try again.`;
    }
  }
  return null;
}

/**
 * A short plain-English sentence when `err` is recognisably the app's storage limits
 * saying no, otherwise null (so the caller keeps its own generic message). It reads
 * the errors the way supabase-js delivers them: a PostgREST/Postgres error with
 * `message` and `code`, or a storage error with `status` / `statusCode`.
 */
export function describeLimitError(err: unknown, context?: LimitContext): string | null {
  try {
    return explain(err, context);
  } catch {
    return null;
  }
}
