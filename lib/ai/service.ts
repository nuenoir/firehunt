// lib/ai/service.ts
// The two AI use-cases, written as plain functions that take the model client as an
// argument. That keeps them independent of Next.js and the network: production
// passes the real client, tests and the eval harness pass fakes or real calls.

import { groundAnalysis, groundExtraction } from "./grounding";
import type { LlmErrorCode, LlmFn } from "./llm";
import {
  ANALYZE_SYSTEM,
  EXTRACT_SYSTEM,
  buildAnalyzeUser,
  buildExtractUser,
  type AnalyzePromptInput,
} from "./prompts";
import {
  ExtractionSchema,
  FitAnalysisSchema,
  type Extraction,
  type StoredAnalysis,
} from "./schemas";

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LlmErrorCode; message: string };

export interface ExtractInput {
  title: string;
  company: string;
  url: string;
  salary: string;
  text: string;
  countries: readonly string[];
  today: string; // YYYY-MM-DD
}

/** Turn a captured job page into clean, verified, structured fields. */
export async function runExtraction(
  llm: LlmFn,
  input: ExtractInput,
  opts: { model: string; now?: Date },
): Promise<ServiceResult<Extraction>> {
  const res = await llm({
    model: opts.model,
    system: EXTRACT_SYSTEM,
    user: buildExtractUser(input),
    schema: ExtractionSchema,
    maxTokens: 4000,
    effort: "low",
  });
  if (!res.ok) return res;
  const source = [input.title, input.company, input.salary, input.url, input.text]
    .filter(Boolean)
    .join("\n");
  return {
    ok: true,
    value: groundExtraction(res.data, source, input.countries, opts.now),
  };
}

export interface AnalyzeInput extends AnalyzePromptInput {
  cvId: string;
  cvName: string;
}

/** Assess CV-to-job fit, then verify every quoted claim against the real CV. */
export async function runFitAnalysis(
  llm: LlmFn,
  input: AnalyzeInput,
  opts: { model: string; now?: Date },
): Promise<ServiceResult<StoredAnalysis>> {
  const res = await llm({
    model: opts.model,
    system: ANALYZE_SYSTEM,
    user: buildAnalyzeUser(input),
    schema: FitAnalysisSchema,
    maxTokens: 12000,
    effort: "medium",
  });
  if (!res.ok) return res;
  const grounded = groundAnalysis(res.data, input.cvText);
  return {
    ok: true,
    value: {
      ...grounded.analysis,
      generated_at: (opts.now ?? new Date()).toISOString(),
      cv_id: input.cvId,
      cv_name: input.cvName,
      model: opts.model,
      removed_unverified: grounded.removed,
      confidence: grounded.confidence,
    },
  };
}
