// lib/server/owner.ts
// SERVER-ONLY. FireHunt has one owner: the person whose WhatsApp number the
// notifications go to. Anyone can sign in with a magic link, so features that
// touch the owner's phone (daily digest, "WhatsApp me a summary") must be tied to
// the owner's account and nobody else's.
//
// The owner is OWNER_USER_ID from the environment. If that isn't set yet we fall
// back to "the one account that has any jobs" — safe while there is a single user
// — and refuse (return null) the moment there are several, rather than guess.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveOwnerId(
  admin: SupabaseClient,
): Promise<string | null> {
  const fromEnv = process.env.OWNER_USER_ID?.trim();
  if (fromEnv) return fromEnv;

  const { data, error } = await admin.from("jobs").select("user_id").limit(1000);
  if (error || !data) return null;
  const ids = new Set((data as { user_id: string }[]).map((r) => r.user_id));
  return ids.size === 1 ? [...ids][0] : null;
}
