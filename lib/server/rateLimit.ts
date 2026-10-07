// lib/server/rateLimit.ts
// SERVER-ONLY. Fixed-window rate limiting backed by Postgres (the `hit_rate_limit`
// function in supabase/schema.sql), so counters are shared across serverless
// instances. Two policies for when the counter store is unreachable:
//   - "allow": fail open  (public search routes — availability matters more)
//   - "deny":  fail closed (paid AI calls — never risk uncapped spend)

import type { SupabaseClient } from "@supabase/supabase-js";

export type OnUnavailable = "allow" | "deny";

/** Count one hit against `key`; returns true if it is within `limit` per window. */
export async function checkRateLimit(
  admin: SupabaseClient | null,
  key: string,
  windowSeconds: number,
  limit: number,
  onUnavailable: OnUnavailable,
): Promise<boolean> {
  const fallback = onUnavailable === "allow";
  if (!admin) return fallback;
  try {
    const { data, error } = await admin.rpc("hit_rate_limit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    if (error) return fallback;
    return data === true;
  } catch {
    return fallback;
  }
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  return Response.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
