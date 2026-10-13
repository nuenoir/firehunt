// The daily digest messages the owner's phone, so only Vercel Cron (which sends the
// secret) may trigger it. These tests cover the secret check only; what the digest
// says is covered by lib/notify.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdminClient: vi.fn(() => null) }));
vi.mock("@/lib/server/admin", () => ({ getAdminClient: mocks.getAdminClient }));

import { GET } from "./route";

const call = (authorization?: string) =>
  GET(
    new Request("https://x.test/api/cron/digest", {
      headers: authorization === undefined ? {} : { authorization },
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAdminClient.mockReturnValue(null);
  vi.stubEnv("CRON_SECRET", "s3cret-value");
});

describe("GET /api/cron/digest authorisation", () => {
  it("refuses a request with no secret, a wrong secret, or a near-miss", async () => {
    for (const header of [undefined, "", "Bearer wrong", "Bearer s3cret-valu", "Bearer s3cret-valuee", "bearer s3cret-value", "s3cret-value"]) {
      const res = await call(header);
      expect(res.status, JSON.stringify(header)).toBe(401);
    }
    expect(mocks.getAdminClient).not.toHaveBeenCalled(); // nothing happened before the check
  });

  it("refuses everything when no secret is configured (an empty secret must never match)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call("")).status).toBe(401);
  });

  it("lets the right secret through to the real work", async () => {
    const res = await call("Bearer s3cret-value");
    // The database is not configured in this test, which is a 500 from the next step,
    // so we know the secret check passed.
    expect(res.status).toBe(500);
    expect(mocks.getAdminClient).toHaveBeenCalled();
  });
});
