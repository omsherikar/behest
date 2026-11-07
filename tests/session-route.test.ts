import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/session/route';
import { getPersona, SESSION_COOKIE } from '@/lib/session';

const SECRET = 'test-session-secret-at-least-32-characters';

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A request whose body arrives in 1 KiB pieces, which says how many were read and whether it was cancelled. */
function streamedRequest(pieces: number, headers: Record<string, string> = {}) {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls === pieces) return controller.close();
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  // A streamed body needs `duplex: 'half'`, which the RequestInit type does not list.
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' };
  return { request: new Request('http://localhost/api/session', init), pulled: () => pulls, cancelled: () => cancelled };
}

/** The persona the response's session cookie holds, or null when it sets none. */
async function personaSet(response: Response): Promise<string | null> {
  const cookie = response.headers.get('set-cookie') ?? '';
  const value = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)?.[1];
  return value ? getPersona(value) : null;
}

describe('POST /api/session', () => {
  it('sets the session cookie for the persona it is sent', async () => {
    const response = await POST(new Request('http://localhost/api/session', { method: 'POST', body: '{"persona":"seller"}' }));

    expect(response.status).toBe(204);
    expect(await personaSet(response)).toBe('seller');
  });

  it('refuses an unknown persona or a body that is not JSON with 400', async () => {
    for (const body of ['{"persona":"admin"}', 'not json', '']) {
      const response = await POST(new Request('http://localhost/api/session', { method: 'POST', body }));

      expect(response.status).toBe(400);
      expect(await personaSet(response)).toBeNull();
    }
  });

  it('accepts a body of exactly 1 KiB', async () => {
    const body = `{"persona":"buyer"}${' '.repeat(1024 - 19)}`;

    const response = await POST(new Request('http://localhost/api/session', { method: 'POST', body }));

    expect(response.status).toBe(204);
  });

  it('refuses a body that declares more than 1 KiB with 413, without reading it', async () => {
    const { request, pulled } = streamedRequest(1, { 'content-length': '1025' });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { message: 'This request is too large.' } });
    expect(pulled()).toBe(0);
    expect(await personaSet(response)).toBeNull();
  });

  it('stops reading a body once it passes 1 KiB, whatever its length says, and answers 413', async () => {
    const { request, pulled, cancelled } = streamedRequest(1000);

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(pulled()).toBe(2);
    expect(cancelled()).toBe(true);
  });
});
