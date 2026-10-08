// Exercises the browser-side ownership code against a fake localStorage and a fake
// CV store, including the end-to-end shared-browser scenario that used to leak.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cv = vi.hoisted(() => ({ clearAllCvs: vi.fn(async () => {}) }));
vi.mock("./cvStore", () => cv);

import type { Job } from "./jobs";
import {
  ensureLocalDataOwner,
  readLocalOwner,
  resetOwnerCheck,
  setLocalOwner,
  wipeLocalAccountData,
} from "./localData";
import { reconcileOnSignIn, type JobCloud } from "./syncEngine";
import { loadKnownIds, saveKnownIds } from "./syncKnown";

/** A minimal localStorage, including key()/length which the code enumerates. */
function fakeStorage() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const JOBS_KEY = "firehunt.jobs.v1";
const job = (id: string): Job => ({
  id,
  title: `Job ${id}`,
  company: "Acme",
  country: "Australia",
  url: "",
  salary: "",
  status: "interested",
  notes: "",
  dateAdded: "2026-10-01T00:00:00.000Z",
});

let storage: ReturnType<typeof fakeStorage>;
let wipedEvents: number;

beforeEach(() => {
  storage = fakeStorage();
  wipedEvents = 0;
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { dispatchEvent: () => void wipedEvents++ });
  cv.clearAllCvs.mockClear();
  cv.clearAllCvs.mockResolvedValue(undefined);
  resetOwnerCheck();
});
afterEach(() => vi.unstubAllGlobals());

