import { Cart, type CartItem } from '@/lib/domain/cart';
import { PurchaseProposal } from '@/lib/domain/proposal';
import type { CatalogEntry, GateInput } from '@/lib/gate/evaluate';
import { atOrBelow, block, pass, quoteAgentText, type Check } from './check';

export type BuiltCart = { check: Check; cart: Cart; entries: CatalogEntry[] } | { check: Check; cart: null };

/**
 * The canonical cart: SKUs and quantities from the proposal, everything else from the catalog.
 * `entries` holds the catalog entry behind each cart item, in the same order.
 */
export function buildCart({ proposal, seller, catalog }: GateInput): BuiltCart {
  const parsed = PurchaseProposal.safeParse(proposal);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? ` at ${issue.path.map(String).join('.')}` : '';
    return { check: block(`The proposal is not valid${where}: ${issue.message}`), cart: null };
  }
  if (parsed.data.sellerSlug !== seller.slug) {
    return { check: block(`The proposal names a seller other than ${seller.name}`), cart: null };
  }

  const entries: CatalogEntry[] = [];
  const items: CartItem[] = [];
  for (const { sku, quantity } of parsed.data.items) {
    const entry = catalog.get(sku);
    if (!entry || entry.sku !== sku) {
      return { check: block(`SKU ${quoteAgentText(sku)} is not sold by ${seller.name}`), cart: null };
    }
    if (entry.stock !== null && !atOrBelow(quantity, entry.stock)) {
      const detail =
        entry.stock > 0 ? `${entry.title} has only ${entry.stock} in stock` : `${entry.title} is out of stock`;
      return { check: block(detail), cart: null };
    }
    entries.push(entry);
    items.push({ sku, title: entry.title, category: entry.category, unitPriceCents: entry.priceCents, quantity });
  }

  // Every field here comes from the database, so a parse failure means a corrupt catalog entry.
  // It throws rather than blocking quietly, and evaluateGateSafely turns that into a BLOCK.
  const cart = Cart.parse({
    seller: { slug: seller.slug, name: seller.name },
    currency: 'USD',
    items,
    totalCents: items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0),
  });
  return { check: pass(`Every item is listed by ${seller.name} and in stock`), cart, entries };
}
