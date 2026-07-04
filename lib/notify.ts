// lib/notify.ts
// SERVER-ONLY. Sends a WhatsApp message via CallMeBot's free API. Kept behind
// this one function so switching providers later (e.g. Twilio) is a contained
// change — callers just call sendWhatsApp(text).

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
