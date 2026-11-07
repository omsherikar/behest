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

/**
 * A value as indented JSON, cut into tokens so a view can tell keys from values. Joining the
 * tokens' text gives back JSON.stringify(value, null, 2).
 */
export function jsonTokens(value: unknown): JsonToken[] {
  const json = JSON.stringify(value, null, 2) ?? 'undefined';
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
