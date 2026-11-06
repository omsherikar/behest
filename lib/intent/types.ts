import type { Cart } from '@/lib/domain/cart';

// The intent check asks whether a cart the gate let through is what the buyer actually asked for.

/** What the check reads. The buyer's request and mandate are trusted; the cart's titles and the agent's rationale are not. */
export type IntentInput = {
  /** The mandate as the buyer wrote it. */
  mandateText: string;
  /** The readback the buyer approved, one line each. */
  readback: string[];
  /** What the buyer asked the agent to buy. */
  request: string;
  /** The cart as loaded from Behest's database. */
  cart: Cart;
  /** Why the agent says it chose this cart. */
  agentRationale: string;
};

/** `unavailable` means the check could not run; its reason is the name of the failure. */
export type IntentResult = {
  verdict: 'consistent' | 'needs_human' | 'inconsistent' | 'unavailable';
  reasons: string[];
};
