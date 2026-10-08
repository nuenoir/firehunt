// Simulates two devices (say a laptop and a phone) sharing one cloud, to prove the
// sync behaves correctly across the situations that actually happen to real users.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "./jobs";
import {
  planIsEmpty,
  planPush,
  pushChanges,
  reconcileOnSignIn,
  snapshotJobs,
  type JobCloud,
  type KnownIdStore,
  type Snapshot,
} from "./syncEngine";
import { loadKnownIds, saveKnownIds } from "./syncKnown";
import { mergeOnSignIn, reconcileCvs } from "./syncMerge";

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  title: `Job ${id}`,
  company: "Acme",
  country: "Australia",
  url: "",
  salary: "",
  status: "interested",
  notes: "",
  dateAdded: "2026-10-01T00:00:00.000Z",
  ...over,
});

/** An in-memory stand-in for the Supabase jobs table. */
function makeCloud() {
  const rows = new Map<string, Job>();
  const calls = { upsert: 0, remove: 0 };
  let failNextUpsert = false;
  const api: JobCloud = {
    fetch: async () => [...rows.values()].map((j) => structuredClone(j)),
    upsert: async (jobs) => {
      calls.upsert++;
      if (failNextUpsert) {
        failNextUpsert = false;
        throw new Error("network down");
      }
      for (const j of jobs) rows.set(j.id, structuredClone(j));
    },
    remove: async (ids) => {
      calls.remove++;
      for (const id of ids) rows.delete(id);
    },
  };
  return { rows, calls, api, failNextUpsert: () => (failNextUpsert = true) };
}

/** One device: its own job list, sync history, and last-pushed snapshot. */
class Device {
  jobs: Job[] = [];
  known: Set<string> | null = null;
  lastPushed: Snapshot = new Map();
  readonly store: KnownIdStore = {
    load: () => this.known,
    save: (ids) => {
      this.known = new Set(ids);
    },
  };

  constructor(private readonly cloud: JobCloud) {}

  /** What happens each time the app opens while signed in. */
  async signIn() {
    const result = await reconcileOnSignIn(this.jobs, this.cloud, this.store);
    this.jobs = result.jobs;
    this.lastPushed = result.snapshot;
    return result;
  }

  /** What the push effect does after every change. */
  async sync() {
    const plan = planPush(this.jobs, this.lastPushed);
    if (planIsEmpty(plan)) return;
    this.lastPushed = await pushChanges(this.jobs, plan, this.cloud, this.store);
  }

  async add(j: Job) {
    this.jobs = [j, ...this.jobs];
    await this.sync();
  }
  async remove(id: string) {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    await this.sync();
  }
  async edit(id: string, patch: Partial<Job>) {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
    await this.sync();
  }
  /** A job created while offline: it exists here but was never pushed. */
  addWhileOffline(j: Job) {
    this.jobs = [j, ...this.jobs];
  }
  ids = () => this.jobs.map((j) => j.id).sort();
}

describe("two devices sharing one cloud", () => {
  it("shows a job added on one device after the other signs in", async () => {
    const cloud = makeCloud();
    const laptop = new Device(cloud.api);
    const phone = new Device(cloud.api);
    await laptop.signIn();
    await laptop.add(job("a"));

    await phone.signIn();
    expect(phone.ids()).toEqual(["a"]);
  });

  it("does NOT bring back a job that was deleted on another device", async () => {
    const cloud = makeCloud();
    const laptop = new Device(cloud.api);
    const phone = new Device(cloud.api);
    await laptop.signIn();
    await laptop.add(job("x"));
    await laptop.add(job("keep"));
    await phone.signIn(); // the phone now has both, and remembers having synced them

    await laptop.remove("x"); // deleted on the laptop...
    const result = await phone.signIn(); // ...then the phone's app is reopened

    expect(phone.ids()).toEqual(["keep"]);
    expect([...cloud.rows.keys()]).toEqual(["keep"]); // and the cloud never got it back
    expect(result.dropped.map((j) => j.id)).toEqual(["x"]);
  });

  it("with no sync history, falls back to the old behaviour of uploading it (never loses data)", async () => {
    const cloud = makeCloud();
    const laptop = new Device(cloud.api);
    await laptop.signIn();
    await laptop.add(job("x"));
    await laptop.remove("x"); // gone from the cloud

    // A device that holds a stale copy but has no record of ever syncing it.
    const stale = new Device(cloud.api);
    stale.jobs = [job("x")];
    await stale.signIn();

    expect(stale.ids()).toEqual(["x"]);
    expect([...cloud.rows.keys()]).toEqual(["x"]); // legacy rule: treated as new
  });

  it("uploads work created offline instead of mistaking it for a deletion", async () => {
    const cloud = makeCloud();
    const phone = new Device(cloud.api);
    await phone.signIn();
    await phone.add(job("old"));

    phone.addWhileOffline(job("fresh")); // never pushed, so not in the history
    await phone.signIn();

    expect(phone.ids()).toEqual(["fresh", "old"]);
    expect([...cloud.rows.keys()].sort()).toEqual(["fresh", "old"]);
  });

  it("carries edits from one device to the other (the cloud copy wins)", async () => {
    const cloud = makeCloud();
    const laptop = new Device(cloud.api);
    const phone = new Device(cloud.api);
    await laptop.signIn();
    await laptop.add(job("a", { status: "interested" }));
    await phone.signIn();

    await laptop.edit("a", { status: "interview", title: "Renamed" });
    await phone.signIn();

    expect(phone.jobs[0]).toMatchObject({ status: "interview", title: "Renamed" });
  });

  it("keeps independent additions made on both devices", async () => {
    const cloud = makeCloud();
    const laptop = new Device(cloud.api);
    const phone = new Device(cloud.api);
    await laptop.signIn();
    await phone.signIn();

    await laptop.add(job("p"));
    await phone.add(job("q"));
    await laptop.signIn();
    await phone.signIn();

    expect(laptop.ids()).toEqual(["p", "q"]);
    expect(phone.ids()).toEqual(["p", "q"]);
    expect([...cloud.rows.keys()].sort()).toEqual(["p", "q"]);
  });

  it("is idempotent: signing in again changes nothing and uploads nothing", async () => {
    const cloud = makeCloud();
    const laptop = new Device(cloud.api);
    await laptop.signIn();
    await laptop.add(job("a"));
    const before = cloud.calls.upsert;

    await laptop.signIn();
    await laptop.signIn();

    expect(cloud.calls.upsert).toBe(before);
    expect(laptop.ids()).toEqual(["a"]);
  });

  it("survives a failed push: history is untouched and the retry sends the same change", async () => {
    const cloud = makeCloud();
    const laptop = new Device(cloud.api);
    await laptop.signIn();
    await laptop.add(job("a"));
    const knownBefore = new Set(laptop.known);

    cloud.failNextUpsert();
    await expect(laptop.add(job("b"))).rejects.toThrow("network down");
    expect(laptop.known).toEqual(knownBefore); // 'b' not recorded as synced
    expect(cloud.rows.has("b")).toBe(false);

    await laptop.sync(); // retry: the same plan is still pending
    expect(cloud.rows.has("b")).toBe(true);
    expect(laptop.known?.has("b")).toBe(true);
  });
});

