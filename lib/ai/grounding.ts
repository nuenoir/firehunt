// lib/ai/grounding.ts
// Deterministic checks that keep AI output honest. The model is asked to quote
// its evidence; here we verify those quotes actually exist in the source text and
// drop anything it can't back up. Pure functions — no network, easy to test.

import type {
  Confidence,
  Extraction,
  FitAnalysis,
} from "./schemas";

/** Lowercase and strip everything that isn't a letter or number (any script),
 *  so line breaks, bullets, hyphenation and quote styles can't hide a match. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Build a checker that tests whether a quote appears in `text` (loosely). */
export function makeQuoteChecker(text: string, minLen = 12) {
  const hay = squash(text);
  return (quote: string): boolean => {
    const q = squash(quote);
    return q.length >= minLen && hay.includes(q);
  };
}

/** True when every number written in `claim` also appears in `source`. Stops the
 *  model from inventing metrics ("grew revenue 300%") the CV never mentioned. */
export function numbersGrounded(claim: string, source: string): boolean {
  const nums = claim.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const src = source.replace(/,/g, "");
  return nums.every((n) => src.includes(n.replace(/,/g, "")));
}

export interface GroundedAnalysis {
  analysis: FitAnalysis;
  removed: number;
  confidence: Confidence;
}

/** Verify a fit analysis against the CV text: drop strengths and tailored bullets
 *  whose quoted evidence isn't in the CV (or whose numbers aren't), clamp the
 *  score, and report how trustworthy what's left is. */
export function groundAnalysis(
  raw: FitAnalysis,
  cvText: string,
): GroundedAnalysis {
  const inCv = makeQuoteChecker(cvText);

  const strengths = raw.strengths.filter((s) => inCv(s.cv_evidence));
  const bullets = raw.tailored_bullets.filter(
    (b) => inCv(b.cv_evidence) && numbersGrounded(b.bullet, cvText),
  );

  const total = raw.strengths.length + raw.tailored_bullets.length;
  const kept = strengths.length + bullets.length;
  const removed = total - kept;
  const ratio = total === 0 ? 1 : removed / total;

  let confidence: Confidence;
  if (kept === 0) confidence = "low";
  else if (removed === 0) confidence = "high";
  else if (ratio <= 0.34) confidence = "medium";
  else confidence = "low";

  const score = Math.max(0, Math.min(100, Math.round(raw.fit_score)));

  return {
    analysis: {
      ...raw,
      fit_score: Number.isFinite(score) ? score : 0,
      strengths,
      tailored_bullets: bullets,
    },
    removed,
    confidence,
  };
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

function validIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s
    ? null
    : d;
}

/** Verify extracted job fields against the page text they came from. Anything the
 *  model could have guessed (contacts, names, salary, deadline) must be provable. */
export function groundExtraction(
  raw: Extraction,
  sourceText: string,
  countries: readonly string[],
  now: Date = new Date(),
): Extraction {
  const squashedSource = squash(sourceText);
  const sourceLower = sourceText.toLowerCase();
  const sourceDigits = digitsOnly(sourceText);
  const clip = (s: string, n: number) => s.trim().slice(0, n);

  // Country must be one we know about; anything else becomes "Other".
  const country =
    countries.find((c) => c.toLowerCase() === raw.country.trim().toLowerCase()) ??
    "Other";

  // Salary must be backed by numbers actually present in the text.
  const salaryRaw = clip(raw.salary, 120);
  const salary =
    salaryRaw && numbersGrounded(salaryRaw, sourceText) ? salaryRaw : "";

  // Deadline must be a real calendar date within a sensible window.
  let deadline = "";
  const d = validIsoDate(raw.deadline.trim());
  if (d) {
    const dayMs = 86_400_000;
    const delta = (d.getTime() - now.getTime()) / dayMs;
    if (delta >= -1 && delta <= 548) deadline = raw.deadline.trim();
  }

  // Contacts must literally appear in the text; names/roles must too.
  const seen = new Set<string>();
  const contacts: Extraction["contacts"] = [];
  for (const c of raw.contacts) {
    const value = c.value.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    let present = false;
    if (c.type === "email") {
      present = EMAIL_RE.test(value) && sourceLower.includes(value.toLowerCase());
    } else {
      const dg = digitsOnly(value);
      present = dg.length >= 8 && dg.length <= 15 && sourceDigits.includes(dg);
    }
    if (!present) continue;
    seen.add(value.toLowerCase());
    const name = clip(c.name, 80);
    const role = clip(c.role, 80);
    contacts.push({
      type: c.type,
      value,
      name: name && squashedSource.includes(squash(name)) ? name : "",
      role: role && squashedSource.includes(squash(role)) ? role : "",
    });
  }

  return {
    title: clip(raw.title, 200),
    company: clip(raw.company, 200),
    country,
    salary,
    deadline,
    contacts,
  };
}
