// app/api/adzuna/route.ts
// A small server-side endpoint at /api/adzuna. The browser calls this, and
// THIS code calls Adzuna — so your secret API key stays on the server and is
// never shipped to the user's browser.

import { mapAdzunaResults } from "@/lib/adzuna";
import { enforceSearchLimits } from "@/lib/server/searchLimits";
import { parseAdzunaSearch } from "@/lib/server/searchParams";

export async function GET(request: Request) {
  // Check the query string FIRST. This endpoint is public and puts our secret key on
  // the upstream request, so nothing the caller typed may reach that URL unchecked
  // (a made-up "country" could otherwise steer the call at a different Adzuna
  // endpoint). Doing it before the rate limiter also means junk costs no database
  // round-trip.
  const search = parseAdzunaSearch(new URL(request.url).searchParams);
  if (!search.ok) {
    return Response.json({ error: search.error }, { status: search.status });
  }

  // Protect the shared Adzuna quota (per visitor and site-wide).
  const limited = await enforceSearchLimits(request, "adzuna");
  if (limited) return limited;

  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;

  // If the keys aren't set up yet, tell the user clearly instead of failing.
  if (!appId || !appKey || appId === "your_app_id_here") {
    return Response.json(
      {
        error:
          "Adzuna keys aren't set. Add ADZUNA_APP_ID and ADZUNA_APP_KEY to .env.local, then restart the dev server.",
      },
      { status: 500 },
    );
  }

  const { country, what, where, page, sort } = search;

  // Build the Adzuna request URL with our secret credentials attached. Only the
  // validated values are used (and still encoded, as a second line of defence).
  const adzunaUrl = new URL(
    `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${encodeURIComponent(page)}`,
  );
  adzunaUrl.searchParams.set("app_id", appId);
  adzunaUrl.searchParams.set("app_key", appKey);
  adzunaUrl.searchParams.set("results_per_page", "30");
  adzunaUrl.searchParams.set("content-type", "application/json");
  if (what) adzunaUrl.searchParams.set("what", what);
  if (where) adzunaUrl.searchParams.set("where", where);
  if (sort === "date") adzunaUrl.searchParams.set("sort_by", "date");

  try {
    const res = await fetch(adzunaUrl, { cache: "no-store" });
    if (!res.ok) {
      return Response.json(
        { error: `Adzuna returned an error (HTTP ${res.status}).` },
        { status: res.status },
      );
    }
    const data = await res.json();
    return Response.json({
      count: data.count ?? 0,
      results: mapAdzunaResults(data.results ?? [], country),
    });
  } catch {
    return Response.json(
      { error: "Could not reach Adzuna. Check your internet connection." },
      { status: 502 },
    );
  }
}
