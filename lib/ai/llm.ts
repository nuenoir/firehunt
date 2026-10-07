// lib/ai/llm.ts
// SERVER-ONLY. The single place FireHunt talks to the Claude API. It sends a
// structured-output request (JSON schema from a zod schema), validates what comes
// back, and turns every failure mode into a typed result instead of an exception,
// so routes can map them to clear HTTP statuses and user messages.
//
// The model client is created per call and accepts an injected `fetch`, which is
// how the unit tests exercise the real SDK request/response path with no network.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";

export type LlmErrorCode =
  | "not_configured" // no API key (or the key was rejected)
  | "refused" // the model's safety classifiers declined the request
  | "truncated" // hit max_tokens before finishing
  | "invalid_output" // response didn't match the schema
  | "upstream_busy" // provider rate limit / overload — retry later
  | "upstream_error"; // any other provider or network failure

export type LlmResult<T> =
  | { ok: true; data: T; model: string }
  | { ok: false; code: LlmErrorCode; message: string };

export interface LlmRequest<T> {
  model: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  maxTokens: number;
  effort?: "low" | "medium" | "high";
}

export type LlmFn = <T>(req: LlmRequest<T>) => Promise<LlmResult<T>>;

/** Haiku-class models reject the `effort` parameter; everything newer accepts it. */
function supportsEffort(model: string): boolean {
  return !/haiku/i.test(model);
}

export function makeClaude(
  opts: { apiKey?: string; fetch?: typeof fetch } = {},
): LlmFn {
  return async function call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        code: "not_configured",
        message: "AI features are not configured on this server.",
      };
    }

    const client = new Anthropic({
      apiKey,
      maxRetries: 1,
      timeout: 50_000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });

    try {
      // We use messages.create (not messages.parse) so the stop reason is checked
      // BEFORE any JSON parsing: a response cut off at max_tokens is invalid JSON,
      // and parse() would throw on it instead of letting us report "truncated".
      const response = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: {
          ...(req.effort && supportsEffort(req.model)
            ? { effort: req.effort }
            : {}),
          format: zodOutputFormat(req.schema),
        },
      });

      // Token counts only — never log prompt or response content (it holds
      // people's CVs and job-hunt details).
      console.info(
        JSON.stringify({
          evt: "ai_call",
          model: req.model,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          stop_reason: response.stop_reason,
        }),
      );

      if (response.stop_reason === "refusal") {
        return {
          ok: false,
          code: "refused",
          message:
            "The AI declined to process this content. Try a different posting or CV.",
        };
      }
      if (response.stop_reason === "max_tokens") {
        return {
          ok: false,
          code: "truncated",
          message: "The AI response was cut off. Please try again.",
        };
      }
      // The schema is enforced by the API, but we still validate: never trust
      // model output without checking it against the contract.
      const textBlock = response.content.find((b) => b.type === "text");
      let parsed: unknown;
      try {
        parsed = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "");
      } catch {
        parsed = undefined;
      }
      const checked = req.schema.safeParse(parsed);
      if (!checked.success) {
        return {
          ok: false,
          code: "invalid_output",
          message: "The AI returned an unexpected response. Please try again.",
        };
      }
      return { ok: true, data: checked.data, model: req.model };
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        return {
          ok: false,
          code: "upstream_busy",
          message: "The AI service is busy right now. Please try again shortly.",
        };
      }
      if (error instanceof Anthropic.AuthenticationError) {
        console.error("ai_call: the Anthropic API key was rejected");
        return {
          ok: false,
          code: "not_configured",
          message: "The server's AI key was rejected. The site owner needs to fix it.",
        };
      }
      const status = error instanceof Anthropic.APIError ? error.status : "n/a";
      console.error(`ai_call failed (status ${status})`);
      return {
        ok: false,
        code: "upstream_error",
        message: "The AI service had a problem. Please try again.",
      };
    }
  };
}

/** The production model client (reads ANTHROPIC_API_KEY from the environment). */
export const callClaude: LlmFn = makeClaude();
