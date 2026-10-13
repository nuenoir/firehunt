// lib/server/body.ts
// SERVER-ONLY. Reads a JSON request body, but refuses to read an enormous one into
// memory. `request.json()` will happily swallow whatever it is sent (the hosting
// platform stops it at a few megabytes), so the AI routes put a much lower ceiling on
// it first: the biggest honest request is about 20,000 characters of text plus a few
// short fields.

export type JsonBody =
  | { ok: true; data: unknown }
  | { ok: false; status: 400 | 413; error: string };

/** A response saying the request body was too big, in the app's usual error shape. */
const TOO_BIG: JsonBody = {
  ok: false,
  status: 413,
  error: "That request is too large to process.",
};

/**
 * Read the body as JSON, at most `maxBytes` bytes of it. A Content-Length header that
 * already says it is too big is refused without reading anything; the body is also
 * counted as it arrives, because the header can be missing or wrong.
 */
export async function readJsonLimited(request: Request, maxBytes: number): Promise<JsonBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return TOO_BIG;

  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return TOO_BIG;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      return { ok: false, status: 400, error: "Invalid request." };
    }
  }

  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid request." };
  }
}
