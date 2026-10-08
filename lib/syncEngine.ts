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
}

/** Run on sign-in: reconcile this device's jobs with the cloud and remember the result. */
export async function reconcileOnSignIn(
  local: readonly Job[],
  cloud: JobCloud,
  known: KnownIdStore,
): Promise<SignInResult> {
  const remote = await cloud.fetch();
  const plan = mergeOnSignIn(local, remote, known.load());
  if (plan.toUpload.length > 0) await cloud.upsert(plan.toUpload);
  known.save(plan.merged.map((j) => j.id));
  return {
    jobs: plan.merged,
    dropped: plan.droppedLocal,
    snapshot: snapshotJobs(plan.merged),
  };
}

/** Push a plan to the cloud. Throws if the cloud rejects it, leaving the history
 *  untouched so the next attempt retries the same changes. */
export async function pushChanges(
  jobs: readonly Job[],
  plan: PushPlan,
  cloud: JobCloud,
  known: KnownIdStore,
): Promise<Snapshot> {
  if (plan.toUpsert.length > 0) await cloud.upsert(plan.toUpsert);
  if (plan.toDelete.length > 0) await cloud.remove(plan.toDelete);
  known.save(jobs.map((j) => j.id));
  return snapshotJobs(jobs);
}
