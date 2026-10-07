// app/api/notify/route.ts
// The "WhatsApp me a summary" button. WhatsApp messages go to the OWNER's phone, so
// only the owner's signed-in session may trigger them — anyone else who signs in
// with a magic link gets a 403. The jobs are read through the caller's own session
// (row-level security), then summarised exactly as the daily digest does.
//
//   GET  -> { owner: boolean }   lets the UI show the button only to the owner
//   POST -> sends the summary

import { authenticate } from "@/lib/server/auth";
import { getAdminClient } from "@/lib/server/admin";
import { resolveOwnerId } from "@/lib/server/owner";
import { sendWhatsApp, summarizeJobs, type JobSummaryRow } from "@/lib/notify";

/** Is the signed-in caller the owner? Fails closed if it can't be determined. */
async function callerIsOwner(userId: string): Promise<boolean> {
  const admin = getAdminClient();
  if (!admin) return false;
  const ownerId = await resolveOwnerId(admin);
  return ownerId !== null && ownerId === userId;
}

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  return Response.json({ owner: await callerIsOwner(auth.user.id) });
}

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;

  if (!(await callerIsOwner(auth.user.id))) {
    return Response.json(
      { error: "WhatsApp summaries are only available to the account owner." },
      { status: 403 },
    );
  }

  const { data, error } = await auth.client
    .from("jobs")
    .select("status,deadline,follow_up_date");
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const { text, summary } = summarizeJobs((data ?? []) as JobSummaryRow[]);
  const result = await sendWhatsApp(text);
  return Response.json({ sent: result.ok, detail: result.detail, summary });
}
