import type { Db } from '@/lib/db/client';
import type { Cart } from '@/lib/domain/cart';
import type { Verdict } from '@/lib/domain/verdict';
import type { PaypalPort } from '@/lib/paypal/port';
import type { Signer } from '@/lib/receipts/sign';
import type { PurchaseStatus } from './transitions';

// What the purchase orchestrator needs from the outside world, passed in so that tests can swap
// PayPal, the intent check and the sellers for fakes, and fix the clock.

/** What the intent check reads: the buyer's own words, what they confirmed, and what the agent wants to buy. */
export type IntentInput = {
  mandateText: string;
  readback: string[];
  request: string;
  cart: Cart;
  /** The agent's own claim about why the cart fits the request. Unverified. */
  agentRationale: string;
};

/** The intent check's opinion. It can only tighten a verdict, never loosen it. */
export type IntentResult = {
  verdict: 'consistent' | 'needs_human' | 'inconsistent' | 'unavailable';
  reasons: string[];
};

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
