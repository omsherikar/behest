import { asc, eq } from 'drizzle-orm';
import type { JWK } from 'jose';
import { type Db, getDb } from '@/lib/db/client';
import { buyers } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import { createClaude, type LlmDeps } from '@/lib/llm/client';
import { getDispute, listDisputes, provideEvidence } from '@/lib/paypal/disputes';
import { captureOrder, chargeSavedWallet, createApprovalOrder } from '@/lib/paypal/orders';
import { createPayout, getPayoutBatch } from '@/lib/paypal/payouts';
import type { PaypalPort } from '@/lib/paypal/port';
import { refundCapture } from '@/lib/paypal/refunds';
import { createPaymentToken, createSetupToken } from '@/lib/paypal/vault';
import { verifyWebhook } from '@/lib/paypal/webhooks';
import { loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner, type Signer } from '@/lib/receipts/sign';

// The app's live dependencies, built from the environment. Routes and pages take them from here and
// hand them to library code, which tests call with fakes instead.

/** The app's database. */
export function appDb(): Db {
  return getDb();
}

type SigningKey = Awaited<ReturnType<typeof loadSigningKey>>;

let signingKey: Promise<SigningKey> | undefined;

/**
 * The key in RECEIPT_SIGNING_KEY, loaded on first use and kept for the life of the process. A load
 * that fails is not kept, so the next call tries again.
 */
function appSigningKey(): Promise<SigningKey> {
  const { RECEIPT_SIGNING_KEY, RECEIPT_KEY_ID } = process.env;
  signingKey ??= loadSigningKey({ RECEIPT_SIGNING_KEY, RECEIPT_KEY_ID }).catch((error: unknown) => {
    signingKey = undefined;
    throw error;
  });
  return signingKey;
}

/** Signs mandates and receipts with the app's key. */
export async function appSigner(): Promise<Signer> {
  return createSigner(await appSigningKey());
}

/** The public key set that verifies what appSigner signs. */
export async function appJwks(): Promise<{ keys: JWK[] }> {
  return publicJwks([await appSigningKey()]);
}

/** PayPal, through the live REST client in lib/paypal. */
export function appPaypal(): PaypalPort {
  return {
    createSetupToken,
    createPaymentToken,
    chargeSavedWallet,
    createApprovalOrder,
    captureOrder,
    createPayout,
    getPayoutBatch,
    refundCapture,
    listDisputes,
    getDispute,
    provideEvidence,
    verifyWebhook,
  };
}

/** What a model call needs: the app's database, the Claude client and the system clock. */
export function llmDeps(): LlmDeps {
  return { db: appDb(), claude: createClaude(), now: () => new Date() };
}

/** Behest's public base URL from APP_URL, without a trailing slash: where PayPal sends buyers back. */
export function appUrl(): string {
  const url = process.env.APP_URL?.trim().replace(/\/+$/, '') ?? '';
  const protocol = URL.parse(url)?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('APP_URL must be the http or https URL Behest is served from');
  }
  return url;
}

async function oldestDemoBuyerId(db: Db): Promise<string | undefined> {
  const [buyer] = await db
    .select({ id: buyers.id })
    .from(buyers)
    .where(eq(buyers.name, DEMO_BUYER_NAME))
    .orderBy(asc(buyers.createdAt), asc(buyers.id))
    .limit(1);
  return buyer?.id;
}

/**
 * The buyer persona's own record: the oldest buyer named DEMO_BUYER_NAME, created when there is
 * none. Names are not unique, so two first calls at once may each create one; both then return the
 * oldest, so every caller agrees on one buyer.
 */
export async function demoBuyerId(db: Db): Promise<string> {
  const found = await oldestDemoBuyerId(db);
  if (found) return found;
  const [created] = await db.insert(buyers).values({ name: DEMO_BUYER_NAME }).returning({ id: buyers.id });
  return (await oldestDemoBuyerId(db)) ?? created.id;
}
