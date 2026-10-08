// lib/localData.ts
// BROWSER-ONLY. Records which account the jobs and CV files in this browser belong
// to, and clears them when they must not carry over (see lib/localOwnership.ts for
// the rules and the reasoning).
//
// Every code path that could upload local data to an account — the jobs sync and the
// CV sync — must first `await ensureLocalDataOwner(userId)`. The check is memoised
// per user, so both callers share one run and can never race each other.

import { clearAllCvs } from "./cvStore";
import { JOBS_STORAGE_KEY } from "./jobs";
import {
  inferLocalOwner,
  mustWipeBeforeSignIn,
  type LocalOwner,
} from "./localOwnership";

const OWNER_KEY = "firehunt.local.owner";
/** Stored as the owner when several accounts used the browser: it matches no real
 *  user id, so every account is treated as a newcomer and the data is cleared. */
const AMBIGUOUS_OWNER = "__ambiguous__";
const KNOWN_KEY = /^firehunt\.sync\.known\.(?:jobs|cvs)\.(.+)$/;

function allStorageKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

/** Accounts that have a sync history on this browser. */
function accountsWithSyncHistory(): string[] {
  const ids: string[] = [];
  for (const k of allStorageKeys()) {
    const m = KNOWN_KEY.exec(k);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export function readLocalOwner(): LocalOwner {
  try {
    return inferLocalOwner(localStorage.getItem(OWNER_KEY), accountsWithSyncHistory());
  } catch {
    // Can't read storage: treat as unknown so nothing is carried between accounts.
    return { kind: "ambiguous" };
  }
}

export function setLocalOwner(userId: string): void {
  try {
    localStorage.setItem(OWNER_KEY, userId);
  } catch {
    /* storage blocked: ownership can't be recorded, and inference takes over */
  }
}

/** Remove this account's data from the browser: the job list, the CV files, the
 *  sync histories and the owner marker. Notes that were never tied to an account
 *  (Insights) are deliberately left alone. Throws if the CV files couldn't be
 *  cleared, so callers fail closed rather than carry them into another account. */
export async function wipeLocalAccountData(): Promise<void> {
  // Pin down who the data belongs to BEFORE removing the evidence (an older browser
  // only has an inferred owner, derived from the sync histories deleted below). If
  // the CV clear then fails, the next attempt still knows to try again, instead of
  // mistaking the leftover CV files for signed-out work that may migrate.
  const owner = readLocalOwner();
  if (owner.kind === "user") setLocalOwner(owner.id);
  else if (owner.kind === "ambiguous") setLocalOwner(AMBIGUOUS_OWNER);

  try {
    const keys = allStorageKeys();
    localStorage.removeItem(JOBS_STORAGE_KEY);
    for (const k of keys) if (KNOWN_KEY.test(k)) localStorage.removeItem(k);
  } catch {
    /* fall through to the CV clear, which is the one that must not be skipped */
  }

  await clearAllCvs(); // throws on failure: the owner marker below is then kept

  try {
    localStorage.removeItem(OWNER_KEY);
  } catch {
    /* nothing more to do */
  }
  resetOwnerCheck();
  if (typeof window !== "undefined") {
    // Lets any open screen (e.g. the CV list) drop what it is showing.
    window.dispatchEvent(new Event("firehunt:wiped"));
  }
}

export interface OwnerCheck {
  /** True if this browser's old data was cleared because it belonged to someone else. */
  wiped: boolean;
}

let cached: { userId: string; promise: Promise<OwnerCheck> } | null = null;

/** Run once per sign-in, before anything syncs: clear another account's leftovers,
 *  then record that the data here now belongs to `userId`. */
export function ensureLocalDataOwner(userId: string): Promise<OwnerCheck> {
  if (cached?.userId === userId) return cached.promise;
  const promise = (async (): Promise<OwnerCheck> => {
    const wipe = mustWipeBeforeSignIn(readLocalOwner(), userId);
    if (wipe) await wipeLocalAccountData();
    setLocalOwner(userId);
    return { wiped: wipe };
  })();
  cached = { userId, promise };
  // If it failed, allow a later attempt to retry instead of caching the failure.
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}

export function resetOwnerCheck(): void {
  cached = null;
}
