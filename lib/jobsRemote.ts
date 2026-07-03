// lib/jobsRemote.ts
// Reads/writes jobs to the Supabase `jobs` table. Row Level Security means every
// query is automatically scoped to the signed-in user — we never filter by user
// ourselves. Column names are snake_case in the DB, camelCase in the app, so we
// translate in one place here.

import type { Job, JobStatus } from "./jobs";
import { supabase } from "./supabase";

interface JobRow {
  id: string;
  title: string;
  company: string;
  country: string;
  url: string;
  salary: string;
  status: string;
  notes: string;
  date_added: string;
  deadline: string | null;
  follow_up_date: string | null;
  cv_id: string | null;
}

function fromRow(r: JobRow): Job {
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    country: r.country,
    url: r.url,
    salary: r.salary,
    status: r.status as JobStatus,
    notes: r.notes,
    dateAdded: r.date_added,
    deadline: r.deadline ?? undefined,
    followUpDate: r.follow_up_date ?? undefined,
    cvId: r.cv_id ?? undefined,
  };
}

function toRow(j: Job, userId: string) {
  return {
    id: j.id,
    user_id: userId,
    title: j.title,
    company: j.company,
    country: j.country,
    url: j.url,
    salary: j.salary,
    status: j.status,
    notes: j.notes,
    date_added: j.dateAdded,
    deadline: j.deadline ?? null,
    follow_up_date: j.followUpDate ?? null,
    cv_id: j.cvId ?? null,
    updated_at: new Date().toISOString(),
  };
}

/** Load every job belonging to the signed-in user. */
export async function fetchRemoteJobs(): Promise<Job[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("jobs").select("*");
  if (error) throw error;
  return (data as JobRow[]).map(fromRow);
}

/** Insert or update the given jobs (matched by id). */
export async function upsertRemoteJobs(jobs: Job[], userId: string): Promise<void> {
  if (!supabase || jobs.length === 0) return;
  const { error } = await supabase
    .from("jobs")
    .upsert(jobs.map((j) => toRow(j, userId)));
  if (error) throw error;
}

/** Delete jobs by id. */
export async function deleteRemoteJobs(ids: string[]): Promise<void> {
  if (!supabase || ids.length === 0) return;
  const { error } = await supabase.from("jobs").delete().in("id", ids);
  if (error) throw error;
}
