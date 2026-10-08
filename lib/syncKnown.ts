// lib/syncKnown.ts
// BROWSER-ONLY. Remembers, per signed-in user, which ids this device has already
// synced with the cloud (see lib/syncMerge.ts for why). Stored in localStorage next
// to the data it describes, so the two are always lost together.
//
// A missing or unreadable record returns null, which the merge rules treat as "no
// history" and handle conservatively (upload, never delete).

export type SyncKind = "jobs" | "cvs";

const storageKey = (kind: SyncKind, userId: string) =>
  `firehunt.sync.known.${kind}.${userId}`;

export function loadKnownIds(kind: SyncKind, userId: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(storageKey(kind, userId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return null;
  }
}

export function saveKnownIds(
  kind: SyncKind,
  userId: string,
  ids: Iterable<string>,
): void {
  try {
    localStorage.setItem(
      storageKey(kind, userId),
      JSON.stringify([...new Set(ids)]),
    );
  } catch {
    // Storage full or blocked: we just lose the history, and the merge falls back
    // to its conservative no-history behaviour.
  }
}
