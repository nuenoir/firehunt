import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/ai/status", () => {
  it("reports AI as enabled only when a key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it("reports AI as disabled when the key is missing or blank", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await (await GET()).json()).toEqual({ enabled: false });
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });

  it("never leaks the key and is not cached", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-super-secret");
    const res = await GET();
    expect(JSON.stringify(await res.clone().json())).not.toContain("sk-ant");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
