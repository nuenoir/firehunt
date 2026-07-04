// lib/cvsRemote.ts
// Syncs CVs to Supabase: the file bytes go in the private "cvs" Storage bucket,
// and a row in the `cvs` table holds the details (name, role, size, path…).
// Row Level Security + the storage folder rules keep everything scoped to the
// signed-in user. Files are stored at "{userId}/{cvId}".

import { supabase } from "./supabase";
import type { CvRole } from "./cvs";

const BUCKET = "cvs";

export interface RemoteCv {
  id: string;
  name: string;
  role: CvRole;
  type: string;
  size: number;
  dateAdded: string;
  path: string;
}

interface CvRow {
  id: string;
  name: string;
  role: string;
  type: string;
  size: number;
  date_added: string;
  path: string;
}

export function cvStoragePath(userId: string, id: string): string {
  return `${userId}/${id}`;
}

/** Load the details of every CV belonging to the signed-in user (no file bytes). */
export async function fetchRemoteCvs(): Promise<RemoteCv[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("cvs").select("*");
  if (error) throw error;
  return (data as CvRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role as CvRole,
    type: r.type,
    size: r.size,
    dateAdded: r.date_added,
    path: r.path,
  }));
}

/** Upload a CV's file to Storage and record its details. Returns the storage path. */
export async function uploadRemoteCv(cv: {
  userId: string;
  id: string;
  name: string;
  role: CvRole;
  type: string;
  size: number;
  dateAdded: string;
  blob: Blob;
}): Promise<string> {
  if (!supabase) throw new Error("Sync is not configured.");
  const path = cvStoragePath(cv.userId, cv.id);
  const up = await supabase.storage.from(BUCKET).upload(path, cv.blob, {
    contentType: cv.type || "application/octet-stream",
    upsert: true,
  });
  if (up.error) throw up.error;
  const { error } = await supabase.from("cvs").upsert({
    id: cv.id,
    user_id: cv.userId,
    name: cv.name,
    role: cv.role,
    type: cv.type,
    size: cv.size,
    date_added: cv.dateAdded,
    path,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  return path;
}

/** Update just the role tag on a synced CV. */
export async function updateRemoteCvRole(id: string, role: CvRole): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from("cvs")
    .update({ role, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Delete a synced CV's file and its details row. */
export async function deleteRemoteCv(id: string, path: string): Promise<void> {
  if (!supabase) return;
  await supabase.storage.from(BUCKET).remove([path]);
  const { error } = await supabase.from("cvs").delete().eq("id", id);
  if (error) throw error;
}

/** Download a CV's file bytes from Storage. */
export async function downloadRemoteCv(path: string): Promise<Blob> {
  if (!supabase) throw new Error("Sync is not configured.");
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data;
}
