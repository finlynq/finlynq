/**
 * Read a request body that arrived WITHOUT a Content-Length header (chunked
 * transfer encoding), stopping as soon as it passes `maxBytes`.
 *
 * GH #424 follow-up (2026-11-21): /api/mcp answered 411 to any POST with no
 * Content-Length. The Gemini web app sends its MCP `initialize` chunked, so the
 * 411 is what made Gemini call the server "not a valid MCP server" (seen in the
 * dev access log: HEAD/GET 405, metadata 200, POST 411). A body with a declared
 * length is still checked against the cap from the header before anything is read.
 */
export type BoundedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" };

export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBody> {
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}
