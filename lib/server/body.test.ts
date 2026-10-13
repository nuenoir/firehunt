import { describe, expect, it } from "vitest";
import { readJsonLimited } from "./body";
import { secretsMatch } from "./secret";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://x.test/api", { method: "POST", body, headers });

/** A body delivered in pieces with no Content-Length, like a chunked upload. */
function chunked(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe("readJsonLimited", () => {
  it("reads a normal JSON body", async () => {
    const res = await readJsonLimited(post(JSON.stringify({ a: 1, text: "héllo 日本語 😀" })), 1000);
    expect(res).toEqual({ ok: true, data: { a: 1, text: "héllo 日本語 😀" } });
  });

  it("accepts a body of exactly the limit, and refuses one byte more", async () => {
    const body = JSON.stringify({ t: "x".repeat(90) }); // ASCII: bytes = characters
    const n = body.length;
    expect((await readJsonLimited(post(body), n)).ok).toBe(true);
    const over = await readJsonLimited(post(body), n - 1);
    expect(over).toMatchObject({ ok: false, status: 413 });
  });

  it("counts bytes, not characters: multi-byte text is bigger than it looks", async () => {
    const body = JSON.stringify({ t: "😀".repeat(100) }); // 4 bytes each
    expect(body.length).toBeLessThan(250);
    expect(await readJsonLimited(post(body), 250)).toMatchObject({ ok: false, status: 413 });
    expect((await readJsonLimited(post(body), 450)).ok).toBe(true);
  });

  it("refuses on the declared Content-Length without reading the body at all", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.close();
      },
    });
    const req = new Request("https://x.test/api", {
      method: "POST",
      body: stream,
      headers: { "content-length": "999999" },
      // @ts-expect-error -- required by Node's fetch when the body is a stream
      duplex: "half",
    });
    const res = await readJsonLimited(req, 1000);
    expect(res).toMatchObject({ ok: false, status: 413 });
    expect(req.bodyUsed).toBe(false); // nobody even started reading it
  });

  it("does not trust a missing or false Content-Length: a streamed body is counted as it arrives", async () => {
    const big = chunked(['{"t":"', "x".repeat(600), "y".repeat(600), '"}']);
    const req = new Request("https://x.test/api", {
      method: "POST",
      body: big,
      headers: { "content-length": "10" }, // lies
      // @ts-expect-error -- required by Node's fetch when the body is a stream
      duplex: "half",
    });
    expect(await readJsonLimited(req, 1000)).toMatchObject({ ok: false, status: 413 });
  });

  it("stops reading once the limit is passed", async () => {
    let chunksRead = 0;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++;
        controller.enqueue(enc.encode("x".repeat(500)));
      },
    });
    const req = new Request("https://x.test/api", {
      method: "POST",
      body: stream,
      // @ts-expect-error -- required by Node's fetch when the body is a stream
      duplex: "half",
    });
    expect(await readJsonLimited(req, 1000)).toMatchObject({ ok: false, status: 413 });
    expect(chunksRead).toBeLessThan(10); // an endless body does not hang or fill memory
  });

  it("reports malformed JSON and an empty body as 400, not 413", async () => {
    expect(await readJsonLimited(post("not json"), 1000)).toMatchObject({ ok: false, status: 400 });
    expect(await readJsonLimited(post(""), 1000)).toMatchObject({ ok: false, status: 400 });
    expect(await readJsonLimited(post(null), 1000)).toMatchObject({ ok: false, status: 400 });
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const full = JSON.stringify({ t: "日本語😀" });
    const bytes = new TextEncoder().encode(full);
    // Cut in the middle of a multi-byte character.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 9));
        controller.enqueue(bytes.slice(9));
        controller.close();
      },
    });
    const req = new Request("https://x.test/api", {
      method: "POST",
      body: stream,
      // @ts-expect-error -- required by Node's fetch when the body is a stream
      duplex: "half",
    });
    expect(await readJsonLimited(req, 1000)).toEqual({ ok: true, data: { t: "日本語😀" } });
  });
});

describe("secretsMatch", () => {
  it("matches only the exact secret", () => {
    expect(secretsMatch("Bearer abc123", "Bearer abc123")).toBe(true);
    expect(secretsMatch("Bearer abc124", "Bearer abc123")).toBe(false);
    expect(secretsMatch("bearer abc123", "Bearer abc123")).toBe(false);
  });

  it("handles different lengths and empty values without throwing", () => {
    expect(secretsMatch("", "Bearer abc123")).toBe(false);
    expect(secretsMatch("Bearer abc123 ", "Bearer abc123")).toBe(false);
    expect(secretsMatch("x".repeat(10_000), "Bearer abc123")).toBe(false);
    expect(secretsMatch("", "")).toBe(true); // callers must reject an empty secret themselves
  });
});
