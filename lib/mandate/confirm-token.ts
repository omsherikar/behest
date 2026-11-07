import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, hashOf } from '@/lib/receipts/canonical';

// Proof that a policy came from a compile that left no open questions. The compile route hands out
// a token only for such a compile, and the confirm route signs a mandate only for the text and
// policy its token was made for. It is an HMAC under SESSION_SECRET, so the browser can carry a
// token but never make one.

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('SESSION_SECRET is required to make and check confirm tokens');
  return value;
}

/**
 * The confirm token for a mandate's text and the policy compiled from it. The policy is any JSON
 * value, so a policy sent back by the browser is checked before it is validated.
 */
export function confirmToken(text: string, policy: unknown): string {
  return createHmac('sha256', secret())
    .update(canonicalJson({ text, policyHash: hashOf(policy) }))
    .digest('base64url');
}

/** Whether `token` is the confirm token for this text and policy, compared in constant time. */
export function isConfirmToken(token: unknown, text: string, policy: unknown): boolean {
  if (typeof token !== 'string') return false;
  const expected = Buffer.from(confirmToken(text, policy));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
