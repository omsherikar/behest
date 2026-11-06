import type { Db } from '@/lib/db/client';
import type { Cart } from '@/lib/domain/cart';
import type { Verdict } from '@/lib/domain/verdict';
import type { IntentInput, IntentResult } from '@/lib/intent/types';
import type { PaypalPort } from '@/lib/paypal/port';
import type { Signer } from '@/lib/receipts/sign';
import type { PurchaseStatus } from './transitions';

export type { IntentInput, IntentResult };

// What the purchase orchestrator needs from the outside world, passed in so that tests can swap
// PayPal, the intent check and the sellers for fakes, and fix the clock.

/** How Behest hands an agent order to a seller, who verifies the receipt before accepting it. */
export type SellerPort = {
  acceptAgentOrder(i: {
    sellerSlug: string;
    cart: Cart;
    receiptJws: string;
  }): Promise<{ status: 'accepted' | 'rejected'; reason?: string }>;
};

export type PurchaseDeps = {
  db: Db;
  paypal: PaypalPort;
  signer: Signer;
  intent: (i: IntentInput) => Promise<IntentResult>;
  sellers: SellerPort;
  /** Behest's public base URL, for the links PayPal sends the buyer back to. */
  appUrl: string;
  now: () => Date;
};

/** Where a purchase stands once the orchestrator has done what it can for now. */
export type ProposalOutcome = {
  purchaseId: string;
  verdict: Verdict;
  status: PurchaseStatus;
  /** Why the purchase was not simply allowed: failed gate rules, then the intent check's concerns. */
  reasons: string[];
  /** The PayPal link the buyer opens to approve an ASK purchase. */
  approveUrl: string | null;
  receiptId: string | null;
};
