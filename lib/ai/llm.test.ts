// Exercises the REAL Anthropic SDK against a fake network, so we verify the exact
// request Claude would receive and how every failure mode is handled — without an
// API key or spending anything.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeClaude } from "./llm";

const Schema = z.object({ answer: z.string(), n: z.number().int() });

type Reply = () => Response;

function messageResponse(
  text: string,
  overrides: Record<string, unknown> = {},
): Reply {
  return () =>
    new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 7 },
        ...overrides,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function errorResponse(
  status: number,
  type: string,
  headers: Record<string, string> = {},
): Reply {
  return () =>
    new Response(
      JSON.stringify({ type: "error", error: { type, message: type } }),
      { status, headers: { "content-type": "application/json", ...headers } },
    );
}

/** A fake fetch that records requests; each call gets a FRESH response built from
 *  the (last) reply factory, so retries behave like a real network. */
function fakeFetch(...replies: Reply[]) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: new Headers(init?.headers),
    });
    const next = replies.length > 1 ? (replies.shift() as Reply) : replies[0];
    return next();
  };
  return { impl: impl as unknown as typeof fetch, requests };
}

const request = {
  model: "claude-opus-5-5",
  system: "SYSTEM PROMPT",
  user: "USER MESSAGE",
  schema: Schema,
  maxTokens: 500,
  effort: "low" as const,
};

describe("makeClaude", () => {
  it("sends a structured-output request and returns the parsed, validated data", async () => {
    const f = fakeFetch(messageResponse(JSON.stringify({ answer: "hi", n: 3 })));
    const llm = makeClaude({ apiKey: "sk-test", fetch: f.impl });

    const result = await llm(request);

    expect(result).toEqual({ ok: true, data: { answer: "hi", n: 3 }, model: "claude-opus-5-5" });
    expect(f.requests).toHaveLength(1);
    const { url, body, headers } = f.requests[0];
    expect(url).toContain("/v1/messages");
    expect(headers.get("x-api-key")).toBe("sk-test");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(500);
    expect(body.system).toBe("SYSTEM PROMPT");
    expect(body.messages).toEqual([{ role: "user", content: "USER MESSAGE" }]);

    const outputConfig = body.output_config as {
      effort?: string;
      format: { type: string; schema: { properties: Record<string, unknown> } };
    };
    expect(outputConfig.effort).toBe("low");
    expect(outputConfig.format.type).toBe("json_schema");
    expect(Object.keys(outputConfig.format.schema.properties)).toEqual(["answer", "n"]);
    // Deprecated / rejected parameters must not be sent.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
  });

  it("omits the effort parameter for Haiku-class models, which reject it", async () => {
    const f = fakeFetch(messageResponse(JSON.stringify({ answer: "hi", n: 1 })));
    const llm = makeClaude({ apiKey: "sk-test", fetch: f.impl });

    await llm({ ...request, model: "claude-haiku-4-5" });

    const outputConfig = f.requests[0].body.output_config as Record<string, unknown>;
    expect(outputConfig).not.toHaveProperty("effort");
    expect(outputConfig).toHaveProperty("format");
  });

  it("returns not_configured without touching the network when there is no key", async () => {
    const f = fakeFetch(messageResponse("{}"));
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await makeClaude({ fetch: f.impl })(request);
      expect(result).toMatchObject({ ok: false, code: "not_configured" });
      expect(f.requests).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("reports a safety refusal distinctly", async () => {
    const f = fakeFetch(messageResponse("", { stop_reason: "refusal", content: [] }));
    const result = await makeClaude({ apiKey: "k", fetch: f.impl })(request);
    expect(result).toMatchObject({ ok: false, code: "refused" });
  });

  it("reports truncation when the model hits max_tokens", async () => {
    const f = fakeFetch(
      messageResponse('{"answer":"cut', { stop_reason: "max_tokens" }),
    );
    const result = await makeClaude({ apiKey: "k", fetch: f.impl })(request);
    expect(result).toMatchObject({ ok: false, code: "truncated" });
  });

  it("rejects output that does not match the schema", async () => {
    const f = fakeFetch(messageResponse(JSON.stringify({ answer: 5, n: "x" })));
    const result = await makeClaude({ apiKey: "k", fetch: f.impl })(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["invalid_output", "upstream_error"]).toContain(result.code);
  });

  it("maps a provider rate limit to upstream_busy (after one retry)", async () => {
    const f = fakeFetch(errorResponse(429, "rate_limit_error", { "retry-after-ms": "1" }));
    const result = await makeClaude({ apiKey: "k", fetch: f.impl })(request);
    expect(result).toMatchObject({ ok: false, code: "upstream_busy" });
    expect(f.requests).toHaveLength(2); // the original attempt + one retry
  });

  it("treats a rejected API key as a configuration problem", async () => {
    const f = fakeFetch(errorResponse(401, "authentication_error"));
    const result = await makeClaude({ apiKey: "bad", fetch: f.impl })(request);
    expect(result).toMatchObject({ ok: false, code: "not_configured" });
    expect(f.requests).toHaveLength(1); // auth errors are not retried
  });

  it("maps any other provider failure to upstream_error without leaking details", async () => {
    const f = fakeFetch(errorResponse(400, "invalid_request_error"));
    const result = await makeClaude({ apiKey: "k", fetch: f.impl })(request);
    expect(result).toMatchObject({ ok: false, code: "upstream_error" });
    if (!result.ok) expect(result.message).not.toMatch(/invalid_request_error/);
  });
});
