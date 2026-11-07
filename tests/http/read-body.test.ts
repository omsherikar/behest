import { describe, expect, it } from 'vitest';
import { FORM_BODY_BYTES, MAX_BODY_BYTES, readBody } from '@/lib/http/read-body';

/** A request whose body arrives as `chunks` 1 KiB pieces, which says how many were read and whether it was cancelled. */
function streamedRequest(chunks: number, headers: Record<string, string> = {}) {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls === chunks) return controller.close();
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  // A streamed body needs `duplex: 'half'`, which the RequestInit type does not list.
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' };
  return { request: new Request('http://localhost/api', init), pulled: () => pulls, cancelled: () => cancelled };
}

describe('readBody', () => {
  it('limits bodies to 1,000,000 bytes by default and to 64 KiB for form-sized requests', () => {
    expect(MAX_BODY_BYTES).toBe(1_000_000);
    expect(FORM_BODY_BYTES).toBe(65_536);
  });

  it('reads a body within the limit as text', async () => {
    const request = new Request('http://localhost/api', { method: 'POST', body: '{"text":"café"}' });
    expect(await readBody(request, 64)).toBe('{"text":"café"}');
  });

  it('reads a request with no body as empty text', async () => {
    expect(await readBody(new Request('http://localhost/api'), 64)).toBe('');
  });

  it('refuses a body that declares a larger length without reading it', async () => {
    const { request, pulled } = streamedRequest(1, { 'content-length': '2049' });
    expect(await readBody(request, 2048)).toBeNull();
    expect(pulled()).toBe(0);
  });

  it('stops reading a body as soon as it passes the limit, and cancels it', async () => {
    const { request, pulled, cancelled } = streamedRequest(100);
    expect(await readBody(request, 2048)).toBeNull();
    expect(pulled()).toBe(3);
    expect(cancelled()).toBe(true);
  });

  it('reads a body of exactly the limit', async () => {
    const { request } = streamedRequest(2);
    expect(await readBody(request, 2048)).toBe('a'.repeat(2048));
  });
});
