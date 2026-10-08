// lib/seniority.ts
// Decides whether a job title is a senior / leadership role, so the search can hide
// them. A title-keyword heuristic: neither job API tags seniority reliably, so we
// read the title the way a person skimming a list would.
//
// Deliberately NOT treated as senior (they are common mid-level titles):
//   "Manager" on its own (Product Manager), "Executive" (Account Executive, Sales
//   Executive, Executive Assistant), "Associate", "Specialist", "Consultant".
// Careful false positives that are handled: "Lead Generation" is a marketing job, and
// "Staff Nurse" is not a staff-level engineer.

const SENIOR_TITLE = new RegExp(
  [
    String.raw`\bsenior\b`,
    String.raw`\bsr\b`, // "Sr." / "Sr Analyst"
    String.raw`\blead\b(?!\s+gen)`, // Tech Lead, Team Lead — but not "Lead Generation"
    String.raw`\bprincipal\b`,
    String.raw`\bstaff\s+(?:software|engineer|scientist|designer|product|data|ux)\b`,
    String.raw`\bhead\s+of\b`,
    String.raw`\bdirector\b`, // also Managing / Associate / Executive Director
    String.raw`\bpresident\b`, // also Vice President
    String.raw`\b[a-z]?vp\b`, // VP, SVP, EVP, AVP
    String.raw`\bchief\b`,
    String.raw`\bc(?:e|f|t|m|p|o|i|s)o\b`, // CEO, CFO, CTO, CMO, CPO, COO, CIO, CSO
    String.raw`\bgeneral\s+(?:manager|counsel)\b`,
    String.raw`\bcountry\s+manager\b`,
  ].join("|"),
  "i",
);

/** True if the title reads as a senior or leadership role. */
export function isSeniorTitle(title: string): boolean {
  return SENIOR_TITLE.test(title);
}
