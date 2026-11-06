import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmToken, isConfirmToken } from '@/lib/mandate/confirm-token';
import { canonicalJson, hashOf } from '@/lib/receipts/canonical';
import { demoPolicy } from '@/tests/helpers/fixtures';

const SECRET = 'test-session-secret-at-least-32-characters';
const TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('confirmToken', () => {
  it('is the HMAC-SHA256 under SESSION_SECRET of the canonical text and policy hash', () => {
    const expected = createHmac('sha256', SECRET)
      .update(canonicalJson({ text: TEXT, policyHash: hashOf(demoPolicy) }))
      .digest('base64url');
    expect(confirmToken(TEXT, demoPolicy)).toBe(expected);
  });

  it('needs SESSION_SECRET', () => {
    vi.stubEnv('SESSION_SECRET', '');
    expect(() => confirmToken(TEXT, demoPolicy)).toThrow(/SESSION_SECRET/);
  });
});

describe('isConfirmToken', () => {
  it('accepts the token for the same text and policy, whatever order the policy keys arrive in', () => {
    const token = confirmToken(TEXT, demoPolicy);
    const reordered = Object.fromEntries(Object.entries(demoPolicy).reverse());
    expect(isConfirmToken(token, TEXT, JSON.parse(JSON.stringify(reordered)))).toBe(true);
  });

  it('refuses the token for other text', () => {
    expect(isConfirmToken(confirmToken(TEXT, demoPolicy), `${TEXT}, and wine`, demoPolicy)).toBe(false);
  });

  it('refuses the token for a policy with any field changed', () => {
    const wider = { ...demoPolicy, budget: { amountCents: 600_000, period: 'month' } };
    expect(isConfirmToken(confirmToken(TEXT, demoPolicy), TEXT, wider)).toBe(false);
  });

  it('refuses a token made under another secret', () => {
    vi.stubEnv('SESSION_SECRET', 'some-other-secret-of-similar-length');
    const forged = confirmToken(TEXT, demoPolicy);
    vi.stubEnv('SESSION_SECRET', SECRET);
    expect(isConfirmToken(forged, TEXT, demoPolicy)).toBe(false);
  });

  it.each([undefined, null, 42, '', 'not-a-token', `${'A'.repeat(43)}`])('refuses %j', (token) => {
    expect(isConfirmToken(token, TEXT, demoPolicy)).toBe(false);
  });

  it('refuses the right token with anything added', () => {
    expect(isConfirmToken(`${confirmToken(TEXT, demoPolicy)}=`, TEXT, demoPolicy)).toBe(false);
  });
});