describe("readLocalOwner / setLocalOwner", () => {
  it("is 'none' on a fresh browser", () => {
    expect(readLocalOwner()).toEqual({ kind: "none" });
  });

  it("reads back the recorded owner", () => {
    setLocalOwner("alice");
    expect(readLocalOwner()).toEqual({ kind: "user", id: "alice" });
  });

  it("infers the owner of an older browser from its sync history", () => {
    saveKnownIds("jobs", "alice", ["a"]);
    expect(readLocalOwner()).toEqual({ kind: "user", id: "alice" });
    saveKnownIds("cvs", "bob", ["b"]);
    expect(readLocalOwner()).toEqual({ kind: "ambiguous" });
  });

  it("treats unreadable storage as ambiguous (fail closed)", () => {
    vi.stubGlobal("localStorage", {
      get length(): number {
        throw new Error("blocked");
      },
      key: () => null,
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readLocalOwner()).toEqual({ kind: "ambiguous" });
  });
});

describe("wipeLocalAccountData", () => {
  it("removes the jobs, histories, owner marker and CV files — but not unrelated notes", async () => {
    storage.setItem(JOBS_KEY, JSON.stringify([job("a")]));
    setLocalOwner("alice");
    saveKnownIds("jobs", "alice", ["a"]);
    saveKnownIds("cvs", "alice", ["c"]);
    storage.setItem("firehunt.insights.v1", "company notes");

    await wipeLocalAccountData();

    expect(storage.getItem(JOBS_KEY)).toBeNull();
    expect(storage.getItem("firehunt.local.owner")).toBeNull();
    expect(loadKnownIds("jobs", "alice")).toBeNull();
    expect(loadKnownIds("cvs", "alice")).toBeNull();
    expect(cv.clearAllCvs).toHaveBeenCalledTimes(1);
    expect(storage.getItem("firehunt.insights.v1")).toBe("company notes");
    expect(wipedEvents).toBe(1);
  });

  it("fails closed: clears the job data, reports the CV failure, and KEEPS the owner so a retry still wipes", async () => {
    setLocalOwner("alice");
    storage.setItem(JOBS_KEY, JSON.stringify([job("a")]));
    cv.clearAllCvs.mockRejectedValue(new Error("IndexedDB blocked"));

    await expect(wipeLocalAccountData()).rejects.toThrow("IndexedDB blocked");

    expect(storage.getItem(JOBS_KEY)).toBeNull();
    expect(readLocalOwner()).toEqual({ kind: "user", id: "alice" }); // leftovers are still Alice's
  });

  it("fails closed for an older browser too: the inferred owner is written down before the evidence is deleted", async () => {
    saveKnownIds("jobs", "alice", ["a"]); // no explicit marker, only a sync history
    cv.clearAllCvs.mockRejectedValue(new Error("IndexedDB blocked"));

    await expect(wipeLocalAccountData()).rejects.toThrow();

    expect(loadKnownIds("jobs", "alice")).toBeNull(); // the history is gone...
    expect(readLocalOwner()).toEqual({ kind: "user", id: "alice" }); // ...but the owner is not forgotten
  });

  it("remembers an ambiguous owner across a failed wipe, so every account still triggers a clear", async () => {
    saveKnownIds("jobs", "alice", ["a"]);
    saveKnownIds("jobs", "bob", ["b"]);
    cv.clearAllCvs.mockRejectedValue(new Error("blocked"));
    await expect(wipeLocalAccountData()).rejects.toThrow();

    cv.clearAllCvs.mockResolvedValue(undefined);
    expect((await ensureLocalDataOwner("carol")).wiped).toBe(true);
  });
});

describe("ensureLocalDataOwner", () => {
  it("lets work done while signed out migrate into the account, and records the owner", async () => {
    storage.setItem(JOBS_KEY, JSON.stringify([job("a")]));
    const result = await ensureLocalDataOwner("alice");
    expect(result.wiped).toBe(false);
    expect(storage.getItem(JOBS_KEY)).not.toBeNull();
    expect(readLocalOwner()).toEqual({ kind: "user", id: "alice" });
  });

  it("keeps the data when the same account signs back in", async () => {
    setLocalOwner("alice");
    storage.setItem(JOBS_KEY, JSON.stringify([job("a")]));
    expect((await ensureLocalDataOwner("alice")).wiped).toBe(false);
    expect(cv.clearAllCvs).not.toHaveBeenCalled();
  });

  it("clears another account's data before the new account syncs", async () => {
    setLocalOwner("alice");
    storage.setItem(JOBS_KEY, JSON.stringify([job("alices-job")]));
    saveKnownIds("jobs", "alice", ["alices-job"]);

    const result = await ensureLocalDataOwner("bob");

    expect(result.wiped).toBe(true);
    expect(storage.getItem(JOBS_KEY)).toBeNull();
    expect(cv.clearAllCvs).toHaveBeenCalledTimes(1);
    expect(readLocalOwner()).toEqual({ kind: "user", id: "bob" });
  });

  it("recognises an older browser's owner from sync history and clears it for someone else", async () => {
    saveKnownIds("jobs", "alice", ["a"]); // no owner marker: the pre-fix situation
    storage.setItem(JOBS_KEY, JSON.stringify([job("a")]));
    expect((await ensureLocalDataOwner("bob")).wiped).toBe(true);
  });

  it("runs only once per user: concurrent callers share one result (jobs sync + CV sync)", async () => {
    setLocalOwner("alice");
    const [a, b] = await Promise.all([
      ensureLocalDataOwner("bob"),
      ensureLocalDataOwner("bob"),
    ]);
    expect(a).toBe(b);
    expect(cv.clearAllCvs).toHaveBeenCalledTimes(1);
  });

  it("allows a retry after a failure instead of caching it", async () => {
    setLocalOwner("alice");
    cv.clearAllCvs.mockRejectedValueOnce(new Error("blocked"));
    await expect(ensureLocalDataOwner("bob")).rejects.toThrow("blocked");
    cv.clearAllCvs.mockResolvedValue(undefined);
    expect((await ensureLocalDataOwner("bob")).wiped).toBe(true);
  });
});

describe("the shared-browser scenario that used to leak", () => {
  /** An in-memory cloud with one jobs table per account. */
  function cloudFor(rows: Map<string, Job>): JobCloud {
    return {
      fetch: async () => [...rows.values()],
      upsert: async (jobs) => void jobs.forEach((j) => rows.set(j.id, j)),
      remove: async (ids) => void ids.forEach((id) => rows.delete(id)),
    };
  }

  async function signInOnThisBrowser(userId: string, rows: Map<string, Job>) {
    const check = await ensureLocalDataOwner(userId);
    const local: Job[] = check.wiped ? [] : JSON.parse(storage.getItem(JOBS_KEY) ?? "[]");
    const result = await reconcileOnSignIn(local, cloudFor(rows), {
      load: () => loadKnownIds("jobs", userId),
      save: (ids) => saveKnownIds("jobs", userId, ids),
    });
    storage.setItem(JOBS_KEY, JSON.stringify(result.jobs));
    return result;
  }

  it("does not upload Alice's jobs into Bob's account when Bob signs in on the same browser", async () => {
    const alicesCloud = new Map<string, Job>();
    const bobsCloud = new Map<string, Job>();

    // Alice uses the browser: her jobs sync and are saved locally.
    alicesCloud.set("alice-1", job("alice-1"));
    alicesCloud.set("alice-2", job("alice-2"));
    await signInOnThisBrowser("alice", alicesCloud);
    expect(JSON.parse(storage.getItem(JOBS_KEY) ?? "[]")).toHaveLength(2);

    // She leaves WITHOUT signing out; Bob signs in on the same browser.
    const result = await signInOnThisBrowser("bob", bobsCloud);

    expect([...bobsCloud.keys()]).toEqual([]); // nothing of Alice's reached Bob's account
    expect(result.jobs).toEqual([]); // and Bob doesn't see her jobs
    expect([...alicesCloud.keys()].sort()).toEqual(["alice-1", "alice-2"]); // hers are untouched
  });

  it("(for contrast) skipping the ownership check is exactly what leaked", async () => {
    const alicesCloud = new Map<string, Job>([["alice-1", job("alice-1")]]);
    const bobsCloud = new Map<string, Job>();
    await signInOnThisBrowser("alice", alicesCloud);

    // The old behaviour: no ownership check, Bob's sync just merges whatever is local.
    const local: Job[] = JSON.parse(storage.getItem(JOBS_KEY) ?? "[]");
    await reconcileOnSignIn(local, cloudFor(bobsCloud), { load: () => null, save: () => {} });

    expect([...bobsCloud.keys()]).toEqual(["alice-1"]); // the leak
  });
});
