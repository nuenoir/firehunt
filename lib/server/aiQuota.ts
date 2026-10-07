// lib/server/aiQuota.ts
// SERVER-ONLY. Spend guard for the AI features: every model call must first win a
// slot in a per-user daily allowance AND a global daily allowance, so the worst
// case cost of any day is bounded no matter who is using the site.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAiLimits } from "../ai/config";
import { checkRateLimit } from "./rateLimit";

const DAY_SECONDS = 86_400;

export type QuotaResult =
  | { ok: true }
  | { ok: false; scope: "user" | "global" };

export async function consumeAiQuota(
  admin: SupabaseClient | null,
  userId: string,
): Promise<QuotaResult> {
  const { perUserPerDay, globalPerDay } = getAiLimits();
  // Fail closed: if the counter store is down, no paid call is made.
  const userOk = await checkRateLimit(
    admin,
    `ai:user:${userId}`,
    DAY_SECONDS,
    perUserPerDay,
    "deny",
  );
  if (!userOk) return { ok: false, scope: "user" };
  const globalOk = await checkRateLimit(
    admin,
    "ai:global",
    DAY_SECONDS,
    globalPerDay,
    "deny",
  );
  if (!globalOk) return { ok: false, scope: "global" };
  return { ok: true };
}
