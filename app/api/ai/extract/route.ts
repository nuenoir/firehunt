// app/api/ai/extract/route.ts
// POST: turn a job page captured by the bookmarklet into clean structured fields
// (title, company, city, country, salary, deadline, named contacts). Everything the
// model returns is verified against the captured text before it is sent back.

import { z } from "zod";
import { authenticate } from "@/lib/server/auth";
import { getAdminClient } from "@/lib/server/admin";
import { consumeAiQuota } from "@/lib/server/aiQuota";
import { tooManyRequests } from "@/lib/server/rateLimit";
import { AI_NOT_ENABLED, llmErrorResponse } from "@/lib/server/aiHttp";
import { callClaude } from "@/lib/ai/llm";
import { runExtraction } from "@/lib/ai/service";
import { MAX_CAPTURE_CHARS, getModels } from "@/lib/ai/config";
import { COUNTRIES } from "@/lib/jobs";

export const maxDuration = 60;

const BodySchema = z.object({
  title: z.string().max(500),
  company: z.string().max(500),
  url: z.string().max(2000),
  salary: z.string().max(200),
  text: z.string(),
});

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(AI_NOT_ENABLED, { status: 503 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (body.text.length > MAX_CAPTURE_CHARS) {
    return Response.json(
      { error: "The captured text is too long to process." },
      { status: 413 },
    );
  }
  if (!body.title.trim() && body.text.trim().length < 40) {
    return Response.json(
      { error: "There isn't enough captured text to extract from." },
      { status: 422 },
    );
  }

  const quota = await consumeAiQuota(getAdminClient(), auth.user.id);
  if (!quota.ok) {
    return tooManyRequests(
      quota.scope === "user"
        ? "You've used today's AI allowance."
        : "The site has reached its daily AI limit.",
      3600,
    );
  }

  const result = await runExtraction(
    callClaude,
    {
      ...body,
      countries: COUNTRIES,
      today: new Date().toISOString().slice(0, 10),
    },
    { model: getModels().extract },
  );
  if (!result.ok) return llmErrorResponse(result);
  return Response.json({ extraction: result.value });
}
