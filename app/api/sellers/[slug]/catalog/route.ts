import { eq } from 'drizzle-orm';
import { connection, type NextRequest } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { buyableProducts } from '@/lib/catalog/buyable';
import { sellers } from '@/lib/db/schema';
import { clientAddress, PUBLIC_READ_LIMIT, rateLimit } from '@/lib/ratelimit';

// A seller's catalog, open to anyone, so outside shopping agents can browse it as Behest's own agent
// does. It lists only what can be bought (lib/catalog/buyable.ts): products in stock, or whose
// stock the seller does not track, and never one whose listing was flagged as text aimed at AI
// agents. Titles and descriptions are the seller's text, sent as JSON data; whoever shows them to a
// model quotes them.

const ROUTE = 'seller_catalog';

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/**
 * `GET`: `{ seller: { slug, name }, products }`, each product with its SKU, title, description,
 * category, price in cents and currency, stock (null when not tracked) and market benchmark (null
 * when there is none), in SKU order.
 */
export async function GET(request: NextRequest, ctx: RouteContext<'/api/sellers/[slug]/catalog'>) {
  // Reads the database on every request, never at build time.
  await connection();

  if (!rateLimit(`${ROUTE}:${clientAddress(request)}`, PUBLIC_READ_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }

  const { slug } = await ctx.params;
  const db = appDb();
  const [seller] = await db
    .select({ id: sellers.id, slug: sellers.slug, name: sellers.name })
    .from(sellers)
    .where(eq(sellers.slug, slug))
    .limit(1);
  if (!seller) return error(404, 'There is no seller at this address.');

  const listed = await buyableProducts(db, seller.id);

  // Each field is named, so nothing else on a product row, such as its flags, is ever sent.
  return Response.json({
    seller: { slug: seller.slug, name: seller.name },
    products: listed.map((product) => ({
      sku: product.sku,
      title: product.title,
      description: product.description,
      category: product.category,
      priceCents: product.priceCents,
      currency: product.currency,
      stock: product.stock,
      benchmark:
        product.channel3Id === null || product.marketMedianCents === null
          ? null
          : { channel3Id: product.channel3Id, marketMedianCents: product.marketMedianCents },
    })),
  });
}
