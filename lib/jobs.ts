// lib/jobs.ts
// The data types + pure helpers for the job tracker.
// No React and no browser APIs here — this file just describes the shape of
// the data and knows how to filter it. That keeps it easy to test and reuse.

// localStorage key where the job list is saved (shared with the backup tool).
export const JOBS_STORAGE_KEY = "firehunt.jobs.v1";

export type JobStatus =
  | "interested"
  | "applied"
  | "interview"
  | "offer"
  | "rejected";

export interface Job {
  id: string;
  title: string;
  company: string;
  country: string;
  url: string; // optional link to the posting ("" if none)
  salary: string; // optional, free text ("" if none)
  status: JobStatus;
  notes: string; // optional ("" if none)
  dateAdded: string; // ISO date string, e.g. "2026-07-02T..."
  cvId?: string; // id of the CV attached to this application (optional)
  deadline?: string; // application deadline, "YYYY-MM-DD" (optional)
  followUpDate?: string; // next planned follow-up, "YYYY-MM-DD" (optional)
}

export interface StatusMeta {
  id: JobStatus;
  label: string;
  /** Tailwind classes for the board column header / status pill. */
  accent: string;
}

// The application pipeline, in order. This list also drives the board columns.
export const STATUSES: StatusMeta[] = [
  {
    id: "interested",
    label: "Interested",
    accent: "text-sky-300 border-sky-400/30 bg-sky-400/10",
  },
  {
    id: "applied",
    label: "Applied",
    accent: "text-amber-300 border-amber-400/30 bg-amber-400/10",
  },
  {
    id: "interview",
    label: "Interview",
    accent: "text-violet-300 border-violet-400/30 bg-violet-400/10",
  },
  {
    id: "offer",
    label: "Offer",
    accent: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10",
  },
  {
    id: "rejected",
    label: "Rejected",
    accent: "text-zinc-400 border-zinc-500/30 bg-zinc-500/10",
  },
];

// Target markets first (Gulf, then the others you named), plus a catch-all.
export const COUNTRIES: string[] = [
  "United Arab Emirates",
  "Saudi Arabia",
  "Qatar",
  "Kuwait",
  "Bahrain",
  "Oman",
  "Australia",
  "Singapore",
  "Netherlands",
  "Germany",
  "Ireland",
  "United Kingdom",
  "Other",
];

export interface JobFilters {
  country: string; // "" means "all countries"
  query: string; // matches job title or company, case-insensitive
}

/** How urgent a "YYYY-MM-DD" date is relative to today (also "YYYY-MM-DD").
 *  Returns "" when there is no date. Pure so it's easy to test. */
export type DueStatus = "overdue" | "today" | "soon" | "later" | "";
export function dueStatus(
  dateIso: string | undefined,
  todayIso: string,
): DueStatus {
  if (!dateIso || !todayIso) return "";
  if (dateIso < todayIso) return "overdue";
  if (dateIso === todayIso) return "today";
  const days = Math.round(
    (new Date(`${dateIso}T00:00:00`).getTime() -
      new Date(`${todayIso}T00:00:00`).getTime()) /
      86_400_000,
  );
  return days <= 3 ? "soon" : "later";
}

/** True when a follow-up/deadline needs attention now (overdue, today, or soon). */
export function needsAttention(status: DueStatus): boolean {
  return status === "overdue" || status === "today" || status === "soon";
}

export interface JobStats {
  total: number;
  byStatus: Record<JobStatus, number>;
  appliedOrBeyond: number; // jobs you actually applied to (applied → rejected)
  responses: number; // interviews + offers
  responseRate: number; // responses / appliedOrBeyond, 0..1 (0 when none applied)
}

/** Summarise a job list for the dashboard. Pure — no side effects. */
export function jobStats(jobs: Job[]): JobStats {
  const byStatus: Record<JobStatus, number> = {
    interested: 0,
    applied: 0,
    interview: 0,
    offer: 0,
    rejected: 0,
  };
  for (const j of jobs) byStatus[j.status] += 1;
  const appliedOrBeyond =
    byStatus.applied + byStatus.interview + byStatus.offer + byStatus.rejected;
  const responses = byStatus.interview + byStatus.offer;
  const responseRate = appliedOrBeyond > 0 ? responses / appliedOrBeyond : 0;
  return { total: jobs.length, byStatus, appliedOrBeyond, responses, responseRate };
}

/** Return only the jobs that match the given filters. Pure — no side effects. */
export function filterJobs(jobs: Job[], filters: JobFilters): Job[] {
  const q = filters.query.trim().toLowerCase();
  return jobs.filter((job) => {
    if (filters.country && job.country !== filters.country) return false;
    if (q) {
      const haystack = `${job.title} ${job.company}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
