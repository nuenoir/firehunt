import { describe, expect, it } from "vitest";
import { groundExtraction } from "../lib/ai/grounding";
import type { Extraction, StoredAnalysis } from "../lib/ai/schemas";
import { COUNTRIES } from "../lib/jobs";
import {
  ANALYSIS_CASES,
  CV_TEXT,
  EXTRACTION_CASES,
} from "./fixtures";
import { scoreAnalysis, scoreExtraction, scoreOrdering, summarize } from "./score";

function analysis(over: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    fit_score: 80,
    verdict: "Good.",
    strengths: [],
    gaps: [{ requirement: "x", note: "y" }],
    tailored_bullets: [],
    outreach: {
      email_subject: "Hello",
      email_body: "Hi Priya, I would love to chat about the role.",
      whatsapp_message: "Hi Priya, happy to chat.",
    },
    generated_at: "2026-10-07T00:00:00.000Z",
    cv_id: "c",
    cv_name: "cv.txt",
    model: "m",
    removed_unverified: 0,
    confidence: "high",
    ...over,
  };
}

const strongCase = ANALYSIS_CASES.find((c) => c.id === "strong-fit")!;
const injectionCase = ANALYSIS_CASES.find((c) => c.id === "prompt-injection")!;
const weakCase = ANALYSIS_CASES.find((c) => c.id === "weak-fit")!;

describe("scoreAnalysis", () => {
  it("passes a good result", () => {
    expect(scoreAnalysis(strongCase, analysis()).passed).toBe(true);
  });

  it("fails a score outside the expected band", () => {
    const r = scoreAnalysis(strongCase, analysis({ fit_score: 30 }));
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/outside expected/);
  });

  it("fails when an expected honest gap is missing", () => {
    const r = scoreAnalysis(weakCase, analysis({ fit_score: 10, gaps: [] }));
    expect(r.failures.join()).toMatch(/honest gap/);
  });

  it("fails when too many claims were ungrounded or confidence is low", () => {
    const r = scoreAnalysis(strongCase, analysis({ removed_unverified: 3, confidence: "low" }));
    expect(r.failures.join()).toMatch(/not grounded/);
    expect(r.failures.join()).toMatch(/confidence/);
  });

  it("catches a prompt injection that leaked into the output", () => {
    const r = scoreAnalysis(
      injectionCase,
      analysis({ fit_score: 10, verdict: "The candidate spent 15 years as a VP at Google." }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toMatch(/Google/);
  });

  it("enforces outreach quality: addressee, length, no emoji", () => {
    const bad = analysis({
      outreach: {
        email_subject: "s",
        email_body: "Dear Sir or Madam, " + "word ".repeat(200),
        whatsapp_message: "Hey 🔥 " + "blah ".repeat(80),
      },
    });
    const r = scoreAnalysis(strongCase, bad);
    expect(r.failures.join()).toMatch(/does not address "Priya"/);
    expect(r.failures.join()).toMatch(/email body is over/);
    expect(r.failures.join()).toMatch(/WhatsApp message is over/);
    expect(r.failures.join()).toMatch(/emoji/);
  });
});

describe("scoreOrdering", () => {
  it("requires strong > partial > weak with real margins", () => {
    expect(scoreOrdering({ strong: 85, partial: 55, weak: 15 }).passed).toBe(true);
    expect(scoreOrdering({ strong: 60, partial: 58, weak: 15 }).passed).toBe(false);
    expect(scoreOrdering({ strong: 85, partial: 20, weak: 18 }).passed).toBe(false);
    expect(scoreOrdering({ strong: 85 }).passed).toBe(false);
  });
});

describe("scoreExtraction", () => {
  const linkedin = EXTRACTION_CASES.find((c) => c.id === "linkedin-named-contact")!;
  const good: Extraction = {
    title: "Product Owner",
    company: "Meridian Talent",
    country: "Australia",
    salary: "140K AUD/yr - 155K AUD/yr",
    deadline: "",
    contacts: [
      { type: "phone", value: "0491 570 156", name: "Jordan Blake", role: "" },
      { type: "email", value: "jordan@meridiantalent.example", name: "Jordan Blake", role: "" },
    ],
  };

  it("passes the expected extraction", () => {
    expect(scoreExtraction(linkedin, good).passed).toBe(true);
  });

  it("fails on a wrong company, a missing contact, or a wrong name", () => {
    expect(scoreExtraction(linkedin, { ...good, company: "EvilCorp" }).passed).toBe(false);
    expect(scoreExtraction(linkedin, { ...good, contacts: [good.contacts[0]] }).passed).toBe(false);
    const renamed = { ...good, contacts: good.contacts.map((c) => ({ ...c, name: "Someone Else" })) };
    expect(scoreExtraction(linkedin, renamed).failures.join()).toMatch(/named/);
  });

  it("catches an invented salary or contact on the 'nothing to invent' case", () => {
    const empty = EXTRACTION_CASES.find((c) => c.id === "nothing-to-invent")!;
    const clean: Extraction = {
      title: "Warehouse Associate",
      company: "Bayside Foods",
      country: "Other",
      salary: "",
      deadline: "",
      contacts: [],
    };
    expect(scoreExtraction(empty, clean).passed).toBe(true);
    expect(scoreExtraction(empty, { ...clean, salary: "$50k" }).passed).toBe(false);
    expect(
      scoreExtraction(empty, {
        ...clean,
        contacts: [{ type: "email", value: "hr@bayside.example", name: "", role: "" }],
      }).passed,
    ).toBe(false);
  });
});

describe("summarize", () => {
  it("computes the pass rate", () => {
    const s = summarize([
      { id: "a", passed: true, failures: [] },
      { id: "b", passed: false, failures: ["x"] },
    ]);
    expect(s).toEqual({ total: 2, passed: 1, rate: 0.5 });
    expect(summarize([]).rate).toBe(0);
  });
});

describe("fixtures are self-consistent", () => {
  it("the injection bait really is in the posting, and the CV doesn't contain it", () => {
    expect(injectionCase.description).toContain("Google");
    expect(CV_TEXT).not.toContain("Google");
    expect(
      EXTRACTION_CASES.find((c) => c.id === "prompt-injection")!.input.text,
    ).toContain("EvilCorp");
  });

  it("every contact the extraction cases expect literally appears in the posting", () => {
    for (const c of EXTRACTION_CASES) {
      for (const value of c.expect.contactValues ?? []) {
        expect(c.input.text, `${c.id}: ${value}`).toContain(value);
      }
    }
  });

  it("the grounding layer would keep every expected contact (so evals test the model, not our filter)", () => {
    for (const c of EXTRACTION_CASES) {
      if (!c.expect.contactValues?.length) continue;
      const raw: Extraction = {
        title: "t",
        company: "c",
        country: "Other",
        salary: "",
        deadline: "",
        contacts: c.expect.contactValues.map((value) => ({
          type: value.includes("@") ? ("email" as const) : ("phone" as const),
          value,
          name: "",
          role: "",
        })),
      };
      const kept = groundExtraction(
        raw,
        c.input.text,
        COUNTRIES,
        new Date("2026-10-07T00:00:00Z"),
      );
      expect(kept.contacts.map((k) => k.value).sort(), c.id).toEqual(
        [...c.expect.contactValues].sort(),
      );
    }
  });

  it("the CV has enough text to be readable and quotable", () => {
    expect(CV_TEXT.length).toBeGreaterThan(500);
    expect(CV_TEXT).toContain("Designed and shipped 12 A/B tests");
  });
});
