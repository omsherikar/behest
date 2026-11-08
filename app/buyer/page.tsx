import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import Link from 'next/link';
import { MandatePanel } from '@/components/purchase/mandate-panel';
import { buttonClass } from '@/components/ui/button';
import { JwsView } from '@/components/ui/jws-view';
import { confirmationFields } from '@/components/ui/mandate-confirmation';
import { Notice, TONE_KIND } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ProofFields } from '@/components/ui/proof-fields';
import { ProofId } from '@/components/ui/proof-id';
import { StatusBadge } from '@/components/ui/status-badge';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { mandateInForce } from '@/lib/buyer-pages/mandate';
import { mandates, type WalletStatus, wallets } from '@/lib/db/schema';
import { mandateCredentialId } from '@/lib/ui/signed-claims';
import { getPersona, SESSION_COOKIE } from '@/lib/session';
import { MandateForm } from './mandate-form';

export const metadata: Metadata = {
  title: 'Your mandate',
};

// The buyer's page, in two columns from 1024 px: the task on the left, writing a mandate and then the
// active one as the signed document it is; the context on the right, what the agent can do now, the
// budget left this period and the wallet that pays. On a phone the context comes first. PayPal sends
// the buyer back here with `?wallet=` set to how linking their wallet went.

type WalletNotice = { tone: 'success' | 'warning' | 'danger'; text: string };

const WALLET_NOTICES = new Map<string, WalletNotice>([
  ['linked', { tone: 'success', text: 'Your PayPal wallet is linked. Your agent can now pay within your mandate.' }],
  [
    'cancelled',
    {
      tone: 'warning',
      text: "You didn't link PayPal. Your mandate is signed, but your agent can't pay until a wallet is linked. Confirm a mandate again to link one.",
    },
  ],
  ['error', { tone: 'danger', text: "Linking PayPal didn't work. Confirm your mandate again to try once more." }],
]);

export default async function BuyerPage({ searchParams }: PageProps<'/buyer'>) {
  // Reads the database on every request, never at build time.
  await connection();

  // The proxy already sends visitors without the buyer persona to the picker; this keeps the page
  // safe on its own.
  const persona = await getPersona((await cookies()).get(SESSION_COOKIE)?.value);
  if (persona !== 'buyer') redirect('/');

  const db = appDb();
  const buyerId = await demoBuyerId(db);
  const [[mandate], [wallet], inForce] = await Promise.all([
    db
      .select({
        id: mandates.id,
        sourceText: mandates.sourceText,
        policyHash: mandates.policyHash,
        confirmedAt: mandates.confirmedAt,
        confirmation: mandates.confirmation,
        expiresAt: mandates.expiresAt,
        jws: mandates.jws,
      })
      .from(mandates)
      .where(and(eq(mandates.buyerId, buyerId), eq(mandates.status, 'active'))),
    db.select({ status: wallets.status }).from(wallets).where(eq(wallets.buyerId, buyerId)),
    mandateInForce(db, buyerId, new Date()),
  ]);

  const { wallet: outcome } = await searchParams;
  const notice = typeof outcome === 'string' ? WALLET_NOTICES.get(outcome) : undefined;
  const walletStatus: WalletStatus | 'none' = wallet?.status ?? 'none';

  return (
    <>
      <PageHeader
        title="Your mandate"
        purpose="Write what your agent may buy. Behest reads it back, and you sign exactly what it will enforce."
        actions={
          mandate && walletStatus === 'linked' ? (
            <Link href="/buyer/shop" className={buttonClass('secondary')}>
              Send your agent shopping
            </Link>
          ) : undefined
        }
      />

      {notice && (
        <Notice kind={TONE_KIND[notice.tone]} className="mb-8">
          {notice.text}
        </Notice>
      )}

      <div className="grid gap-8 lg:grid-cols-12">
        <aside data-tour="mandate-readback" aria-label="What your agent can do now" className="min-w-0 lg:sticky lg:top-28 lg:col-span-5 lg:col-start-8 lg:row-start-1 lg:self-start">
          <MandatePanel mandate={inForce} title="What your agent can do now" wallet={walletStatus} readback change={false} />
        </aside>

        <div className="grid min-w-0 content-start gap-8 lg:col-span-7 lg:col-start-1 lg:row-start-1">
          <section aria-labelledby="write-heading" className="panel rounded-frame p-5 sm:p-6">
            <h2 id="write-heading" className="text-heading font-medium text-text">
              {mandate ? 'Write a new mandate' : 'Write your mandate'}
            </h2>
            <p className="mt-1 text-body text-muted">
              {mandate
                ? 'Confirming a new mandate replaces the one in force.'
                : 'Say it the way you would tell a person: how much, on what, and when to ask you.'}
            </p>
            <MandateForm replacing={mandate !== undefined} />
          </section>

          {mandate && <SignedMandate mandate={mandate} />}
        </div>
      </div>
    </>
  );
}

// 7 Nov 2026, 09:00, in UTC as the page says.
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

type ActiveMandate = {
  id: string;
  sourceText: string;
  policyHash: string;
  confirmedAt: Date;
  confirmation: 'session' | 'passkey';
  expiresAt: Date | null;
  jws: string;
};

/**
 * The active mandate as the signed document it is: the buyer's own words, the facts that identify
 * it, and the signed token itself, which can be decoded and copied. Its readback is in the panel
 * beside it.
 */
function SignedMandate({ mandate }: { mandate: ActiveMandate }) {
  return (
    <section data-tour="mandate-signature" aria-labelledby="active-heading" className="panel rounded-frame">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-4 sm:px-6">
        <h2 id="active-heading" className="text-heading font-medium text-text">
          Your signed mandate
        </h2>
        <StatusBadge tone="seal">Signed and in force</StatusBadge>
      </header>
      <div className="grid gap-6 p-5 sm:p-6">
        <figure>
          <figcaption className="text-meta text-muted">In your words</figcaption>
          <blockquote className="mt-1.5 border-l-2 border-line-strong pl-3 text-lead break-words text-text">{mandate.sourceText}</blockquote>
        </figure>
        <ProofFields
          fields={[
            { label: 'Mandate id', value: <ProofId value={mandate.id} label="Mandate id" /> },
            { label: 'Policy hash', value: <ProofId value={mandate.policyHash} label="Policy hash" /> },
            { label: 'Signed at', value: <span className="font-mono text-meta">{dateTime.format(mandate.confirmedAt)} UTC</span> },
            ...confirmationFields(mandate.confirmation, mandateCredentialId(mandate.jws)),
            { label: 'Expires', value: mandate.expiresAt ? `${dateTime.format(mandate.expiresAt)} UTC` : 'Never' },
          ]}
        />
        <JwsView jws={mandate.jws} label="Signed mandate" decoded="folded" token="clamp" />
      </div>
    </section>
  );
}
