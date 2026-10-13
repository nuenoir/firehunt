// lib/syncEngine.ts
// The job-sync orchestration, with the cloud and the "known ids" store passed in as
// plain objects. The UI calls these with the real Supabase layer; the tests call
// them with in-memory fakes, which lets us simulate two devices sharing one cloud.

import type { Job } from "./jobs";
import { mergeOnSignIn } from "./syncMerge";

export interface JobCloud {
  fetch(): Promise<Job[]>;
  upsert(jobs: Job[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

export interface KnownIdStore {
  load(): Set<string> | null;
  save(ids: Iterable<string>): void;
}

/** id -> JSON of each job as last pushed, used to spot edits and deletions. */
export type Snapshot = Map<string, string>;

export function snapshotJobs(jobs: readonly Job[]): Snapshot {
  return new Map(jobs.map((j) => [j.id, JSON.stringify(j)]));
}

export interface PushPlan {
  toUpsert: Job[];
  toDelete: string[];
}

/** What changed since the last push: new or edited jobs, and removed ones. */
export function planPush(jobs: readonly Job[], lastPushed: ReadonlyMap<string, string>): PushPlan {
  const currentIds = new Set(jobs.map((j) => j.id));
  return {
    toUpsert: jobs.filter((j) => lastPushed.get(j.id) !== JSON.stringify(j)),
    toDelete: [...lastPushed.keys()].filter((id) => !currentIds.has(id)),
  };
}

export const planIsEmpty = (plan: PushPlan) =>
  plan.toUpsert.length === 0 && plan.toDelete.length === 0;

export interface SignInResult {
  jobs: Job[];
  /** Local jobs removed because they were deleted on another device. */
  dropped: Job[];
  snapshot: Snapshot;
  /** Set when this device's own jobs could not be uploaded (for example the account is
   *  at its job limit). The board is still returned in full; those jobs just stay
   *  unsynced and are retried with the next change. */
  uploadError?: unknown;
}

/** Run on sign-in: reconcile this device's jobs with the cloud and remember the result. */
export async function reconcileOnSignIn(
  local: readonly Job[],
  cloud: JobCloud,
  known: KnownIdStore,
): Promise<SignInResult> {
  const remote = await cloud.fetch();
  const plan = mergeOnSignIn(local, remote, known.load());
  // If the cloud refuses the upload (say the account is full), do NOT throw: the cloud
  // jobs were fetched fine and must still be shown, or the user would see only this
  // device's jobs and sync would stay switched off. Jobs that did not go up are left out
  // of the history, so the next push tries them again.
  let uploadError: unknown;
  let notUploaded = new Set<string>();
  if (plan.toUpload.length > 0) {
    try {
      await cloud.upsert(plan.toUpload);
    } catch (err) {
      uploadError = err;
      notUploaded = new Set(plan.toUpload.map((j) => j.id));
    }
  }
  const synced = plan.merged.filter((j) => !notUploaded.has(j.id));
  known.save(synced.map((j) => j.id));
  return {
    jobs: plan.merged,
    dropped: plan.droppedLocal,
    snapshot: snapshotJobs(synced),
    ...(uploadError !== undefined ? { uploadError } : {}),
  };
}

/** Push a plan to the cloud. Throws if the cloud rejects it, leaving the history
 *  untouched so the next attempt retries the same changes.
 *
 *  Deletes go FIRST: they only ever free room, and they are safe to repeat. If the
 *  upsert went first and the account was at its job limit, it would be refused before
 *  the deletes were sent, so deleting jobs in the app could never make space. */
export async function pushChanges(
  jobs: readonly Job[],
  plan: PushPlan,
  cloud: JobCloud,
  known: KnownIdStore,
): Promise<Snapshot> {
  if (plan.toDelete.length > 0) await cloud.remove(plan.toDelete);
  if (plan.toUpsert.length > 0) await cloud.upsert(plan.toUpsert);
  known.save(jobs.map((j) => j.id));
  return snapshotJobs(jobs);
}
