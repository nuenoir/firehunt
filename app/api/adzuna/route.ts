// app/api/adzuna/route.ts
// A small server-side endpoint at /api/adzuna. The browser calls this, and
// THIS code calls Adzuna — so your secret API key stays on the server and is
// never shipped to the user's browser.

import { mapAdzunaResults } from "@/lib/adzuna";
import { enforceSearchLimits } from "@/lib/server/searchLimits";

export async function GET(request: Request) {
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

  const { searchParams } = new URL(request.url);
  const country = (searchParams.get("country") || "au").toLowerCase();
  const what = searchParams.get("what")?.trim() || "";
  const where = searchParams.get("where")?.trim() || "";
  const page = searchParams.get("page") || "1";
  const sort = searchParams.get("sort") || ""; // "date" surfaces newer, more varied roles

  // Build the Adzuna request URL with our secret credentials attached.
  const adzunaUrl = new URL(
    `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`,
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
