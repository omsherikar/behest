import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cart } from '@/lib/domain/cart';
import { MandatePayload, ReceiptPayload } from '@/lib/domain/receipt';
import { GATE_RULES } from '@/lib/gate/rules';
import { sha256Hex } from '@/lib/receipts/canonical';
import { verifyJws } from '@/lib/receipts/sign';
import { cartClaims } from '@/lib/receipts/verify-receipt';
import sample from '@/lib/demo/sample-receipt.json';

// The landing page's sample receipt must be the real thing in all but money: tokens the real
// verifier accepts against the public key set beside them, and nothing secret in the file.

const FILE = path.join(import.meta.dirname, '..', '..', 'lib', 'demo', 'sample-receipt.json');

describe('the sample receipt', () => {
  it('verifies against its public key set as a Behest receipt', async () => {
    const receipt = await verifyJws(sample.receiptJws, 'behest-receipt+jws', sample.jwks, ReceiptPayload);
    expect(receipt.decision.verdict).toBe('ASK');
    expect(receipt.decision.approver).toBe('human');
  });

  it('points at the signed mandate it was made under', async () => {
    const receipt = await verifyJws(sample.receiptJws, 'behest-receipt+jws', sample.jwks, ReceiptPayload);
    const mandate = await verifyJws(sample.mandateJws, 'behest-mandate+jws', sample.jwks, MandatePayload);
    expect(receipt.mandate.jwsHash).toBe(sha256Hex(sample.mandateJws));
    expect(receipt.mandate.policyHash).toBe(mandate.policyHash);
  });

  it('carries the hash of its cart and every gate rule in order', async () => {
    const receipt = await verifyJws(sample.receiptJws, 'behest-receipt+jws', sample.jwks, ReceiptPayload);
    expect(receipt.cart).toEqual(cartClaims(Cart.parse(sample.cart)));
    expect(receipt.decision.outcomes.map((outcome) => outcome.rule)).toEqual([...GATE_RULES]);
  });

  it('refuses a receipt passed off as a mandate', async () => {
    await expect(verifyJws(sample.receiptJws, 'behest-mandate+jws', sample.jwks, MandatePayload)).rejects.toThrow(
      'not of the expected type',
    );
  });

  it('holds no private key', () => {
    const text = readFileSync(FILE, 'utf8');
    expect(text).not.toMatch(/PRIVATE KEY|"d"\s*:/);
    for (const key of sample.jwks.keys) expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
  });
});
