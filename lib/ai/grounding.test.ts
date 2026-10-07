import { describe, expect, it } from "vitest";
import {
  groundAnalysis,
  groundExtraction,
  makeQuoteChecker,
  numbersGrounded,
} from "./grounding";
import type { Extraction, FitAnalysis } from "./schemas";

const CV = `Sam Rivera
Product Analyst, Orchard Labs (2022 - present)
- Ran 30+ customer interviews to reshape the onboarding flow, cutting drop-off at sign-up
- Designed and shipped 12 A/B tests across onboarding and pricing pages
- Built weekly funnel dashboards in SQL for the leadership team
Skills: SQL, Python, Figma`;

describe("makeQuoteChecker", () => {
  const inCv = makeQuoteChecker(CV);

  it("accepts a real quote, tolerating case, bullets, punctuation and line breaks", () => {
    expect(inCv("Designed and shipped 12 A/B tests across onboarding and pricing pages")).toBe(true);
    expect(inCv("DESIGNED AND SHIPPED 12 a/b tests")).toBe(true);
    expect(inCv("Built weekly funnel dashboards\nin SQL for the leadership team")).toBe(true);
  });

  it("rejects invented or paraphrased quotes", () => {
    expect(inCv("Led a team of 40 engineers at Google")).toBe(false);
    expect(inCv("Ran 300 customer interviews")).toBe(false);
  });

  it("rejects quotes too short to be meaningful evidence", () => {
    expect(inCv("SQL")).toBe(false);
  });
});

describe("numbersGrounded", () => {
  it("passes when every number in the claim appears in the source", () => {
    expect(numbersGrounded("Shipped 12 A/B tests and 30+ interviews", CV)).toBe(true);
  });
  it("fails when the claim contains a number the source never mentions", () => {
    expect(numbersGrounded("Grew revenue 300%", CV)).toBe(false);
    expect(numbersGrounded("Ran 31 interviews", CV)).toBe(false);
  });
  it("passes claims with no numbers", () => {
    expect(numbersGrounded("Worked closely with stakeholders", CV)).toBe(true);
  });
});

function analysis(over: Partial<FitAnalysis> = {}): FitAnalysis {
  return {
    fit_score: 80,
    verdict: "Good fit.",
    strengths: [
      {
        point: "Runs experiments",
        job_requirement: "A/B testing",
        cv_evidence: "Designed and shipped 12 A/B tests across onboarding and pricing pages",
      },
    ],
    gaps: [{ requirement: "Paid growth", note: "Not evidenced." }],
    tailored_bullets: [
      {
        bullet: "Shipped 12 A/B tests across onboarding and pricing.",
        cv_evidence: "Designed and shipped 12 A/B tests across onboarding and pricing pages",
      },
    ],
    outreach: { email_subject: "s", email_body: "b", whatsapp_message: "w" },
    ...over,
  };
}

describe("groundAnalysis", () => {
  it("keeps fully supported claims and reports high confidence", () => {
    const out = groundAnalysis(analysis(), CV);
    expect(out.removed).toBe(0);
    expect(out.confidence).toBe("high");
    expect(out.analysis.strengths).toHaveLength(1);
    expect(out.analysis.tailored_bullets).toHaveLength(1);
  });

  it("drops a strength whose quote is not in the CV", () => {
    const raw = analysis();
    raw.strengths.push({
      point: "Led a big team",
      job_requirement: "Leadership",
      cv_evidence: "Led a team of forty engineers at a famous search company",
    });
    const out = groundAnalysis(raw, CV);
    expect(out.analysis.strengths).toHaveLength(1);
    expect(out.removed).toBe(1);
    expect(out.confidence).toBe("medium"); // 1 of 3 claims removed
  });

  it("drops a tailored bullet that invents a number, even with a real quote", () => {
    const raw = analysis({
      tailored_bullets: [
        {
          bullet: "Shipped 50 A/B tests that doubled conversion.",
          cv_evidence: "Designed and shipped 12 A/B tests across onboarding and pricing pages",
        },
      ],
    });
    const out = groundAnalysis(raw, CV);
    expect(out.analysis.tailored_bullets).toHaveLength(0);
    expect(out.removed).toBe(1);
  });

  it("reports low confidence when most or all claims are unsupported", () => {
    const fake = { point: "x", job_requirement: "y", cv_evidence: "completely made up evidence text here" };
    const out = groundAnalysis(
      analysis({
        strengths: [fake, fake],
        tailored_bullets: [{ bullet: "z", cv_evidence: "also entirely fabricated evidence line" }],
      }),
      CV,
    );
    expect(out.confidence).toBe("low");
    expect(out.removed).toBe(3);
  });

  it("clamps and rounds the score into 0-100", () => {
    expect(groundAnalysis(analysis({ fit_score: 250 }), CV).analysis.fit_score).toBe(100);
    expect(groundAnalysis(analysis({ fit_score: -5 }), CV).analysis.fit_score).toBe(0);
    expect(groundAnalysis(analysis({ fit_score: 71.6 }), CV).analysis.fit_score).toBe(72);
  });
});

