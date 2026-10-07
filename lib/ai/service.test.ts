import { describe, expect, it, vi } from "vitest";
import type { LlmFn, LlmRequest } from "./llm";
import { runExtraction, runFitAnalysis } from "./service";
import type { Extraction, FitAnalysis } from "./schemas";

const NOW = new Date("2026-10-07T01:02:03Z");

const CV = `Alex Morgan
- Ran 30+ customer interviews to reshape the onboarding flow, cutting drop-off at sign-up
- Designed and shipped 12 A/B tests across onboarding and pricing pages`;

const goodAnalysis: FitAnalysis = {
  fit_score: 82,
  verdict: "Strong fit.",
  strengths: [
    {
      point: "Runs experiments",
      job_requirement: "A/B testing",
      cv_evidence: "Designed and shipped 12 A/B tests across onboarding and pricing pages",
    },
    {
      point: "Invented achievement",
      job_requirement: "Leadership",
      cv_evidence: "Managed a division of two hundred people across three continents",
    },
  ],
  gaps: [],
  tailored_bullets: [],
  outreach: { email_subject: "Hello", email_body: "Hi Priya", whatsapp_message: "Hi" },
};

/** A fake model client that returns `data` and records the request it received. */
function fakeLlm<T>(data: T) {
  const calls: LlmRequest<unknown>[] = [];
  const llm = (async (req: LlmRequest<unknown>) => {
    calls.push(req);
    return { ok: true as const, data, model: req.model };
  }) as unknown as LlmFn;
  return { llm, calls };
}

describe("runFitAnalysis", () => {
  const input = {
    job: { title: "PM", company: "Acme", description: "Run A/B tests and discovery." },
    contacts: [],
    cvText: CV,
    cvId: "cv-1",
    cvName: "alex.pdf",
  };

  it("verifies the model's claims against the CV and stamps provenance", async () => {
    const { llm, calls } = fakeLlm(goodAnalysis);
    const result = await runFitAnalysis(llm, input, { model: "claude-opus-5-5", now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.value;
    // The fabricated strength is dropped; the real one survives.
    expect(a.strengths).toHaveLength(1);
    expect(a.strengths[0].point).toBe("Runs experiments");
    expect(a.removed_unverified).toBe(1);
    // One of the two claims was unsupported (50% > the 34% "medium" ceiling).
    expect(a.confidence).toBe("low");
    expect(a.cv_id).toBe("cv-1");
    expect(a.cv_name).toBe("alex.pdf");
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.generated_at).toBe(NOW.toISOString());

    // And it asked the model for the right thing.
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("claude-opus-5-5");
    expect(calls[0].effort).toBe("medium");
    expect(calls[0].user).toContain("<candidate_cv>");
  });

  it("passes a model failure straight through without inventing a result", async () => {
    const llm = vi.fn(async () => ({
      ok: false as const,
      code: "upstream_busy" as const,
      message: "busy",
    })) as unknown as LlmFn;
    const result = await runFitAnalysis(llm, input, { model: "m" });
    expect(result).toEqual({ ok: false, code: "upstream_busy", message: "busy" });
  });
});

describe("runExtraction", () => {
  const source = `Product Owner, Meridian Talent, Brisbane.
Contact Jordan Blake on 0491 570 156 or jordan@meridiantalent.example.`;

  const raw: Extraction = {
    title: "Product Owner",
    company: "Meridian Talent",
    country: "Australia",
    salary: "",
    deadline: "",
    contacts: [
      { type: "email", value: "jordan@meridiantalent.example", name: "Jordan Blake", role: "" },
      { type: "email", value: "ceo@madeup.example", name: "", role: "" },
    ],
  };

  it("returns verified fields and drops hallucinated contacts", async () => {
    const { llm, calls } = fakeLlm(raw);
    const result = await runExtraction(
      llm,
      {
        title: "Product Owner",
        company: "",
        url: "https://x.test/job",
        salary: "",
        text: source,
        countries: ["Australia", "Other"],
        today: "2026-10-07",
      },
      { model: "claude-opus-5-5", now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.country).toBe("Australia");
    expect(result.value.contacts.map((c) => c.value)).toEqual([
      "jordan@meridiantalent.example",
    ]);
    expect(calls[0].effort).toBe("low");
    expect(calls[0].user).toContain("Allowed countries: Australia, Other");
  });
});
