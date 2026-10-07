import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDigest, sendWhatsApp, summarizeJobs } from "./notify";

// A fixed "now" keeps the date maths deterministic: Wed 7 Oct 2026, 00:00 UTC.
const NOW = Date.UTC(2026, 9, 7);

describe("summarizeJobs", () => {
  const row = (
    status: string,
    deadline: string | null = null,
    follow: string | null = null,
  ) => ({ status, deadline, follow_up_date: follow });

  it("buckets upcoming deadlines into weekly windows", () => {
    const { text, summary } = summarizeJobs(
      [
        row("interested", "2026-10-10"), // within 1 week
        row("interested", "2026-10-14"), // exactly 7 days -> still week 1
        row("applied", "2026-10-20"), // week 2
        row("interested", "2026-10-30"), // week 4
        row("interested", "2026-11-20"), // beyond 4 weeks -> not counted
        row("interested", "2026-10-01"), // already passed -> not counted
        row("rejected", "2026-10-09"), // rejected -> excluded
      ],
      NOW,
    );
    expect(text).toContain("- Within 1 week: 2");
    expect(text).toContain("- In 2 weeks: 1");
    expect(text).toContain("- In 3 weeks: 0");
    expect(text).toContain("- In 4 weeks: 1");
    expect(summary.deadlines).toBe(4);
    expect(summary.total).toBe(7);
  });

  it("counts follow-ups due today or overdue, ignoring rejected jobs", () => {
    const { summary, text } = summarizeJobs(
      [
        row("applied", null, "2026-10-07"), // today
        row("applied", null, "2026-10-01"), // overdue
        row("applied", null, "2026-10-08"), // tomorrow -> not yet
        row("rejected", null, "2026-10-01"), // rejected -> excluded
      ],
      NOW,
    );
    expect(summary.followUps).toBe(2);
    expect(text).toContain("Follow-ups due today or overdue: 2");
  });

  it("lists only the stages that have jobs", () => {
    const { text } = summarizeJobs(
      [row("interested"), row("interested"), row("offer")],
      NOW,
    );
    expect(text).toContain("By stage: Interested 2, Offer 1");
  });
});

describe("buildDigest", () => {
  it("says so plainly when there are no jobs yet", () => {
    const text = buildDigest({
      total: 0,
      byStage: [],
      followUps: 0,
      deadlines: { w1: 0, w2: 0, w3: 0, w4: 0 },
    });
    expect(text).toContain("Saved jobs: 0");
    expect(text).toContain("By stage: none yet");
  });
});

describe("sendWhatsApp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses to send when the provider is not configured", async () => {
    vi.stubEnv("CALLMEBOT_PHONE", "");
    vi.stubEnv("CALLMEBOT_APIKEY", "");
    const result = await sendWhatsApp("hello");
    expect(result.ok).toBe(false);
  });

  it("strips characters CallMeBot's free tier rejects before sending", async () => {
    vi.stubEnv("CALLMEBOT_PHONE", "61400000000");
    vi.stubEnv("CALLMEBOT_APIKEY", "123456");
    const fetchMock = vi.fn<(url: string | URL) => Promise<Response>>(
      async () =>
        new Response("<p>Message queued. You will receive it in a few seconds.</p>"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendWhatsApp("🔥 FireHunt — daily update\nSaved jobs: 5");

    expect(result.ok).toBe(true);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("phone")).toBe("61400000000");
    expect(url.searchParams.get("apikey")).toBe("123456");
    const sent = url.searchParams.get("text") ?? "";
    expect(sent).not.toMatch(/[^\x09\x0A\x0D\x20-\x7E]/);
    expect(sent).toContain("Saved jobs: 5");
  });

  it("reports failure when the provider does not confirm queueing", async () => {
    vi.stubEnv("CALLMEBOT_PHONE", "61400000000");
    vi.stubEnv("CALLMEBOT_APIKEY", "123456");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Error: invalid apikey")),
    );
    const result = await sendWhatsApp("hi");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("invalid apikey");
  });
});
