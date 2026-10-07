// Tests for the two AI endpoints. The collaborators (auth, CV parsing, spend cap,
// the model) are mocked, so these verify the routes' own behaviour: validation,
// ordering (cheap failures happen BEFORE any spend), and error mapping.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  consumeAiQuota: vi.fn(),
  extractCvText: vi.fn(),
  callClaude: vi.fn(),
  getAdminClient: vi.fn(() => null),
}));

vi.mock("@/lib/server/auth", () => ({ authenticate: mocks.authenticate }));
vi.mock("@/lib/server/admin", () => ({ getAdminClient: mocks.getAdminClient }));
vi.mock("@/lib/server/aiQuota", () => ({ consumeAiQuota: mocks.consumeAiQuota }));
vi.mock("@/lib/cvText", () => ({ extractCvText: mocks.extractCvText }));
vi.mock("@/lib/ai/llm", () => ({ callClaude: mocks.callClaude }));

import { POST as analyze } from "./analyze/route";
import { POST as extract } from "./extract/route";

const CV_ID = "3f1c3c1e-7a0e-4d57-8b0e-2c3d4e5f6a7b";
const LONG_DESCRIPTION =
  "Senior Product Manager. Own onboarding, run discovery with customers, partner with design and engineering, and set the roadmap using usage data and experiments.";

/** A signed-in user whose Supabase client returns the given CV row and file. */
function signedIn(opts: { cvRow?: unknown; file?: Blob | null } = {}) {
  const { cvRow = { name: "alex.pdf", type: "application/pdf" }, file = new Blob(["x"]) } = opts;
  return {
    user: { id: "user-1", email: "a@b.com" },
    client: {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: cvRow }) }),
        }),
      }),
      storage: {
        from: () => ({
          download: async () =>
            file ? { data: file, error: null } : { data: null, error: { message: "nope" } },
        }),
      },
    },
  };
}

const post = (body: unknown) =>
  new Request("https://x.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const analyzeBody = {
  title: "Senior PM",
  company: "Acme",
  description: LONG_DESCRIPTION,
  cvId: CV_ID,
  contacts: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAdminClient.mockReturnValue(null);
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  mocks.authenticate.mockResolvedValue(signedIn());
  mocks.consumeAiQuota.mockResolvedValue({ ok: true });
  mocks.extractCvText.mockResolvedValue({
    ok: true,
    kind: "pdf",
    text: "Ran 30+ customer interviews to reshape the onboarding flow, cutting drop-off at sign-up",
  });
});

