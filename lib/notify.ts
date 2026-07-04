// lib/notify.ts
// SERVER-ONLY. Sends a WhatsApp message via CallMeBot's free API. Kept behind
// this one function so switching providers later (e.g. Twilio) is a contained
// change — callers just call sendWhatsApp(text).

import { STATUSES } from "./jobs";

export async function sendWhatsApp(
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) {
    return { ok: false, detail: "CALLMEBOT_PHONE / CALLMEBOT_APIKEY not set" };
  }
  // CallMeBot's free tier rejects many non-ASCII characters (emojis, dashes),
  // so keep tab/newline/CR + printable ASCII only.
  const safe = text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(safe)}&apikey=${encodeURIComponent(apikey)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.text();
    const ok = /queued|sent/i.test(body);
    return { ok, detail: body.replace(/<[^>]*>/g, "").trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/** Build the plain-text daily digest from job counts. */
export function buildDigest(input: {
  total: number;
  byStage: { label: string; n: number }[];
  followUps: number;
  deadlines: number;
}): string {
  const stageLine =
    input.byStage
      .filter((x) => x.n > 0)
      .map((x) => `${x.label} ${x.n}`)
      .join(", ") || "none yet";
  return [
    "FireHunt daily update",
    "",
    `Saved jobs: ${input.total}`,
    `By stage: ${stageLine}`,
    "",
    `Follow-ups due today or overdue: ${input.followUps}`,
    `Deadlines in the next 7 days: ${input.deadlines}`,
    "",
    "Open your board: https://firehunt.vercel.app",
  ].join("\n");
}

export interface JobSummaryRow {
  status: string;
  deadline: string | null;
  follow_up_date: string | null;
}

/** Count the jobs and produce the digest text — shared by the cron job and the
 *  "send now" button so they always say the same thing. */
export function summarizeJobs(rows: JobSummaryRow[]): {
  text: string;
  summary: { total: number; followUps: number; deadlines: number };
} {
  const total = rows.length;
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const active = rows.filter((r) => r.status !== "rejected");
  const followUps = active.filter(
    (r) => r.follow_up_date && r.follow_up_date <= today,
  ).length;
  const deadlines = active.filter(
    (r) => r.deadline && r.deadline >= today && r.deadline <= in7,
  ).length;
  const byStage = STATUSES.map((s) => ({
    label: s.label,
    n: rows.filter((r) => r.status === s.id).length,
  }));
  return { text: buildDigest({ total, byStage, followUps, deadlines }), summary: { total, followUps, deadlines } };
}
