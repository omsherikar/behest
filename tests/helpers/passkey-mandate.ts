import type { Db } from '@/lib/db/client';
import type { MandatePolicy } from '@/lib/domain/policy';
import { confirmMandate } from '@/lib/mandate/confirm';
import { signingOptions, verifyMandateAssertion } from '@/lib/mandate/passkey';
import { registerPasskey, registrationOptions } from '@/lib/passkeys/register';
import type { Signer } from '@/lib/receipts/sign';
import { TestAuthenticator } from '@/tests/helpers/authenticator';
import { demoPolicy } from '@/tests/helpers/fixtures';

// A mandate the buyer confirmed with their passkey, made through every real step: registering a
// software passkey, signing the mandate's challenge with it, and confirming. SESSION_SECRET must be
// set, since the steps pass tickets.

/** Registers a passkey for `buyerId` at `origin` and confirms `policy` with it, as the buyer's active mandate. */
export async function confirmWithPasskey(
  i: { db: Db; signer: Signer; origin: string; now: Date; buyerId: string },
  {
    text = '$60 a month on groceries and spices',
    policy = demoPolicy,
    userVerified = true,
  }: { text?: string; policy?: MandatePolicy; userVerified?: boolean } = {},
): Promise<{ mandateId: string; authenticator: TestAuthenticator }> {
  const deps = { db: i.db, origin: i.origin, now: () => i.now };
  const authenticator = new TestAuthenticator(i.origin);
  const registration = await registrationOptions(deps, i.buyerId);
  await registerPasskey(deps, { buyerId: i.buyerId, response: authenticator.register(registration.options), ticket: registration.ticket });

  const signing = await signingOptions(deps, { buyerId: i.buyerId, policy });
  if (!signing.ok) throw new Error('the buyer has no passkey to sign with');
  const assertion = authenticator.assert(signing.options, { userVerified });
  const verified = await verifyMandateAssertion(deps, { buyerId: i.buyerId, policy, assertion, ticket: signing.ticket });
  if (!verified.ok) throw new Error('the passkey signature did not verify');

  const { mandateId } = await confirmMandate(
    { db: i.db, signer: i.signer, now: () => i.now },
    { buyerId: i.buyerId, text, policy, passkey: verified.signature },
  );
  return { mandateId, authenticator };
}
