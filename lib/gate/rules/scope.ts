import { block, pass, type CartContext, type Check } from './check';

// What the agent may buy and from whom.

export function categoryAllowed({ cart, policy }: CartContext): Check {
  const { allow, deny } = policy.categories;
  const refused = cart.items.find((i) => deny.includes(i.category) || (allow !== null && !allow.includes(i.category)));
  if (refused) return block(`${refused.category.replaceAll('_', ' ')} is not allowed by your mandate`);
  return pass('Every item is in a category your mandate allows');
}

export function sellerAllowed({ input: { seller }, policy }: CartContext): Check {
  const { allow, deny } = policy.merchants;
  if (deny.includes(seller.slug) || (allow !== null && !allow.includes(seller.slug))) {
    return block(`${seller.name} is not allowed by your mandate`);
  }
  return pass(`${seller.name} is allowed by your mandate`);
}

export function listingClean({ entries }: CartContext): Check {
  const flagged = entries.find((e) => e.flags.length > 0);
  if (!flagged) return pass('No item in the cart was flagged by listing screening');
  return block(
    flagged.flags.includes('agent_instructions')
      ? `${flagged.title} contains instructions aimed at AI agents`
      : `${flagged.title} was flagged by listing screening`,
  );
}
