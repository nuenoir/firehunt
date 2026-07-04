// app/api/cron/digest/route.ts
// A scheduled endpoint that WhatsApps a daily summary of the job board.
// Triggered by Vercel Cron (see vercel.json), which sends the CRON_SECRET as a
// Bearer token. Runs server-side with the Supabase service key so it can read
// the jobs even though nobody is logged in. Single-user by design: it summarises
// every job in the account (fine for a personal deployment).

import { createClient } from "@supabase/supabase-js";
import { sendWhatsApp, summarizeJobs, type JobSummaryRow } from "@/lib/notify";

export async function GET(request: Request) {
  // Only Vercel Cron (or someone with the secret) may trigger this.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return Response.json(
      { error: "Supabase server env vars are not set." },
      { status: 500 },
    );
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
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
