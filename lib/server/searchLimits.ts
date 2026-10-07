// lib/server/searchLimits.ts
// SERVER-ONLY. Protects the shared job-search quotas. Adzuna's free plan rate-limits
// the whole API key (not each visitor) and does so below our old per-IP limit, so
// one busy visitor could lock everyone else out. Two layers, checked in this order:
//
//   1. per visitor (by IP): stops any one person from hogging the quota
//   2. site-wide per provider: keeps total traffic under the provider's own limit
//
// A visitor who is already over their personal limit is rejected BEFORE touching
// the site-wide counter, so abuse can't burn the shared allowance. If the counter
// store is unreachable we fail open: search availability matters more than the cap.

import { getAdminClient } from "./admin";
import { checkRateLimit, clientIp, tooManyRequests } from "./rateLimit";

export type SearchProvider = "adzuna" | "jooble";

/** Searches per minute. Adzuna's free plan has been observed to cut off at a
 *  similar level, so its site-wide cap sits just under that. */
export const SEARCH_LIMITS = {
  perIpPerMinute: 12,
  siteWidePerMinute: { adzuna: 20, jooble: 30 } as Record<SearchProvider, number>,
} as const;

const WINDOW_SECONDS = 60;

/** Returns a 429 response if this request must be refused, or null to proceed.
 *  `upstreamCalls` is how many provider calls the request will make (the "All Gulf"
 *  search fans out to six), counted against the site-wide allowance. */
export async function enforceSearchLimits(
  request: Request,
  provider: SearchProvider,
  upstreamCalls = 1,
): Promise<Response | null> {
  const admin = getAdminClient();

  const visitorOk = await checkRateLimit(
    admin,
    `search:ip:${clientIp(request)}`,
    WINDOW_SECONDS,
    SEARCH_LIMITS.perIpPerMinute,
    "allow",
  );
  if (!visitorOk) {
    return tooManyRequests(
      "Too many searches. Please wait a minute and try again.",
      WINDOW_SECONDS,
    );
  }

  for (let i = 0; i < upstreamCalls; i++) {
    const siteOk = await checkRateLimit(
      admin,
      `search:${provider}:site`,
      WINDOW_SECONDS,
      SEARCH_LIMITS.siteWidePerMinute[provider],
      "allow",
    );
    if (!siteOk) {
      return tooManyRequests(
        "Job search is busy right now. Please try again in a minute.",
        30,
      );
    }
  }
  return null;
}
