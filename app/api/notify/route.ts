// app/api/notify/route.ts
// The "Send me a summary now" button posts here. It authenticates with the
// signed-in user's own token (so only you can trigger your own WhatsApp), reads
// your jobs through RLS, and sends the same digest the daily job sends.

import { createClient } from "@supabase/supabase-js";
import { sendWhatsApp, summarizeJobs, type JobSummaryRow } from "@/lib/notify";

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return Response.json({ error: "Sync is not configured." }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  // Scope the client to the user's token: this both verifies the session and
  // makes the jobs query return only their own rows (via RLS).
  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    return Response.json({ error: "Invalid session." }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("jobs")
    .select("status,deadline,follow_up_date");
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const { text, summary } = summarizeJobs((data ?? []) as JobSummaryRow[]);
  const result = await sendWhatsApp(text);
  return Response.json({ sent: result.ok, detail: result.detail, summary });
}
