// lib/adzuna.ts
// Types + pure helpers for talking to the Adzuna jobs API.
// The actual network call lives in the server route (app/api/adzuna/route.ts);
// this file only describes the data and knows how to reshape it.

export interface AdzunaCountry {
  code: string; // Adzuna's 2-letter code, e.g. "au"
  label: string; // human-friendly name
}

// The subset of Adzuna's 19 supported countries most relevant here.
// Your focus markets come first, then the rest of Western Europe, then others.
export const ADZUNA_COUNTRIES: AdzunaCountry[] = [
  { code: "au", label: "Australia" },
  { code: "sg", label: "Singapore" },
  { code: "nl", label: "Netherlands" },
  { code: "de", label: "Germany" },
  { code: "fr", label: "France" },
  { code: "gb", label: "United Kingdom" },
  { code: "it", label: "Italy" },
  { code: "es", label: "Spain" },
  { code: "at", label: "Austria" },
  { code: "be", label: "Belgium" },
  { code: "ch", label: "Switzerland" },
  { code: "nz", label: "New Zealand" },
  { code: "ca", label: "Canada" },
  { code: "us", label: "United States" },
];

// Rough currency symbol per country, just for displaying salaries.
const CURRENCY: Record<string, string> = {
  au: "A$",
  sg: "S$",
  nl: "€",
  de: "€",
  fr: "€",
  it: "€",
  es: "€",
  at: "€",
  be: "€",
  ch: "CHF ",
  gb: "£",
  nz: "NZ$",
  ca: "C$",
  us: "$",
};

// The shape of one raw Adzuna API result (only the fields we actually use).
export interface AdzunaApiResult {
  id?: string;
  title?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  redirect_url?: string;
  salary_min?: number;
  salary_max?: number;
  description?: string;
}

// The clean, minimal job result we hand back to the browser.
export interface AdzunaJob {
  externalId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  salary: string;
  description: string;
}

function formatSalary(
  min: number | undefined,
  max: number | undefined,
  code: string,
): string {
  if (!min && !max) return "";
  const sym = CURRENCY[code] ?? "";
  const fmt = (n: number) => sym + Math.round(n).toLocaleString("en-US");
  if (min && max) return `${fmt(min)}–${fmt(max)} / yr`;
  return `${fmt((min ?? max) as number)} / yr`;
}

/** Turn raw Adzuna results into our clean AdzunaJob shape. Pure — no fetching. */
export function mapAdzunaResults(
  results: AdzunaApiResult[],
  code: string,
): AdzunaJob[] {
  return results.map((r, i) => ({
    externalId: r.id ?? `${code}-${i}`,
    title: r.title ?? "Untitled role",
    company: r.company?.display_name ?? "Unknown company",
    location: r.location?.display_name ?? "",
    url: r.redirect_url ?? "",
    salary: formatSalary(r.salary_min, r.salary_max, code),
    description: (r.description ?? "").replace(/\s+/g, " ").trim(),
  }));
}
