import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

/**
 * Serializes a value as RFC 8785 (JSON Canonicalization Scheme) text, so any
 * party can recompute the exact bytes that were hashed or signed.
 * Throws for values with no JSON representation (undefined, functions,
 * symbols) rather than letting a hash be computed over nothing.
 */
export function canonicalJson(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new TypeError('Cannot canonicalize a value with no JSON representation');
  }
  return text;
}

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 hex of the canonical JSON form of `value`. */
export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
