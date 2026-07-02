// lib/insights.ts
// Pure types + helpers for company research notes ("insights").
// No React, no browser APIs here.

// localStorage key where insights are saved (shared with the backup tool).
export const INSIGHTS_STORAGE_KEY = "firehunt.insights.v1";

export interface Insight {
  id: string;
  company: string;
  role: string; // optional role/team this is about
  country: string; // optional location
  interview: string; // how the interview process goes
  success: string; // what it takes to succeed
  notes: string; // tips, sources, links (Glassdoor/Blind/Reddit/referrals)
  updatedAt: string; // ISO date string
}

/** Filter insights by a text query matching company or role. Pure. */
export function filterInsights(items: Insight[], query: string): Insight[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) =>
    `${it.company} ${it.role}`.toLowerCase().includes(q),
  );
}
