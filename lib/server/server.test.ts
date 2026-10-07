// Tests for the small server helpers: rate limiting, the AI spend cap, and owner
// resolution. They use hand-written fakes of the Supabase client, so no network.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, clientIp, tooManyRequests } from "./rateLimit";
import { consumeAiQuota } from "./aiQuota";
import { resolveOwnerId } from "./owner";

afterEach(() => vi.unstubAllEnvs());

/** A fake admin client whose rpc() behaves like the hit_rate_limit SQL function. */
function counterAdmin(failWith?: "error" | "throw") {
  const counts = new Map<string, number>();
  const admin = {
    rpc: async (
      _fn: string,
      args: { p_key: string; p_limit: number },
    ): Promise<{ data: boolean | null; error: { message: string } | null }> => {
      if (failWith === "throw") throw new Error("network down");
      if (failWith === "error") return { data: null, error: { message: "boom" } };
      const n = (counts.get(args.p_key) ?? 0) + 1;
      counts.set(args.p_key, n);
      return { data: n <= args.p_limit, error: null };
    },
  };
  return { admin: admin as unknown as SupabaseClient, counts };
}

describe("checkRateLimit", () => {
  it("allows hits up to the limit, then blocks", async () => {
    const { admin } = counterAdmin();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await checkRateLimit(admin, "k", 60, 3, "deny"));
    }
    expect(results).toEqual([true, true, true, false]);
  });

  it("fails open or closed according to policy when the store is unreachable", async () => {
    for (const mode of ["error", "throw"] as const) {
      const { admin } = counterAdmin(mode);
      expect(await checkRateLimit(admin, "k", 60, 3, "allow")).toBe(true);
      expect(await checkRateLimit(admin, "k", 60, 3, "deny")).toBe(false);
    }
    expect(await checkRateLimit(null, "k", 60, 3, "allow")).toBe(true);
    expect(await checkRateLimit(null, "k", 60, 3, "deny")).toBe(false);
  });
});

describe("clientIp / tooManyRequests", () => {
  it("takes the first address from x-forwarded-for", () => {
    const req = new Request("https://x.test", {
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back gracefully with no proxy headers", () => {
    expect(clientIp(new Request("https://x.test"))).toBe("unknown");
  });

  it("builds a 429 with a Retry-After header", async () => {
    const res = tooManyRequests("slow down", 60);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "slow down" });
  });
});

describe("consumeAiQuota", () => {
  it("caps each user per day, independently of other users", async () => {
    vi.stubEnv("AI_DAILY_LIMIT_PER_USER", "2");
    vi.stubEnv("AI_DAILY_LIMIT_GLOBAL", "100");
    const { admin } = counterAdmin();
    expect(await consumeAiQuota(admin, "alice")).toEqual({ ok: true });
    expect(await consumeAiQuota(admin, "alice")).toEqual({ ok: true });
    expect(await consumeAiQuota(admin, "alice")).toEqual({ ok: false, scope: "user" });
    expect(await consumeAiQuota(admin, "bob")).toEqual({ ok: true });
  });

  it("enforces a global daily cap across all users", async () => {
    vi.stubEnv("AI_DAILY_LIMIT_PER_USER", "10");
    vi.stubEnv("AI_DAILY_LIMIT_GLOBAL", "2");
    const { admin } = counterAdmin();
    expect((await consumeAiQuota(admin, "a")).ok).toBe(true);
    expect((await consumeAiQuota(admin, "b")).ok).toBe(true);
    expect(await consumeAiQuota(admin, "c")).toEqual({ ok: false, scope: "global" });
  });

  it("fails CLOSED: no paid call is allowed when the counter store is down", async () => {
    const { admin } = counterAdmin("error");
    expect(await consumeAiQuota(admin, "a")).toEqual({ ok: false, scope: "user" });
    expect(await consumeAiQuota(null, "a")).toEqual({ ok: false, scope: "user" });
  });
});

describe("resolveOwnerId", () => {
  function jobsAdmin(rows: { user_id: string }[] | null, error = false) {
    return {
      from: () => ({
        select: () => ({
          limit: async () => ({
            data: rows,
            error: error ? { message: "x" } : null,
          }),
        }),
      }),
    } as unknown as SupabaseClient;
  }

  it("prefers OWNER_USER_ID from the environment", async () => {
    vi.stubEnv("OWNER_USER_ID", "owner-123");
    expect(await resolveOwnerId(jobsAdmin([{ user_id: "other" }]))).toBe("owner-123");
  });

  it("falls back to the single account that has jobs", async () => {
    vi.stubEnv("OWNER_USER_ID", "");
    const admin = jobsAdmin([{ user_id: "solo" }, { user_id: "solo" }]);
    expect(await resolveOwnerId(admin)).toBe("solo");
  });

  it("refuses to guess once several accounts have jobs", async () => {
    vi.stubEnv("OWNER_USER_ID", "");
    const admin = jobsAdmin([{ user_id: "a" }, { user_id: "b" }]);
    expect(await resolveOwnerId(admin)).toBeNull();
  });

  it("returns null when nothing can be determined", async () => {
    vi.stubEnv("OWNER_USER_ID", "");
    expect(await resolveOwnerId(jobsAdmin([]))).toBeNull();
    expect(await resolveOwnerId(jobsAdmin(null, true))).toBeNull();
  });
});