describe("planPush", () => {
  it("finds new, edited and removed jobs", () => {
    const before = [job("a"), job("b"), job("c")];
    const snapshot = snapshotJobs(before);
    const after = [job("a"), job("b", { title: "edited" }), job("d")];
    const plan = planPush(after, snapshot);
    expect(plan.toUpsert.map((j) => j.id).sort()).toEqual(["b", "d"]);
    expect(plan.toDelete).toEqual(["c"]);
  });

  it("is empty when nothing changed", () => {
    const jobs = [job("a"), job("b")];
    expect(planIsEmpty(planPush(jobs, snapshotJobs(jobs)))).toBe(true);
  });
});

describe("mergeOnSignIn", () => {
  it("sorts the merged list newest first", () => {
    const plan = mergeOnSignIn(
      [job("local", { dateAdded: "2026-10-05T00:00:00.000Z" })],
      [
        job("old", { dateAdded: "2026-09-01T00:00:00.000Z" }),
        job("new", { dateAdded: "2026-10-07T00:00:00.000Z" }),
      ],
      null,
    );
    expect(plan.merged.map((j) => j.id)).toEqual(["new", "local", "old"]);
  });

  it("lets the cloud copy win where a job exists in both places", () => {
    const plan = mergeOnSignIn(
      [job("a", { title: "local version" })],
      [job("a", { title: "cloud version" })],
      new Set(["a"]),
    );
    expect(plan.merged).toHaveLength(1);
    expect(plan.merged[0].title).toBe("cloud version");
    expect(plan.toUpload).toEqual([]);
  });
});

describe("reconcileCvs", () => {
  it("uploads CVs the cloud has never seen and drops ones deleted elsewhere", () => {
    const plan = reconcileCvs(["new", "deleted-elsewhere", "both"], ["both"], new Set(["deleted-elsewhere", "both"]));
    expect(plan.uploadIds).toEqual(["new"]);
    expect(plan.dropLocalIds).toEqual(["deleted-elsewhere"]);
  });

  it("with no history, uploads every local-only CV and drops none", () => {
    const plan = reconcileCvs(["a", "b"], [], null);
    expect(plan).toEqual({ uploadIds: ["a", "b"], dropLocalIds: [] });
  });
});

describe("known-id storage", () => {
  const fakeStorage = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips per user and kind", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    saveKnownIds("jobs", "alice", ["a", "b", "a"]);
    saveKnownIds("jobs", "bob", ["z"]);
    expect([...(loadKnownIds("jobs", "alice") ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(loadKnownIds("jobs", "bob") ?? [])]).toEqual(["z"]);
    expect(loadKnownIds("cvs", "alice")).toBeNull();
  });

  it("reads missing, corrupt or wrongly-shaped records as 'no history'", () => {
    const s = fakeStorage();
    vi.stubGlobal("localStorage", s);
    expect(loadKnownIds("jobs", "u")).toBeNull();
    s.data.set("firehunt.sync.known.jobs.u", "{not json");
    expect(loadKnownIds("jobs", "u")).toBeNull();
    s.data.set("firehunt.sync.known.jobs.u", JSON.stringify({ not: "an array" }));
    expect(loadKnownIds("jobs", "u")).toBeNull();
    s.data.set("firehunt.sync.known.jobs.u", JSON.stringify(["ok", 5, null]));
    expect([...(loadKnownIds("jobs", "u") ?? [])]).toEqual(["ok"]);
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    });
    expect(() => saveKnownIds("jobs", "u", ["a"])).not.toThrow();
    expect(loadKnownIds("jobs", "u")).toBeNull();
  });
});
