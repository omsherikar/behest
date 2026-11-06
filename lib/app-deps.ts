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

/**
 * PayPal, through the live REST client in lib/paypal. Throws when the REST app's credentials are
 * not set, so a route that takes PayPal before it stores anything stores nothing without them.
 */
export function appPaypal(): PaypalPort {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');
  }
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

/**
 * Behest's public origin from APP_URL, such as `https://behest.example.com`: where PayPal sends
 * buyers back. Routes append their own paths to it, so APP_URL may carry no path but `/`, and no
 * query or fragment.
 */
export function appUrl(): string {
  const raw = process.env.APP_URL?.trim() ?? '';
  const url = URL.parse(raw);
  const isWebUrl = url?.protocol === 'http:' || url?.protocol === 'https:';
  // The raw text is checked for ? and #: an empty query or fragment leaves no trace in the parsed URL.
  if (!url || !isWebUrl || url.pathname.replace(/\/+$/, '') !== '' || /[?#]/.test(raw)) {
    throw new Error('APP_URL must be the http or https origin Behest is served from, with no path, query or fragment');
  }
  return url.origin;
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