describe("POST /api/ai/analyze", () => {
  it("passes through the auth failure when the user is not signed in", async () => {
    mocks.authenticate.mockResolvedValue(Response.json({ error: "Please sign in first." }, { status: 401 }));
    const res = await analyze(post(analyzeBody));
    expect(res.status).toBe(401);
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it("returns 503 when the server has no API key, before doing any work", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const res = await analyze(post(analyzeBody));
    expect(res.status).toBe(503);
    expect(mocks.consumeAiQuota).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies with 400", async () => {
    expect((await analyze(post("not json"))).status).toBe(400);
    expect((await analyze(post({ ...analyzeBody, cvId: "not-a-uuid" }))).status).toBe(400);
  });

  it("asks for the job description when the notes are too short, without spending quota", async () => {
    const res = await analyze(post({ ...analyzeBody, description: "short" }));
    expect(res.status).toBe(422);
    expect(mocks.consumeAiQuota).not.toHaveBeenCalled();
  });

  it("rejects an oversized job description with 413", async () => {
    const res = await analyze(post({ ...analyzeBody, description: "x".repeat(20_001) }));
    expect(res.status).toBe(413);
  });

  it("returns 404 when the CV is not in the user's cloud storage", async () => {
    mocks.authenticate.mockResolvedValue(signedIn({ cvRow: null }));
    const res = await analyze(post(analyzeBody));
    expect(res.status).toBe(404);
    expect(mocks.consumeAiQuota).not.toHaveBeenCalled();
  });

  it("returns 404 when the CV file cannot be downloaded", async () => {
    mocks.authenticate.mockResolvedValue(signedIn({ file: null }));
    expect((await analyze(post(analyzeBody))).status).toBe(404);
  });

  it("returns 422 with the reason when the CV cannot be read, without spending quota", async () => {
    mocks.extractCvText.mockResolvedValue({
      ok: false,
      reason: "unsupported",
      message: "Upload it again as a PDF or .docx file.",
    });
    const res = await analyze(post(analyzeBody));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("PDF or .docx");
    expect(mocks.consumeAiQuota).not.toHaveBeenCalled();
  });

  it("returns 429 when the daily AI allowance is used up, and never calls the model", async () => {
    mocks.consumeAiQuota.mockResolvedValue({ ok: false, scope: "user" });
    const res = await analyze(post(analyzeBody));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it("maps a model failure to a friendly error status", async () => {
    mocks.callClaude.mockResolvedValue({ ok: false, code: "refused", message: "declined" });
    const res = await analyze(post(analyzeBody));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("refused");
  });

  it("returns the verified analysis on success, consuming exactly one quota slot", async () => {
    mocks.callClaude.mockResolvedValue({
      ok: true,
      model: "claude-opus-5-5",
      data: {
        fit_score: 77,
        verdict: "Good.",
        strengths: [
          {
            point: "Discovery",
            job_requirement: "Run discovery",
            cv_evidence: "Ran 30+ customer interviews to reshape the onboarding flow",
          },
        ],
        gaps: [],
        tailored_bullets: [],
        outreach: { email_subject: "s", email_body: "b", whatsapp_message: "w" },
      },
    });
    const res = await analyze(post(analyzeBody));
    expect(res.status).toBe(200);
    const { analysis } = await res.json();
    expect(analysis.fit_score).toBe(77);
    expect(analysis.cv_id).toBe(CV_ID);
    expect(analysis.confidence).toBe("high");
    expect(mocks.consumeAiQuota).toHaveBeenCalledTimes(1);
    expect(mocks.consumeAiQuota.mock.calls[0][1]).toBe("user-1");
  });
});

describe("POST /api/ai/extract", () => {
  const extractBody = {
    title: "Product Owner | Meridian Talent | LinkedIn",
    company: "",
    url: "https://linkedin.example/jobs/1",
    salary: "",
    text: "Contact Jordan Blake on 0491 570 156 or jordan@meridiantalent.example for this Brisbane role.",
  };

  it("requires sign-in", async () => {
    mocks.authenticate.mockResolvedValue(Response.json({ error: "x" }, { status: 401 }));
    expect((await extract(post(extractBody))).status).toBe(401);
  });

  it("returns 503 when AI is not configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await extract(post(extractBody))).status).toBe(503);
  });

  it("rejects oversized captures and near-empty captures", async () => {
    expect((await extract(post({ ...extractBody, text: "x".repeat(20_001) }))).status).toBe(413);
    expect((await extract(post({ ...extractBody, title: "", text: "hi" }))).status).toBe(422);
  });

  it("returns 429 without calling the model when the allowance is gone", async () => {
    mocks.consumeAiQuota.mockResolvedValue({ ok: false, scope: "global" });
    expect((await extract(post(extractBody))).status).toBe(429);
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it("returns verified fields and drops a hallucinated contact", async () => {
    mocks.callClaude.mockResolvedValue({
      ok: true,
      model: "m",
      data: {
        title: "Product Owner",
        company: "Meridian Talent",
        country: "Australia",
        salary: "",
        deadline: "",
        contacts: [
          { type: "email", value: "jordan@meridiantalent.example", name: "Jordan Blake", role: "" },
          { type: "email", value: "invented@nowhere.example", name: "", role: "" },
        ],
      },
    });
    const res = await extract(post(extractBody));
    expect(res.status).toBe(200);
    const { extraction } = await res.json();
    expect(extraction.company).toBe("Meridian Talent");
    expect(extraction.country).toBe("Australia");
    expect(extraction.contacts.map((c: { value: string }) => c.value)).toEqual([
      "jordan@meridiantalent.example",
    ]);
  });
});
