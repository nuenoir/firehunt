// app/api/ai/status/route.ts
// GET: tells the UI whether live AI is switched on for this deployment (i.e. an
// Anthropic key is configured), so it can hide the AI buttons instead of showing
// ones that can only fail. Reveals a single boolean — never the key or anything
// about it — so it needs no sign-in.

export async function GET() {
  return Response.json(
    { enabled: Boolean(process.env.ANTHROPIC_API_KEY?.trim()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
