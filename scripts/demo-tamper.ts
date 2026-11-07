import type { Cart } from '../lib/domain/cart';
import { formatUsd } from '../lib/domain/money';
import type { PurchaseStatus } from '../lib/db/schema';
import { receiptAgeMinutes, sellerTookOrder, tamperedCart } from '../lib/demo/tamper';

// Shows a seller refusing receipts that do not check out, through the app's own public routes as
// anyone could call them. It takes the newest receipt the seller persona can see and presents it to
// the seller twice:
//   1. with the cart changed (one more of the first item), which comes back cart_mismatch;
//   2. with the cart it was signed for, once the seller has already accepted that order, which comes
//      back replayed.
// The second request is skipped while the seller has not accepted the order yet, so the demo never
// takes an order in Behest's place. A receipt older than 15 minutes is refused as expired before
// either check, so run this within 15 minutes of the purchase. Usage:
//   npm run demo:tamper              # the newest receipt
//   npm run demo:tamper -- <purchaseId>

const BASE = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

type Purchase = { id: string; cart: Cart | null; status: PurchaseStatus };
type Receipt = { id: string; purchaseId: string; jws: string; createdAt: string };

async function sellerCookie(): Promise<string> {
  const response = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'seller' }),
  });
  const cookie = /behest_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  if (!cookie) throw new Error(`Could not start a seller session at ${BASE} (HTTP ${response.status}). Is the app running?`);
  return `behest_session=${cookie}`;
}

async function present(cart: Cart, receiptJws: string): Promise<string> {
  const response = await fetch(`${BASE}/api/sellers/${encodeURIComponent(cart.seller.slug)}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cart, receiptJws }),
  });
  const body = (await response.json().catch(() => ({}))) as { status?: string; reason?: string };
  return `${response.status} ${body.status ?? 'no answer'}${body.reason ? `: ${body.reason}` : ''}`;
}

function describe(cart: Cart): string {
  return cart.items.map((item) => `${item.quantity} × ${item.title}`).join(', ') + ` (${formatUsd(cart.totalCents)})`;
}

async function main() {
  const cookie = await sellerCookie();
  const response = await fetch(`${BASE}/api/dashboard/data`, { headers: { Cookie: cookie } });
  if (!response.ok) throw new Error(`Could not read the seller's orders (HTTP ${response.status}).`);
  const data = (await response.json()) as { purchases: Purchase[]; receipts: Receipt[] };

  const wanted = process.argv[2];
  const receipts = [...data.receipts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const receipt = receipts.find((r) => !wanted || r.purchaseId === wanted);
  const purchase = receipt && data.purchases.find((p) => p.id === receipt.purchaseId);
  if (!receipt || !purchase?.cart) {
    throw new Error(wanted ? `No receipt with a cart for purchase ${wanted}.` : 'No receipt yet. Make a purchase first.');
  }
  const cart = purchase.cart;

  console.log(`Receipt ${receipt.id.slice(0, 8)} for ${cart.seller.name}: ${describe(cart)}`);
  const age = receiptAgeMinutes(receipt.jws, new Date());
  if (age !== null && age >= 15) {
    console.log(`  It is ${age} minutes old, and sellers refuse receipts older than 15, so both answers will read expired.`);
  }

  const changed = tamperedCart(cart);
  console.log(`\n1. The same receipt, with the cart changed to ${describe(changed)}`);
  console.log(`   ${await present(changed, receipt.jws)}`);

  console.log(`\n2. The same receipt and its own cart, sent again`);
  if (sellerTookOrder(purchase.status)) {
    console.log(`   ${await present(cart, receipt.jws)}`);
  } else {
    console.log(`   Skipped: ${cart.seller.name} has not accepted this order yet (it is ${purchase.status}).`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
