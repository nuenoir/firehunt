// lib/ai/config.ts
// Tunables for the AI features, read from the environment at call time so they
// can be changed in Vercel without a code change. Sensible defaults throughout.

/** Which Claude model handles each task. Defaults to the current Opus; switch
 *  extraction to a cheaper model (e.g. claude-haiku-4-5) with AI_MODEL_EXTRACT. */
export function getModels(): { analyze: string; extract: string } {
  return {
    analyze: process.env.AI_MODEL_ANALYZE?.trim() || "claude-opus-5-5",
    extract: process.env.AI_MODEL_EXTRACT?.trim() || "claude-opus-5-5",
  };
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Spend guards: AI calls allowed per signed-in user per day, and in total per day. */
export function getAiLimits(): { perUserPerDay: number; globalPerDay: number } {
  return {
    perUserPerDay: intFromEnv("AI_DAILY_LIMIT_PER_USER", 15),
    globalPerDay: intFromEnv("AI_DAILY_LIMIT_GLOBAL", 150),
  };
}

/** Input caps. Over-long input is rejected with a clear message rather than being
 *  silently truncated — a half-read CV or posting would give misleading results. */
export const MAX_DESCRIPTION_CHARS = 20_000;
export const MAX_CV_CHARS = 40_000;
export const MAX_CAPTURE_CHARS = 20_000;
export const MIN_CV_CHARS = 200;
