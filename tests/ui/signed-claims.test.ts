import { describe, expect, it } from 'vitest';
import { mandateCredentialId, receiptDecisionHash } from '@/lib/ui/signed-claims';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload: unknown) => `${b64url({ alg: 'EdDSA' })}.${b64url(payload)}.${Buffer.alloc(64, 7).toString('base64url')}`;

const passkey = { credentialId: 'cred-AbC_123', publicKey: 'pQECAyYgASFYIA', alg: -7 };
const decisionHash = 'd'.repeat(64);

describe('mandateCredentialId', () => {
  it('reads the credential id of the passkey a passkey mandate names', () => {
    expect(mandateCredentialId(token({ confirmation: 'passkey', passkey }))).toBe('cred-AbC_123');
  });

  it('is null for a mandate confirmed by session', () => {
    expect(mandateCredentialId(token({ confirmation: 'session' }))).toBeNull();
    expect(mandateCredentialId(token({ confirmation: 'session', passkey }))).toBeNull();
  });

  it('is null for a token that does not decode or names no usable credential', () => {
    expect(mandateCredentialId('mandate.jws.value')).toBeNull();
    expect(mandateCredentialId('not a jws')).toBeNull();
    expect(mandateCredentialId(token({ confirmation: 'passkey' }))).toBeNull();
    expect(mandateCredentialId(token({ confirmation: 'passkey', passkey: { ...passkey, credentialId: 7 } }))).toBeNull();
    expect(mandateCredentialId(token({ confirmation: 'passkey', passkey: { ...passkey, credentialId: '' } }))).toBeNull();
  });
});

describe('receiptDecisionHash', () => {
  it("reads the decision record hash a receipt's agent claim carries", () => {
    expect(receiptDecisionHash(token({ v: 1, agent: { decisionHash } }))).toBe(decisionHash);
  });

  it('is null for a receipt with no agent claim, or one that does not decode', () => {
    expect(receiptDecisionHash(token({ v: 1 }))).toBeNull();
    expect(receiptDecisionHash(token({ v: 1, agent: null }))).toBeNull();
    expect(receiptDecisionHash(token({ v: 1, agent: { decisionHash: 12 } }))).toBeNull();
    expect(receiptDecisionHash('not.a.jws')).toBeNull();
  });
});
