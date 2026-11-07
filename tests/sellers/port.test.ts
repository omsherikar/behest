import { beforeAll, expect, it } from 'vitest';
import { sellers } from '@/lib/db/schema';
import { sellerPort } from '@/lib/sellers/port';
import { raviCart, RECEIPT_ISSUED, receiptFor, receiptJwks, signReceipt } from '@/tests/helpers/receipts';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

it('hands an agent order to the seller and passes on its answer, with the rejection code as the reason', async () => {
  const db = await createTestDb();
  await db.insert(sellers).values({ slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' });
  const now = new Date(RECEIPT_ISSUED.getTime() + 5 * 60 * 1000);
  const port = sellerPort({ db, jwks: async () => receiptJwks, now: () => now });
  const order = { sellerSlug: 'ravi-spices', cart: raviCart, receiptJws: await signReceipt(receiptFor(raviCart)) };

  expect(await port.acceptAgentOrder(order)).toStrictEqual({ status: 'accepted' });
  expect(await port.acceptAgentOrder(order)).toStrictEqual({ status: 'rejected', reason: 'replayed' });
});
