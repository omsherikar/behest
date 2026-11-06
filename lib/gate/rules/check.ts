import type { Cart } from '@/lib/domain/cart';
import type { MandatePolicy } from '@/lib/domain/policy';
import type { CatalogEntry, GateInput } from '@/lib/gate/evaluate';
import type { RuleOutcome } from '@/lib/gate/rules';

// Shared pieces of the gate's rule functions. Each rule returns a Check, and the gate adds the
// rule id to make the recorded outcome.

export type Check = Omit<RuleOutcome, 'rule'>;

export const pass = (detail: string): Check => ({ result: 'pass', detail });
export const ask = (detail: string): Check => ({ result: 'ask', detail });
export const block = (detail: string): Check => ({ result: 'block', detail });
export const skip = (detail: string): Check => ({ result: 'skip', detail });

/** What the rules after cart_valid read. `entries` holds the catalog entry behind each cart item, in order. */
export type CartContext = { input: GateInput; policy: MandatePolicy; cart: Cart; entries: CatalogEntry[] };

/**
 * True only when value is at or below limit. A NaN on either side compares false, so a rule
 * written as "fails unless at or below" also fails on a missing or corrupt number.
 */
export const atOrBelow = (value: number, limit: number) => value <= limit;
