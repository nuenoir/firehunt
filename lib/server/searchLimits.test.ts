import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: null as unknown,
}));

vi.mock("./admin", () => ({ getAdminClient: () => state.admin }));

import { SEARCH_LIMITS, enforceSearchLimits } from "./searchLimits";

/** A fake admin client whose rpc() counts hits like the hit_rate_limit SQL function. */
function counterAdmin() {
  const counts = new Map<string, number>();
  const admin = {
    rpc: async (_fn: string, args: { p_key: string; p_limit: number }) => {
      const n = (counts.get(args.p_key) ?? 0) + 1;
      counts.set(args.p_key, n);
      return { data: n <= args.p_limit, error: null };
    },
  };
  return { admin: admin as unknown as SupabaseClient, counts };
}

const fromIp = (ip: string) =>
  new Request("https://x.test/api/search", { headers: { "x-forwarded-for": ip } });

let counts: Map<string, number>;

beforeEach(() => {
  const c = counterAdmin();
  state.admin = c.admin;
  counts = c.counts;
});

describe("enforceSearchLimits", () => {
  it("lets a visitor search up to their personal limit, then refuses with a 429", async () => {
    const results = [];
    for (let i = 0; i < SEARCH_LIMITS.perIpPerMinute + 1; i++) {
      results.push(await enforceSearchLimits(fromIp("1.1.1.1"), "adzuna"));
    }
    expect(results.slice(0, SEARCH_LIMITS.perIpPerMinute).every((r) => r === null)).toBe(true);
    const blocked = results[SEARCH_LIMITS.perIpPerMinute] as Response;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect((await blocked.json()).error).toMatch(/Too many searches/);
  });

  it("keeps different visitors independent", async () => {
    for (let i = 0; i < SEARCH_LIMITS.perIpPerMinute; i++) {
      await enforceSearchLimits(fromIp("1.1.1.1"), "adzuna");
    }
    expect(await enforceSearchLimits(fromIp("2.2.2.2"), "adzuna")).toBeNull();
  });

  it("enforces the site-wide cap across many visitors, with a different message", async () => {
    const cap = SEARCH_LIMITS.siteWidePerMinute.adzuna;
    for (let i = 0; i < cap; i++) {
      expect(await enforceSearchLimits(fromIp(`10.0.0.${i}`), "adzuna")).toBeNull();
    }
    const blocked = (await enforceSearchLimits(fromIp("10.0.1.1"), "adzuna")) as Response;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("30");
    expect((await blocked.json()).error).toMatch(/busy/);
  });

  it("does not let a refused visitor use up the site-wide allowance", async () => {
    // One visitor hammers the endpoint far past their limit...
    for (let i = 0; i < SEARCH_LIMITS.perIpPerMinute + 10; i++) {
      await enforceSearchLimits(fromIp("9.9.9.9"), "adzuna");
    }
    // ...but only their allowed requests ever reached the shared counter.
    expect(counts.get("search:adzuna:site")).toBe(SEARCH_LIMITS.perIpPerMinute);
  });

  it("counts each upstream call of a fan-out search against the site-wide cap", async () => {
    // "All Gulf" makes six Jooble calls, so five of them use 30 units.
    for (let i = 0; i < 5; i++) {
      expect(await enforceSearchLimits(fromIp(`10.1.0.${i}`), "jooble", 6)).toBeNull();
    }
    expect(counts.get("search:jooble:site")).toBe(30);
    const blocked = (await enforceSearchLimits(fromIp("10.1.1.1"), "jooble", 6)) as Response;
    expect(blocked.status).toBe(429);
  });

  it("tracks Adzuna and Jooble site-wide allowances separately", async () => {
    for (let i = 0; i < SEARCH_LIMITS.siteWidePerMinute.adzuna; i++) {
      await enforceSearchLimits(fromIp(`10.2.0.${i}`), "adzuna");
    }
    expect(await enforceSearchLimits(fromIp("10.2.1.1"), "jooble")).toBeNull();
  });

  it("fails open (search keeps working) when the counter store is unavailable", async () => {
    state.admin = null;
    expect(await enforceSearchLimits(fromIp("1.1.1.1"), "adzuna")).toBeNull();
  });

  it("sets Adzuna's site-wide cap below the per-minute level where it was seen to cut off", () => {
    expect(SEARCH_LIMITS.siteWidePerMinute.adzuna).toBeLessThanOrEqual(20);
    expect(SEARCH_LIMITS.perIpPerMinute).toBeLessThan(SEARCH_LIMITS.siteWidePerMinute.adzuna);
  });
});
