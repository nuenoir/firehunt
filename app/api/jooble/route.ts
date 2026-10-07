// app/api/jooble/route.ts
// Server-side call to the Jooble jobs API (covers the Gulf, which Adzuna does
// not). Keeps the key on the server. Returns the SAME shape as /api/adzuna, so
// the search UI can treat both sources identically.
//
// Two modes:
//  - a single Gulf country + page  -> that page's results (30) + total count
//  - location "ALL_GULF"           -> fan out across all 6 GCC countries, merge
//                                      + de-dup, and return the whole pool. The
//                                      browser then pages through it locally.

import { mapJoobleResults, GULF_LOCATIONS } from "@/lib/jooble";
import type { AdzunaJob } from "@/lib/adzuna";
import { getAdminClient } from "@/lib/server/admin";
import {
  checkRateLimit,
  clientIp,
  tooManyRequests,
} from "@/lib/server/rateLimit";

async function fetchJooble(
  key: string,
  keywords: string,
  location: string,
  page: string,
): Promise<{ total: number; results: AdzunaJob[] }> {
  const res = await fetch(`https://jooble.org/api/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keywords, location, page }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Jooble HTTP ${res.status}`);
  const data = await res.json();
  return {
    total: data.totalCount ?? 0,
    results: mapJoobleResults(data.jobs ?? []),
  };
}

export async function GET(request: Request) {
  // Protect the shared Jooble quota: 30 searches per minute per IP. "All Gulf"
  // fans out to six upstream calls, so it costs six units against the limit.
  const isAllGulf =
    new URL(request.url).searchParams.get("location") === "ALL_GULF";
  const admin = getAdminClient();
  for (let i = 0; i < (isAllGulf ? 6 : 1); i++) {
    const allowed = await checkRateLimit(
      admin,
      `search:${clientIp(request)}`,
      60,
      30,
      "allow",
    );
    if (!allowed) {
      return tooManyRequests(
        "Too many searches. Please wait a minute and try again.",
        60,
      );
    }
  }

  const key = process.env.JOOBLE_API_KEY;

  if (!key || key === "your_jooble_key_here") {
    return Response.json(
      {
        error:
          "Jooble key isn't set. Add JOOBLE_API_KEY to .env.local, then restart the dev server.",
      },
      { status: 500 },
    );
  }

  const { searchParams } = new URL(request.url);
  const what = searchParams.get("what")?.trim() || "";
  const location = searchParams.get("location")?.trim() || "";
  const page = searchParams.get("page") || "1";

  try {
    // "All Gulf": query every GCC country at once, merge and de-duplicate.
    if (location === "ALL_GULF") {
      const settled = await Promise.allSettled(
        GULF_LOCATIONS.map((g) => fetchJooble(key, what, g.location, "1")),
      );
      const seen = new Set<string>();
      const merged: AdzunaJob[] = [];
      for (const s of settled) {
        if (s.status !== "fulfilled") continue;
        for (const job of s.value.results) {
          const dedupKey = job.url || job.externalId;
          if (dedupKey && !seen.has(dedupKey)) {
            seen.add(dedupKey);
            merged.push(job);
          }
        }
      }
      // `pooled` tells the browser to page through this whole list locally.
      return Response.json({ count: merged.length, results: merged, pooled: true });
    }

    const { total, results } = await fetchJooble(key, what, location, page);
    return Response.json({ count: total, results });
  } catch {
    return Response.json(
      { error: "Could not reach Jooble. Check your internet connection." },
      { status: 502 },
    );
  }
}
