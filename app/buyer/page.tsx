import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { JwsView } from '@/components/ui/jws-view';
import { Notice, TONE_KIND } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ProofFields } from '@/components/ui/proof-fields';
import { ProofId } from '@/components/ui/proof-id';
import { StateGlyph } from '@/components/ui/state-glyph';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { mandates, type WalletStatus, wallets } from '@/lib/db/schema';
import { getPersona, SESSION_COOKIE } from '@/lib/session';
import { MandateForm } from './mandate-form';

export const metadata: Metadata = {
  title: 'Your mandate',
};

// The buyer's page: their active mandate as the signed document it is, the wallet that pays within
// it, and the form to write a new mandate. PayPal sends the buyer back here with `?wallet=` set to
// how linking their wallet went.

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

const WALLET_LABELS: Record<WalletStatus | 'none', string> = {
  linked: 'PayPal linked',
  pending: 'PayPal not linked yet',
  revoked: 'PayPal unlinked',
  none: 'No PayPal wallet',
};

export default async function BuyerPage({ searchParams }: PageProps<'/buyer'>) {
  // Reads the database on every request, never at build time.
  await connection();

  // The proxy already sends visitors without the buyer persona to the picker; this keeps the page
  // safe on its own.
  const persona = await getPersona((await cookies()).get(SESSION_COOKIE)?.value);
  if (persona !== 'buyer') redirect('/');

  const db = appDb();
  const buyerId = await demoBuyerId(db);
  const [[mandate], [wallet]] = await Promise.all([
    db
      .select({
        id: mandates.id,
        sourceText: mandates.sourceText,
        readback: mandates.readback,
        policyHash: mandates.policyHash,
        confirmedAt: mandates.confirmedAt,
        confirmation: mandates.confirmation,
        expiresAt: mandates.expiresAt,
        jws: mandates.jws,
      })
      .from(mandates)
      .where(and(eq(mandates.buyerId, buyerId), eq(mandates.status, 'active'))),
    db.select({ status: wallets.status }).from(wallets).where(eq(wallets.buyerId, buyerId)),
  ]);

  const { wallet: outcome } = await searchParams;
  const notice = typeof outcome === 'string' ? WALLET_NOTICES.get(outcome) : undefined;

  return (
    <div className="w-full max-w-3xl">
      <PageHeader
        title="Your mandate"
        purpose="Tell your agent what it may buy, in your own words. Behest reads it back, and your agent can only pay within what you confirm and sign."
      />

      {notice && (
        <Notice kind={TONE_KIND[notice.tone]} className="mb-6">
          {notice.text}
        </Notice>
      )}

      {mandate && <SignedMandate mandate={mandate} wallet={wallet?.status ?? 'none'} />}

      <section aria-labelledby="write-heading" className={mandate ? 'mt-10' : undefined}>
        <h2 id="write-heading" className="text-lead font-medium text-text">
          {mandate ? 'Write a new mandate' : 'Write your mandate'}
        </h2>
        {mandate && <p className="mt-1 text-body text-muted">Confirming a new mandate replaces the one above.</p>}
        <MandateForm replacing={mandate !== undefined} />
      </section>
    </div>
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
  readback: string[];
  policyHash: string;
  confirmedAt: Date;
  confirmation: 'session' | 'passkey';
  expiresAt: Date | null;
  jws: string;
};

/**
 * The active mandate as the signed document it is: the buyer's own words, the readback they
 * confirmed, the facts that identify it, and the signed token itself, which can be decoded and copied.
 */
function SignedMandate({ mandate, wallet }: { mandate: ActiveMandate; wallet: WalletStatus | 'none' }) {
  return (
    <section aria-labelledby="active-heading" className="rounded-panel border border-line bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <h2 id="active-heading" className="flex items-center gap-2 font-medium text-text">
          <span className="text-seal">
            <StateGlyph shape="filled" className="size-4" />
          </span>
          Your signed mandate
        </h2>
        <span className={`text-meta ${wallet === 'linked' ? 'text-seal' : 'text-muted'}`}>{WALLET_LABELS[wallet]}</span>
      </header>
      <div className="grid gap-5 p-4 sm:p-5">
        <figure>
          <figcaption className="text-meta text-muted">In your words</figcaption>
          <blockquote className="mt-1 border-l-2 border-line-strong pl-3 text-body break-words text-text">{mandate.sourceText}</blockquote>
        </figure>
        <div>
          <p className="text-meta text-muted">What your agent may do</p>
          <ul className="mt-1 grid list-disc gap-1 pl-5 text-body text-text marker:text-muted">
            {mandate.readback.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <ProofFields
          fields={[
            { label: 'Mandate id', value: <ProofId value={mandate.id} label="Mandate id" /> },
            { label: 'Policy hash', value: <ProofId value={mandate.policyHash} label="Policy hash" /> },
            { label: 'Signed at', value: <span className="font-mono text-meta">{dateTime.format(mandate.confirmedAt)} UTC</span> },
            { label: 'Confirmed by', value: mandate.confirmation === 'passkey' ? 'Your passkey' : 'Your signed-in session' },
            { label: 'Expires', value: mandate.expiresAt ? `${dateTime.format(mandate.expiresAt)} UTC` : 'Never' },
          ]}
        />
        <JwsView jws={mandate.jws} label="Signed mandate" decoded="folded" token="short" />
      </div>
    </section>
  );
}
