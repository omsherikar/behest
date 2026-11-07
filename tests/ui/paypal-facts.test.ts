import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as facts from '@/app/_landing/paypal-facts';
import { EVIDENCE_IDS } from '@/lib/disputes/pack';
import { WEBHOOK_EVENT_TYPES } from '@/lib/paypal/webhook-registration';
import { FINAL_STATUSES } from '@/lib/purchases/settle';

// The home page's PayPal tiles show values from the code. Each list here must still be the code's.

const source = (file: string) => readFileSync(path.join(import.meta.dirname, '..', '..', file), 'utf8');

describe('the PayPal values on the home page', () => {
  it('lists the dispute evidence items and the webhook events the code uses', () => {
    expect(facts.EVIDENCE_IDS).toEqual(EVIDENCE_IDS);
    expect(facts.WEBHOOK_EVENT_TYPES).toEqual(WEBHOOK_EVENT_TYPES);
  });

  it('names the toolkit tools the bridge allows', () => {
    expect(source('lib/paypal/toolkit-bridge.ts')).toContain(
      `export const READ_ONLY_TOOLS = [${facts.TOOLKIT_TOOLS.map((tool) => `'${tool}'`).join(', ')}] as const;`,
    );
  });

  it('shows capture statuses the order client acts on', () => {
    const orders = source('lib/paypal/orders.ts');
    for (const { code } of facts.ORDER_CAPTURE_STATUSES) expect(orders).toContain(`status === '${code}'`);
  });

  it('shows a payout status that is polled again, the paid one and a failed one', () => {
    const [polled, paid, failed] = facts.PAYOUT_STATUSES.map(({ code }) => code);
    expect(FINAL_STATUSES.has(polled)).toBe(false);
    expect(paid).toBe('SUCCESS');
    expect(FINAL_STATUSES.has(failed)).toBe(true);
  });

  it('sends a refund under the purchase id and the refund suffix', () => {
    expect(source('lib/purchases/deliver.ts')).toContain(`requestId: \`\${purchaseId}${facts.REFUND_REQUEST_SUFFIX}\``);
  });

  it('saves a wallet in the order the Vault tile shows', () => {
    expect(facts.VAULT_SEQUENCE.map(({ step }) => step)).toEqual(['Mandate signed', 'Approved at PayPal', 'Wallet saved', 'Charged, no click']);
    // Confirming the mandate creates the setup token the buyer approves at PayPal.
    expect(source('app/api/mandates/confirm/route.ts')).toContain('paypal.createSetupToken(');
    const vault = source('lib/paypal/vault.ts');
    expect(vault).toContain("'/v3/vault/setup-tokens'");
    expect(vault).toContain("'/v3/vault/payment-tokens'");
    // An allowed purchase is charged to the saved token.
    expect(source('lib/paypal/orders.ts')).toContain('payment_source: { paypal: { vault_id: i.paymentTokenId } }');
  });
});
