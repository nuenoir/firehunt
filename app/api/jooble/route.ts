// app/api/jooble/route.ts
// Server-side call to the Jooble jobs API (covers the Gulf, which Adzuna does
// not). Keeps the key on the server. Returns the SAME shape as /api/adzuna, so
// the search UI can treat both sources identically.

import { mapJoobleResults } from "@/lib/jooble";

export async function GET(request: Request) {
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

  try {
    // Jooble wants a POST with the key in the URL path and a JSON body.
    const res = await fetch(`https://jooble.org/api/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords: what, location, page: "1" }),
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json(
        { error: `Jooble returned an error (HTTP ${res.status}).` },
        { status: res.status },
      );
    }
    const data = await res.json();
    return Response.json({
      count: data.totalCount ?? 0,
      results: mapJoobleResults(data.jobs ?? []),
    });
  } catch {
    return Response.json(
      { error: "Could not reach Jooble. Check your internet connection." },
      { status: 502 },
    );
  }
}
