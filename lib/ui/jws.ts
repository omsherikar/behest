// Reading a compact JWS for display: its three segments and its header and payload decoded from
// base64url. Nothing here verifies a signature. That needs Behest's public key and happens on the
// server (app/api/receipts/verify), never in the browser.

export type JwsParts = {
  header: string;
  payload: string;
  signature: string;
  /** The header's JSON, or undefined when it does not decode to JSON. */
  decodedHeader: unknown;
  /** The payload's JSON, or undefined when it does not decode to JSON. */
  decodedPayload: unknown;
};

const SEGMENT = /^[A-Za-z0-9_-]*$/;

/** The bytes of a base64url segment as UTF-8 text, or null when it is not valid base64url or UTF-8. */
export function base64UrlText(segment: string): string | null {
  if (!SEGMENT.test(segment) || segment.length % 4 === 1) return null;
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeJson(segment: string): unknown {
  const text = base64UrlText(segment);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The parts of a compact JWS, or null when the token is not three base64url segments joined by dots. */
export function splitJws(token: string): JwsParts | null {
  const segments = token.trim().split('.');
  if (segments.length !== 3 || segments.some((segment) => segment === '' || !SEGMENT.test(segment))) return null;
  const [header, payload, signature] = segments;
  return { header, payload, signature, decodedHeader: decodeJson(header), decodedPayload: decodeJson(payload) };
}

export type JsonToken = { text: string; kind: 'key' | 'string' | 'number' | 'literal' | 'punctuation' };

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([^"\d\w-]+|.)/g;

/** JSON text cut into tokens. */
function tokenize(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  for (const [, string, colon, number, literal, other] of json.matchAll(JSON_TOKEN)) {
    if (string !== undefined) {
      tokens.push({ text: string, kind: colon ? 'key' : 'string' });
      if (colon) tokens.push({ text: colon, kind: 'punctuation' });
    } else if (number !== undefined) tokens.push({ text: number, kind: 'number' });
    else if (literal !== undefined) tokens.push({ text: literal, kind: 'literal' });
    else if (other !== undefined) tokens.push({ text: other, kind: 'punctuation' });
  }
  return tokens;
}

/** A value as indented JSON. */
const indented = (value: unknown) => JSON.stringify(value, null, 2) ?? 'undefined';

/**
 * A value as indented JSON, cut into tokens so a view can tell keys from values. Joining the
 * tokens' text gives back JSON.stringify(value, null, 2).
 */
export function jsonTokens(value: unknown): JsonToken[] {
  return tokenize(indented(value));
}

export type JsonLine = { indent: number; tokens: JsonToken[] };

/** How wide a line of formatted JSON may be before an object or array breaks over several lines. */
const JSON_WIDTH = 56;

/** A value as JSON on one line, with a space after each colon and comma and inside braces. */
function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.map(inlineJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`).join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The lines of `value` at `indent`, after `lead` (its key) and before `trail` (its comma). */
function formatLines(value: unknown, indent: number, lead: string, trail: string): string[] {
  const pad = ' '.repeat(indent);
  const inline = inlineJson(value);
  const container = value !== null && typeof value === 'object';
  if (!container || pad.length + lead.length + inline.length + trail.length <= JSON_WIDTH) return [`${pad}${lead}${inline}${trail}`];
  const array = Array.isArray(value);
  const entries: [string | null, unknown][] = array
    ? (value as unknown[]).map((item) => [null, item])
    : Object.entries(value as object).filter(([, item]) => item !== undefined);
  const [open, close] = array ? ['[', ']'] : ['{', '}'];
  return [
    `${pad}${lead}${open}`,
    ...entries.flatMap(([key, item], index) =>
      formatLines(item, indent + 2, key === null ? '' : `${JSON.stringify(key)}: `, index < entries.length - 1 ? ',' : ''),
    ),
    `${pad}${close}${trail}`,
  ];
}

/**
 * A value as indented JSON, one entry per line: how many spaces the line is indented and the
 * tokens after them. An object or array short enough stays on one line, so a list of small
 * objects, such as a receipt's rule results, reads one per line. A view indents each line with
 * padding, so a long value wrapping onto a second line keeps its line's indentation.
 */
export function jsonLines(value: unknown): JsonLine[] {
  return formatLines(value, 0, '', '').map((line) => {
    const indent = line.length - line.trimStart().length;
    return { indent, tokens: tokenize(line.slice(indent)) };
  });
}
