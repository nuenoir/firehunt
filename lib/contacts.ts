// lib/contacts.ts
// Pure helpers for pulling recruiter contacts (emails / phone numbers) out of a
// job description, with a best-effort guess at whose contact each one is. No
// React, no browser APIs — kept separate so it is easy to unit-test.

/** A contact (email or phone) plus a best-effort guess at whose it is. */
export type Contact = { value: string; name: string };

/** Strip LinkedIn's trailing "…more" / "see more" toggle text from a captured note. */
export function cleanCapturedNotes(s: string): string {
  return s
    .replace(/\s*(?:…|\.\.\.)\s*(?:more|less)\s*$/i, "")
    .replace(/\n\s*(?:see|show)\s+(?:more|less)\s*$/i, "")
    .trim();
}

/** Capitalised words that can follow a trigger but aren't people, to avoid false labels. */
const NAME_STOP = new Set(
  "center centre team staff group office division department board call email phone mobile product owner manager senior junior lead role job apply now today please about we you your our us me the this that here there remote onsite hybrid monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);

function looksLikeName(s: string): boolean {
  return !!s && !NAME_STOP.has(s.split(/\s+/)[0].toLowerCase());
}

/** Best-effort: find a person's name mentioned right next to a contact in the text.
 *  Requires a trigger word ("contact/call/reach out to…") immediately followed by a
 *  Capitalised name — case-sensitive on the name so we don't grab "us"/"today". */
export function nameNear(text: string, value: string): string {
  const idx = text.indexOf(value);
  if (idx < 0) return "";
  const before = text.slice(Math.max(0, idx - 90), idx);
  const after = text.slice(idx + value.length, idx + value.length + 60);
  const re =
    /(?:[Cc]ontact|[Cc]all|[Rr]each(?:\s+out)?(?:\s+to)?|[Ss]peak\s+(?:to|with)|[Aa]sk\s+for|[Aa]ttention|[Aa]ttn|[Rr]egards|[Ss]incerely|[Ee]mail|[Mm]essage)[\s:,]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g;
  let m: RegExpExecArray | null;
  let last = "";
  while ((m = re.exec(before)) !== null) if (looksLikeName(m[1])) last = m[1];
  if (last) return last.trim();
  re.lastIndex = 0;
  while ((m = re.exec(after)) !== null)
    if (looksLikeName(m[1])) return m[1].trim();
  return "";
}

/** Derive a name from an email local part (rob → Rob), skipping role addresses. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] || "";
  if (
    /^(careers?|jobs?|hr|info|admin|hello|contact|recruit(?:ing|ment)?|talent|apply|applications?|team|support|office|no-?reply|enquir(?:y|ies)|sales|marketing)$/i.test(
      local,
    )
  )
    return "";
  const parts = local.split(/[._-]+/).filter((p) => /^[A-Za-z]{2,15}$/.test(p));
  if (parts.length === 0 || parts.length > 3) return "";
  return parts
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

/** Pull email + phone contacts out of a job's notes, each with a best-effort name. */
export function extractContacts(text: string): {
  emails: Contact[];
  phones: Contact[];
} {
  if (!text) return { emails: [], phones: [] };
  const uniqBy = (arr: Contact[]) => {
    const seen = new Set<string>();
    return arr.filter((c) =>
      seen.has(c.value) ? false : (seen.add(c.value), true),
    );
  };
  const emailStrs =
    text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
  const phoneStrs = (
    text.match(/(\+\d[\d ().\-]{6,}\d)|(\b0\d[\d ().\-]{7,}\d)/g) || []
  ).filter((p) => {
    const g = p.replace(/\D/g, "");
    return g.length >= 8 && g.length <= 15;
  });
  const emails = uniqBy(
    emailStrs.map((e) => {
      const v = e.trim();
      return { value: v, name: nameNear(text, v) || nameFromEmail(v) };
    }),
  );
  const phones = uniqBy(
    phoneStrs.map((p) => {
      const v = p.trim();
      return { value: v, name: nameNear(text, v) };
    }),
  );
  return { emails, phones };
}

/** A contact as stored on a job after AI extraction (richer than the heuristic one). */
export interface StoredContact {
  type: "email" | "phone";
  value: string;
  name: string; // "" when the posting doesn't say
  role: string; // "" when the posting doesn't say
}

/** Split stored (AI-extracted) contacts into the shape the contact chips render. */
export function splitStoredContacts(contacts: StoredContact[]): {
  emails: Contact[];
  phones: Contact[];
} {
  return {
    emails: contacts
      .filter((c) => c.type === "email")
      .map((c) => ({ value: c.value, name: c.name })),
    phones: contacts
      .filter((c) => c.type === "phone")
      .map((c) => ({ value: c.value, name: c.name })),
  };
}
