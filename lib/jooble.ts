// lib/jooble.ts
// Types + pure helpers for the Jooble jobs API. We use Jooble for the GULF
// countries, which Adzuna does not cover. The network call lives in
// app/api/jooble/route.ts. Jooble results are reshaped into the SAME AdzunaJob
// shape the results grid already understands, so both sources look identical.

import type { AdzunaJob } from "./adzuna";

export interface GulfLocation {
  label: string;
  location: string; // the text sent to Jooble as the search "location"
}

// Gulf markets, searched via Jooble (Adzuna has none of these).
export const GULF_LOCATIONS: GulfLocation[] = [
  { label: "United Arab Emirates", location: "United Arab Emirates" },
  { label: "Saudi Arabia", location: "Saudi Arabia" },
  { label: "Qatar", location: "Qatar" },
  { label: "Kuwait", location: "Kuwait" },
  { label: "Bahrain", location: "Bahrain" },
  { label: "Oman", location: "Oman" },
];

// One raw Jooble result (only the fields we use).
export interface JoobleApiJob {
  id?: number | string;
  title?: string;
  company?: string;
  location?: string;
  salary?: string;
  snippet?: string;
  link?: string;
}

/** Reshape raw Jooble results into our shared AdzunaJob result shape. Pure. */
export function mapJoobleResults(jobs: JoobleApiJob[]): AdzunaJob[] {
  return jobs.map((j, i) => ({
    externalId: String(j.id ?? `jooble-${i}`),
    title: j.title ?? "Untitled role",
    company: j.company?.trim() || "Unknown company",
    location: j.location ?? "",
    url: j.link ?? "",
    salary: j.salary?.trim() || "",
    // Jooble snippets contain HTML tags — strip them and tidy whitespace.
    description: (j.snippet ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}
