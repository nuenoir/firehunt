// lib/limits.ts
// Every size and count limit that protects the shared cloud, in one place.
//
// Why these exist: anyone can sign in with a magic link, and the browser talks to
// Supabase directly with a public key. Row-level security makes sure people can
// only touch their OWN rows, but says nothing about HOW MUCH they store — so a
// stranger could fill the free-tier database or file storage and take the app down
// for everyone, including the owner. The database enforces these limits itself
// (supabase/migrations/003_limits.sql is the authority); the app mirrors them so
// that an honest user is stopped with a clear message instead of a failed sync.
//
// KEEP IN STEP with 003_limits.sql: lib/server/limitsMigration.test.ts runs the real
// migration against a real Postgres and fails if any number here disagrees with it.

export const LIMITS = {
  /** Jobs one account may store. */
  jobsPerUser: 300,
  /** CV records (rows) one account may store. */
  cvsPerUser: 10,
  /** Files in the CV bucket per account. Higher than `cvsPerUser` so a half-finished
   *  upload that left an orphan file can't lock someone out. */
  cvFilesPerUser: 20,
  /** Largest CV file, in bytes. Enforced by the storage bucket on every new upload. */
  cvFileBytes: 5 * 1024 * 1024,
  /** Largest file SIZE a CV record may state. Kept at the old 10 MB limit on purpose: a
   *  CV saved before the limit was lowered must still be editable (changing its role tag
   *  re-checks the whole record). The bucket, not this number, stops big new files. */
  cvRecordMaxBytes: 10 * 1024 * 1024,

  /** Maximum lengths, in characters, of the fields on a job. */
  job: {
    title: 500,
    company: 500,
    country: 100,
    url: 2000,
    salary: 200,
    status: 30,
    /** Matches MAX_DESCRIPTION_CHARS: longer notes could not be AI-analysed anyway. */
    notes: 20_000,
    /** deadline and follow-up date (stored as YYYY-MM-DD text). */
    date: 40,
    cvId: 64,
    /** Size of the saved contacts, as JSON text. */
    contactsJson: 8_000,
    /** Size of the saved fit analysis, as JSON text. */
    analysisJson: 40_000,
  },

  /** Maximum lengths, in characters, of the fields on a CV record. */
  cv: {
    name: 300,
    role: 30,
    type: 150,
  },

  /** Largest request body the AI endpoints will read, in bytes. The biggest honest one
   *  is about 20,000 characters of text (at most ~80 KB even if every character took four
   *  bytes) plus a few short fields. */
  aiRequestBytes: 200_000,

  /** Public job-search endpoints. */
  search: {
    /** Keywords / city, in characters. */
    text: 200,
    /** Deepest results page we will request from a provider. */
    maxPage: 50,
  },
} as const;

/** File types the CV bucket accepts, and the extension each one belongs to. */
export const CV_MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export const CV_ALLOWED_MIME_TYPES: string[] = Object.values(CV_MIME_BY_EXTENSION);

/** Postgres error code the database uses when an account hits a count limit
 *  ("program_limit_exceeded"). The message after it is written for people. */
export const LIMIT_ERROR_CODE = "54000";
