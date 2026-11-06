// Reads a request body with a size limit, so a route never holds more than it means to accept.

/** The default limit, in bytes: about a quarter of a million tokens, for the dashboard analyst's turns. */
export const MAX_BODY_BYTES = 1_000_000;

/** The limit for a form-sized JSON request, in bytes, such as a mandate with its answers or policy. */
export const FORM_BODY_BYTES = 64 * 1024;

/**
 * The request body as text, or null when it is over `maxBytes`. A body that declares a larger
 * length is refused unread; any other is counted as it arrives, so one that misstates or leaves
 * out its length is stopped as soon as it passes the limit.
 */
export async function readBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
