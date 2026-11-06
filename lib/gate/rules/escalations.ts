import { formatUsd } from '@/lib/domain/money';
import type { GateInput } from '@/lib/gate/evaluate';
import { MAX_QTY_BEFORE_ASK, PRICE_ANOMALY_RATIO } from '@/lib/gate/rules';
import { ask, atOrBelow, pass, skip, type CartContext, type Check } from './check';

// Soft limits: breaking any of them sends the purchase to the buyer for approval.

export function askThreshold({ cart, policy }: CartContext): Check {
  if (policy.askAboveCents === null) return pass('Your mandate sets no approval limit on amount');
  const total = formatUsd(cart.totalCents);
  const limit = `${formatUsd(policy.askAboveCents)} approval limit`;
  return atOrBelow(cart.totalCents, policy.askAboveCents)
    ? pass(`${total} is within your ${limit}`)
    : ask(`${total} is over your ${limit}`);
}

export function priceBenchmark({ entries }: CartContext): Check {
  let benchmarked = false;
  // The entries' prices are the cart's prices, since the cart was built from them.
  for (const { title, priceCents, marketMedianCents } of entries) {
    if (marketMedianCents === null) continue;
    benchmarked = true;
    if (!atOrBelow(priceCents, PRICE_ANOMALY_RATIO * marketMedianCents)) {
      const price = formatUsd(priceCents);
      const median = formatUsd(marketMedianCents);
      return ask(`${title} costs ${price}, more than ${PRICE_ANOMALY_RATIO} times its ${median} market median`);
    }
  }
  return benchmarked
    ? pass(`Every benchmarked price is within ${PRICE_ANOMALY_RATIO} times its market median`)
    : skip('No market price benchmark exists for these items');
}

export function quantity({ cart }: CartContext): Check {
  const bulk = cart.items.find((i) => !atOrBelow(i.quantity, MAX_QTY_BEFORE_ASK));
  return bulk
    ? ask(`${bulk.title} has a quantity of ${bulk.quantity}, more than ${MAX_QTY_BEFORE_ASK}`)
    : pass(`No item has a quantity over ${MAX_QTY_BEFORE_ASK}`);
}

export function walletLinked({ walletLinked }: GateInput): Check {
  // Compared strictly, so a missing value asks the buyer instead of passing.
  return walletLinked === true ? pass('A saved PayPal wallet is linked') : ask('No saved PayPal wallet is linked');
}
