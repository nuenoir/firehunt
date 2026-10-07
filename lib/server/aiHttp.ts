// lib/server/aiHttp.ts
// SERVER-ONLY. Maps AI failure codes to HTTP responses the UI can show verbatim.

import type { LlmErrorCode } from "../ai/llm";

export function llmErrorResponse(failure: {
  code: LlmErrorCode;
  message: string;
}): Response {
  const status =
    failure.code === "refused"
      ? 422
      : failure.code === "not_configured" || failure.code === "upstream_busy"
        ? 503
        : 502;
  return Response.json({ error: failure.message, code: failure.code }, { status });
}

export const AI_NOT_ENABLED = {
  error: "AI features aren't enabled on this server yet.",
  code: "not_configured",
} as const;
