// lib/localOwnership.ts
// Pure rules for which account the jobs and CVs stored in THIS browser belong to.
//
// Why it matters: local storage is per browser, not per account. Without a record of
// whose data it is, signing in as a second person on a shared computer uploads the
// first person's jobs and CV files into the second person's account.
//
// The rule: data in the browser belongs to the account that last signed in (or to
// nobody, if it was created while signed out). Signing in as a DIFFERENT account
// clears it first; signing out clears it too (it stays safe in the cloud).

export type LocalOwner =
  | { kind: "none" } // created while signed out: it migrates into whoever signs in
  | { kind: "user"; id: string } // belongs to this account
  | { kind: "ambiguous" }; // several accounts have used this browser; can't tell whose

/** Work out the owner from the explicit marker, or — for browsers that last synced
 *  before the marker existed — from which accounts have a sync history here. */
export function inferLocalOwner(
  explicitOwnerId: string | null,
  accountsWithSyncHistory: readonly string[],
): LocalOwner {
  if (explicitOwnerId) return { kind: "user", id: explicitOwnerId };
  const accounts = [...new Set(accountsWithSyncHistory)];
  if (accounts.length === 0) return { kind: "none" };
  if (accounts.length === 1) return { kind: "user", id: accounts[0] };
  return { kind: "ambiguous" };
}

/** Must the browser's data be cleared BEFORE this account's sign-in syncs? */
export function mustWipeBeforeSignIn(
  owner: LocalOwner,
  signingInUserId: string,
): boolean {
  switch (owner.kind) {
    case "none":
      return false; // signed-out data migrates into the account, as designed
    case "user":
      return owner.id !== signingInUserId;
    case "ambiguous":
      return true; // privacy over convenience: the cloud copy is the safe source
  }
}

/** Should signing out clear the browser's data? Only data that belongs to an
 *  account: work done while signed out is the visitor's own and stays. */
export function shouldWipeOnSignOut(owner: LocalOwner): boolean {
  return owner.kind !== "none";
}
