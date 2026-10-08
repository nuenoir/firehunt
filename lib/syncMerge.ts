// lib/syncMerge.ts
// Pure rules for reconciling this device's copy with the cloud when a user signs in.
// No React, no network, no storage — so the tricky cases can be unit-tested.
//
// The old rule was: "anything on this device that the cloud lacks must be new, so
// upload it". That resurrects deleted data. Delete a job on your laptop, open the
// app on a phone that still has the old copy, and the phone re-uploads it.
//
// The fix is to remember which ids this device has ALREADY synced with the cloud.
// A local item the cloud lacks is then one of two things:
//   - never synced before  -> genuinely new here -> upload it
//   - synced before        -> it was deleted on another device -> drop it locally
// When there is no history at all (first sign-in on this device, or unreadable
// history) we fall back to the old rule, which can never lose data.

import type { Job } from "./jobs";

export interface MergePlan {
  /** What the board should show after the merge, newest first. */
  merged: Job[];
  /** Local jobs the cloud has never seen: upload these. */
  toUpload: Job[];
  /** Local jobs that were synced before but are gone from the cloud (deleted elsewhere). */
  droppedLocal: Job[];
}

/** Where a job exists in both places the cloud copy wins (last-write-wins). */
export function mergeOnSignIn(
  local: readonly Job[],
  remote: readonly Job[],
  known: ReadonlySet<string> | null,
): MergePlan {
  const remoteIds = new Set(remote.map((j) => j.id));
  const localOnly = local.filter((j) => !remoteIds.has(j.id));
  const wasSynced = (j: Job) => known !== null && known.has(j.id);

  const droppedLocal = localOnly.filter(wasSynced);
  const toUpload = localOnly.filter((j) => !wasSynced(j));
  const merged = [...remote, ...toUpload].sort((a, b) =>
    (b.dateAdded || "").localeCompare(a.dateAdded || ""),
  );
  return { merged, toUpload, droppedLocal };
}

export interface CvReconcilePlan {
  /** Local CV files the cloud has never seen: upload these. */
  uploadIds: string[];
  /** Local CV files that were synced before but are gone from the cloud: remove locally. */
  dropLocalIds: string[];
}

/** The same rule for CV files (which live in IndexedDB on this device). */
export function reconcileCvs(
  localIds: readonly string[],
  remoteIds: readonly string[],
  known: ReadonlySet<string> | null,
): CvReconcilePlan {
  const remote = new Set(remoteIds);
  const localOnly = localIds.filter((id) => !remote.has(id));
  const wasSynced = (id: string) => known !== null && known.has(id);
  return {
    uploadIds: localOnly.filter((id) => !wasSynced(id)),
    dropLocalIds: localOnly.filter(wasSynced),
  };
}
