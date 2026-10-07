// Pure scoring functions for the eval harness: given a case and the model's
// (already verified) output, decide pass or fail and say exactly why. Kept free of
// any network code so the scorers themselves can be unit-tested.

import type { Extraction, StoredAnalysis } from "../lib/ai/schemas";
import type { AnalysisCase, ExtractionCase } from "./fixtures";

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const EMOJI = /\p{Extended_Pictographic}/u;

export function scoreAnalysis(c: AnalysisCase, a: StoredAnalysis): CaseResult {
  const failures: string[] = [];
  const { expect } = c;

  if (a.fit_score < expect.minScore || a.fit_score > expect.maxScore) {
    failures.push(
      `score ${a.fit_score} outside expected ${expect.minScore}-${expect.maxScore}`,
    );
  }
  if (expect.expectGaps && a.gaps.length === 0) {
    failures.push("expected at least one honest gap, found none");
  }
  if (a.removed_unverified > 1) {
    failures.push(`${a.removed_unverified} claims were not grounded in the CV (max 1)`);
  }
  if (a.confidence === "low") {
    failures.push("confidence came back low");
  }
  const haystack = JSON.stringify(a).toLowerCase();
  for (const bad of expect.forbid ?? []) {
    if (haystack.includes(bad.toLowerCase())) {
      failures.push(`output contains forbidden text "${bad}"`);
    }
  }
  if (expect.addressee && !a.outreach.email_body.includes(expect.addressee)) {
    failures.push(`outreach email does not address "${expect.addressee}"`);
  }
  if (wordCount(a.outreach.whatsapp_message) > 70) {
    failures.push("WhatsApp message is over 70 words");
  }
  if (EMOJI.test(a.outreach.whatsapp_message)) {
    failures.push("WhatsApp message contains an emoji");
  }
  if (wordCount(a.outreach.email_body) > 170) {
    failures.push("email body is over 170 words");
  }
  return { id: c.id, passed: failures.length === 0, failures };
}

/** Strong fit must outscore partial, which must outscore weak, with real margins. */
export function scoreOrdering(scores: {
  strong?: number;
  partial?: number;
  weak?: number;
}): CaseResult {
  const failures: string[] = [];
  const { strong, partial, weak } = scores;
  if (strong === undefined || partial === undefined || weak === undefined) {
    failures.push("missing one of the strong/partial/weak scores");
  } else {
    if (strong - partial < 10) {
      failures.push(`strong (${strong}) is not clearly above partial (${partial})`);
    }
    if (partial - weak < 10) {
      failures.push(`partial (${partial}) is not clearly above weak (${weak})`);
    }
  }
  return { id: "score-ordering", passed: failures.length === 0, failures };
}

export function scoreExtraction(c: ExtractionCase, x: Extraction): CaseResult {
  const failures: string[] = [];
  const { expect } = c;

  if (expect.title !== undefined && x.title !== expect.title) {
    failures.push(`title "${x.title}" != "${expect.title}"`);
  }
  if (expect.company !== undefined && x.company !== expect.company) {
    failures.push(`company "${x.company}" != "${expect.company}"`);
  }
  if (expect.country !== undefined && x.country !== expect.country) {
    failures.push(`country "${x.country}" != "${expect.country}"`);
  }
  if (expect.deadline !== undefined && x.deadline !== expect.deadline) {
    failures.push(`deadline "${x.deadline}" != "${expect.deadline}"`);
  }
  if (expect.salaryEmpty && x.salary !== "") {
    failures.push(`salary should be empty but was "${x.salary}"`);
  }
  if (expect.contactValues) {
    const got = x.contacts.map((k) => k.value).sort();
    const want = [...expect.contactValues].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`contacts ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
  }
  for (const [value, name] of Object.entries(expect.contactNames ?? {})) {
    const found = x.contacts.find((k) => k.value === value);
    if (found && found.name !== name) {
      failures.push(`contact ${value} named "${found.name}" != "${name}"`);
    }
  }
  return { id: c.id, passed: failures.length === 0, failures };
}

export function summarize(results: CaseResult[]) {
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    rate: results.length === 0 ? 0 : passed / results.length,
  };
}
