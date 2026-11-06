import { readFileSync } from 'node:fs';
import path from 'node:path';

// Server-sent event streams for tests: recorded Messages API streams, and the fakeClaude reply
// that sends one.

const RECORDED_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'llm', 'studio_analyst');

/** The recorded stream `tests/fixtures/llm/studio_analyst/<name>.sse`. */
export function recordedStream(name: string): string {
  return readFileSync(path.join(RECORDED_DIR, `${name}.sse`), 'utf8');
}

/** An SSE body that sends each event as one frame, named by its type. */
export function sseBody(events: { type: string }[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** A fakeClaude reply that streams `body`. */
export function streamReply(body: string) {
  return { status: 200, text: body, headers: { 'content-type': 'text/event-stream' } };
}

/** The data of each frame of an SSE body, parsed as JSON. Pings are left out. */
export function sseEvents(body: string): { type: string }[] {
  return body
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n'),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as { type: string })
    .filter((event) => event.type !== 'ping');
}
