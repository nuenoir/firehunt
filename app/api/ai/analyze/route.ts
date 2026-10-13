// app/api/ai/analyze/route.ts
// POST: assess how well one of the user's CVs fits one job, with evidence-backed
// strengths, honest gaps, tailored bullets and an outreach draft.
//
// Order matters: authenticate -> validate input -> read the CV -> check its size ->
// parse it -> spend guard -> model call. Cheap failures happen before any quota is
// consumed, and nothing is parsed until the file is known to be a sane size. The
// CV is read through the signed-in user's own session, so row-level security means
// nobody can ever analyse someone else's file.

import { z } from "zod";
import { authenticate } from "@/lib/server/auth";
import { getAdminClient } from "@/lib/server/admin";
import { consumeAiQuota } from "@/lib/server/aiQuota";
import { tooManyRequests } from "@/lib/server/rateLimit";
import { AI_NOT_ENABLED, llmErrorResponse } from "@/lib/server/aiHttp";
import { readJsonLimited } from "@/lib/server/body";
import { extractCvText } from "@/lib/cvText";
import { formatBytes } from "@/lib/cvs";
import { LIMITS } from "@/lib/limits";
import { callClaude } from "@/lib/ai/llm";
import { runFitAnalysis } from "@/lib/ai/service";
import {
  MAX_CV_CHARS,
  MAX_DESCRIPTION_CHARS,
  MIN_CV_CHARS,
  getModels,
} from "@/lib/ai/config";

export const maxDuration = 60;

const BodySchema = z.object({
  // The same limits as the database stores (lib/limits.ts), so a long page title that
  // saved fine can still be analysed.
  title: z.string().max(LIMITS.job.title),
  company: z.string().max(LIMITS.job.company),
  description: z.string(),
  cvId: z.uuid(),
  contacts: z
    .array(
      z.object({
        name: z.string().max(100),
        role: z.string().max(100),
        value: z.string().max(200),
      }),
    )
    .max(5)
    .default([]),
});

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(AI_NOT_ENABLED, { status: 503 });
  }

  const raw = await readJsonLimited(request, LIMITS.aiRequestBytes);
  if (!raw.ok) return Response.json({ error: raw.error }, { status: raw.status });
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(raw.data);
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (body.description.trim().length < 80) {
    return Response.json(
      {
        error:
          "Add the job description to this job's notes first — the analysis needs the posting text.",
      },
      { status: 422 },
    );
  }
  if (body.description.length > MAX_DESCRIPTION_CHARS) {
    return Response.json(
      { error: "The job description is too long to analyse (over 20,000 characters)." },
      { status: 413 },
    );
  }

  // Read the CV with the user's own session (RLS scopes both queries to them).
  const { data: row } = await auth.client
    .from("cvs")
    .select("name,type")
    .eq("id", body.cvId)
    .maybeSingle();
  if (!row) {
    return Response.json(
      {
        error:
          "That CV isn't in your cloud storage yet. Open the CVs tab while signed in so it syncs, then try again.",
      },
      { status: 404 },
    );
  }
  const { data: blob, error: downloadError } = await auth.client.storage
    .from("cvs")
    .download(`${auth.user.id}/${body.cvId}`);
  if (downloadError || !blob) {
    return Response.json(
      { error: "Couldn't load that CV file. Try re-uploading it." },
      { status: 404 },
    );
  }

  // Check the file's REAL size before handing it to the PDF / Word parsers. The "size"
  // column on the cvs row is written by the browser, so it can say anything; the
  // downloaded file cannot lie about its own length. Refusing here also keeps an
  // oversize file from costing the user an AI analysis.
  if (blob.size > LIMITS.cvFileBytes) {
    return Response.json(
      {
        error: `This CV file is too large to analyse (${formatBytes(blob.size)}). CV files can be at most ${formatBytes(LIMITS.cvFileBytes)}. Upload a smaller PDF or .docx.`,
      },
      { status: 413 },
    );
  }

  const cv = await extractCvText(
    new Uint8Array(await blob.arrayBuffer()),
    String(row.name),
    String(row.type),
    MIN_CV_CHARS,
  );
  if (!cv.ok) {
    return Response.json({ error: cv.message, code: cv.reason }, { status: 422 });
  }
  if (cv.text.length > MAX_CV_CHARS) {
    return Response.json(
      { error: "This CV is too long to analyse (over 40,000 characters)." },
      { status: 413 },
    );
  }

  const quota = await consumeAiQuota(getAdminClient(), auth.user.id);
  if (!quota.ok) {
    return tooManyRequests(
      quota.scope === "user"
        ? "You've used today's AI analyses. Try again tomorrow."
        : "The site has reached its daily AI limit. Try again tomorrow.",
      3600,
    );
  }

  const result = await runFitAnalysis(
    callClaude,
    {
      job: {
        title: body.title,
        company: body.company,
        description: body.description,
      },
      contacts: body.contacts,
      cvText: cv.text,
      cvId: body.cvId,
      cvName: String(row.name),
    },
    { model: getModels().analyze },
  );
  if (!result.ok) return llmErrorResponse(result);
  return Response.json({ analysis: result.value });
}
