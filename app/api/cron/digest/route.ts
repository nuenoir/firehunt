// app/api/cron/digest/route.ts
// A scheduled endpoint that WhatsApps a daily summary of the OWNER's job board.
// Triggered by Vercel Cron (see vercel.json), which sends the CRON_SECRET as a
// Bearer token. Runs server-side with the Supabase service key so it can read the
// jobs even though nobody is logged in — which is exactly why it must filter to the
// owner's rows itself: the service key bypasses row-level security, and other
// people may have signed up since.

import { getAdminClient } from "@/lib/server/admin";
import { resolveOwnerId } from "@/lib/server/owner";
import { sendWhatsApp, summarizeJobs, type JobSummaryRow } from "@/lib/notify";

export async function GET(request: Request) {
  // Only Vercel Cron (or someone with the secret) may trigger this.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = getAdminClient();
  if (!admin) {
    return Response.json(
      { error: "Supabase server env vars are not set." },
      { status: 500 },
    );
  }

  const ownerId = await resolveOwnerId(admin);
  if (!ownerId) {
    return Response.json(
      {
        error:
          "Could not determine the owner account. Set OWNER_USER_ID in the environment.",
      },
      { status: 500 },
    );
  }

  const { data, error } = await admin
    .from("jobs")
    .select("status,deadline,follow_up_date")
    .eq("user_id", ownerId);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const { text, summary } = summarizeJobs((data ?? []) as JobSummaryRow[]);
  const result = await sendWhatsApp(text);

  // Housekeeping: drop rate-limit counters older than two days. Never fatal.
  try {
    await admin
      .from("rate_limits")
      .delete()
      .lt("window_start", new Date(Date.now() - 2 * 86_400_000).toISOString());
  } catch {
    /* the table may not exist yet; ignore */
  }

  return Response.json({ sent: result.ok, detail: result.detail, summary });
}
