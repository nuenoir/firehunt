// lib/cvsRemote.ts
// Syncs CVs to Supabase: the file bytes go in the private "cvs" Storage bucket,
// and a row in the `cvs` table holds the details (name, role, size, path…).
// Row Level Security + the storage folder rules keep everything scoped to the
// signed-in user. Files are stored at "{userId}/{cvId}".

import { supabase } from "./supabase";
import type { CvRole } from "./cvs";
import { canonicalCvMime, clampCvForCloud } from "./limitGuards";

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
  // Lower-case on purpose: the database insists the saved path equals the user id and
  // CV id as it prints them (always lower-case), so an upper-case id — say from a
  // hand-edited backup — would otherwise store a file and then be refused its row.
  return `${userId.toLowerCase()}/${id.toLowerCase()}`;
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

/** Record a CV's details and upload its file to Storage. Returns the storage path.
 *  If the cloud refuses (a limit, a full folder…), the cloud's own error is thrown
 *  unchanged so the caller can explain it (see describeLimitError).
 *
 *  The details row is saved FIRST and the file second, because the storage rules only
 *  accept a file for a CV record that already exists (that is what caps the number of
 *  files: records are capped by the database). If the file is then refused, a record we
 *  just created is removed again, so the list never shows a CV whose file never arrived. */
export async function uploadRemoteCv(cv: {
  userId: string;
  id: string;
  name: string;
  role: CvRole;
  type: string;
  /** Ignored: the size recorded is the file's real size, not a number from the caller. */
  size?: number;
  dateAdded: string;
  blob: Blob;
}): Promise<string> {
  if (!supabase) throw new Error("Sync is not configured.");
  const path = cvStoragePath(cv.userId, cv.id);
  // The bucket only accepts PDF / DOC / DOCX, judged by the type the server sees. For a
  // Blob or File, supabase-js sends the Blob's OWN type and ignores the `contentType`
  // option — and browsers often report "" for Word files. So wrap the bytes in a Blob
  // that carries the type chosen from the file name.
  const mime =
    canonicalCvMime(cv.name) ?? (cv.blob.type || cv.type || "application/octet-stream");
  const typed = new Blob([cv.blob], { type: mime });

  // Is this a re-upload of a CV that already has a record? Then there is nothing to undo.
  const existing = await supabase.from("cvs").select("id").eq("id", cv.id).maybeSingle();
  const isNewRecord = !existing.error && !existing.data;

  const { error } = await supabase.from("cvs").upsert({
    id: cv.id,
    user_id: cv.userId,
    ...clampCvForCloud({ name: cv.name, role: cv.role, type: mime }),
    size: typed.size,
    date_added: cv.dateAdded,
    path,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;

  const up = await supabase.storage.from(BUCKET).upload(path, typed, {
    contentType: mime,
    upsert: true,
  });
  if (up.error) {
    if (isNewRecord) {
      // Best effort: if this fails too, the record is a harmless stray the user can delete.
      await supabase.from("cvs").delete().eq("id", cv.id).then(
        () => undefined,
        () => undefined,
      );
    }
    throw up.error;
  }
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
