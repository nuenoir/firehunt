// lib/ai/schemas.ts
// The shapes of what the AI returns. Each schema doubles as (1) the JSON schema
// sent to Claude as a structured-output constraint and (2) a runtime validator
// for what comes back — we never trust model output without checking it.
//
// Unknown values are empty strings rather than null/optional: structured outputs
// handle plain required strings most reliably, and the UI treats "" as "not found".

import { z } from "zod";

// ---------------------------------------------------------------------------
// 1) Capture extraction: turn a captured job page into clean, structured fields
// ---------------------------------------------------------------------------

export const ExtractionSchema = z.object({
  title: z.string().describe("Clean job title only — no company or job-board name"),
  company: z.string().describe("The hiring employer, or '' if not stated"),
  country: z.string().describe("Country where the job is located"),
  salary: z.string().describe("Salary exactly as stated in the posting, or ''"),
  deadline: z
    .string()
    .describe("Application closing date as YYYY-MM-DD if explicitly stated, else ''"),
  contacts: z
    .array(
      z.object({
        type: z.enum(["email", "phone"]),
        value: z.string().describe("The email address or phone number, verbatim"),
        name: z.string().describe("Person this contact belongs to, or ''"),
        role: z.string().describe("That person's role, or ''"),
      }),
    )
    .describe("Only emails and phone numbers that literally appear in the text"),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// ---------------------------------------------------------------------------
// 2) Fit analysis: how well a CV matches a job, with evidence
// ---------------------------------------------------------------------------

export const FitAnalysisSchema = z.object({
  fit_score: z.number().int().describe("0-100 overall fit"),
  verdict: z.string().describe("One honest sentence summarising the fit"),
  strengths: z.array(
    z.object({
      point: z.string().describe("Why the candidate fits this requirement"),
      job_requirement: z.string().describe("The requirement from the posting"),
      cv_evidence: z
        .string()
        .describe("A short VERBATIM quote from the CV that supports the point"),
    }),
  ),
  gaps: z.array(
    z.object({
      requirement: z.string().describe("A requirement the CV does not evidence"),
      note: z.string().describe("One sentence on how to address or frame the gap"),
    }),
  ),
  tailored_bullets: z.array(
    z.object({
      bullet: z
        .string()
        .describe("A CV bullet reworded toward this role, using only real experience"),
      cv_evidence: z
        .string()
        .describe("A short VERBATIM quote from the CV that this bullet is based on"),
    }),
  ),
  outreach: z.object({
    email_subject: z.string(),
    email_body: z.string(),
    whatsapp_message: z.string(),
  }),
});

export type FitAnalysis = z.infer<typeof FitAnalysisSchema>;

export type Confidence = "high" | "medium" | "low";

/** A fit analysis as stored on a job, with provenance and verification metadata. */
export interface StoredAnalysis extends FitAnalysis {
  generated_at: string; // ISO timestamp
  cv_id: string;
  cv_name: string;
  model: string;
  /** Claims dropped because their CV quote could not be found in the CV text. */
  removed_unverified: number;
  confidence: Confidence;
  /** True for the canned sample shown in demo mode (no AI call was made). */
  demo?: boolean;
}