const COUNTRIES = ["Australia", "United Arab Emirates", "Other"] as const;
const SOURCE = `Senior Product Manager at Northwind Labs, Brisbane. Salary A$150,000-170,000 per year.
Applications close 30 November 2026.
Contact Priya Nair, Hiring Manager, on 0491 570 156 or priya.nair@northwind.example.`;

function extraction(over: Partial<Extraction> = {}): Extraction {
  return {
    title: "Senior Product Manager",
    company: "Northwind Labs",
    country: "australia",
    salary: "A$150,000-170,000 per year",
    deadline: "2026-11-30",
    contacts: [
      { type: "email", value: "priya.nair@northwind.example", name: "Priya Nair", role: "Hiring Manager" },
      { type: "phone", value: "0491 570 156", name: "Priya Nair", role: "Hiring Manager" },
    ],
    ...over,
  };
}

describe("groundExtraction", () => {
  const now = new Date("2026-10-07T00:00:00Z");

  it("keeps a fully supported extraction and normalises the country", () => {
    const out = groundExtraction(extraction(), SOURCE, COUNTRIES, now);
    expect(out.country).toBe("Australia");
    expect(out.salary).toBe("A$150,000-170,000 per year");
    expect(out.deadline).toBe("2026-11-30");
    expect(out.contacts).toHaveLength(2);
    expect(out.contacts[0].name).toBe("Priya Nair");
  });

  it("drops contacts that do not literally appear in the text (hallucinated)", () => {
    const out = groundExtraction(
      extraction({
        contacts: [
          { type: "email", value: "ceo@northwind.example", name: "", role: "" },
          { type: "phone", value: "0400 111 222", name: "", role: "" },
          { type: "email", value: "priya.nair@northwind.example", name: "", role: "" },
        ],
      }),
      SOURCE,
      COUNTRIES,
      now,
    );
    expect(out.contacts.map((c) => c.value)).toEqual(["priya.nair@northwind.example"]);
  });

  it("matches phone numbers by digits, ignoring spacing", () => {
    const out = groundExtraction(
      extraction({
        contacts: [{ type: "phone", value: "0491570156", name: "", role: "" }],
      }),
      SOURCE,
      COUNTRIES,
      now,
    );
    expect(out.contacts).toHaveLength(1);
  });

  it("blanks a name or role that the text does not contain", () => {
    const out = groundExtraction(
      extraction({
        contacts: [
          { type: "email", value: "priya.nair@northwind.example", name: "Jordan Smith", role: "CEO" },
        ],
      }),
      SOURCE,
      COUNTRIES,
      now,
    );
    expect(out.contacts[0].name).toBe("");
    expect(out.contacts[0].role).toBe("");
  });

  it("falls back to 'Other' for a country outside the allowed list", () => {
    expect(groundExtraction(extraction({ country: "Narnia" }), SOURCE, COUNTRIES, now).country).toBe("Other");
  });

  it("clears a salary whose numbers are not in the text", () => {
    expect(
      groundExtraction(extraction({ salary: "A$999,000 per year" }), SOURCE, COUNTRIES, now).salary,
    ).toBe("");
  });

  it("rejects impossible, malformed, or implausible deadlines", () => {
    for (const bad of ["2026-02-30", "30/11/2026", "2019-01-01", "2035-01-01", ""]) {
      expect(groundExtraction(extraction({ deadline: bad }), SOURCE, COUNTRIES, now).deadline).toBe("");
    }
  });

  it("de-duplicates repeated contacts", () => {
    const dup = { type: "email" as const, value: "priya.nair@northwind.example", name: "", role: "" };
    const out = groundExtraction(extraction({ contacts: [dup, { ...dup }] }), SOURCE, COUNTRIES, now);
    expect(out.contacts).toHaveLength(1);
  });
});
