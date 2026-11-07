import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { Notice, TONE_KIND } from '@/components/ui/notice';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { mandates, type WalletStatus, wallets } from '@/lib/db/schema';
import { getPersona, SESSION_COOKIE } from '@/lib/session';
import { MandateForm } from './mandate-form';

export const metadata: Metadata = {
  title: 'Your mandate',
};

// The buyer's page: their active mandate and wallet, if any, and the form to write a new mandate.
// PayPal sends the buyer back here with `?wallet=` set to how linking their wallet went.

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
      .select({ sourceText: mandates.sourceText, readback: mandates.readback, confirmedAt: mandates.confirmedAt })
      .from(mandates)
      .where(and(eq(mandates.buyerId, buyerId), eq(mandates.status, 'active'))),
    db.select({ status: wallets.status }).from(wallets).where(eq(wallets.buyerId, buyerId)),
  ]);

  const { wallet: outcome } = await searchParams;
  const notice = typeof outcome === 'string' ? WALLET_NOTICES.get(outcome) : undefined;

  return (
    <div className="w-full max-w-2xl">
      <h1 className="text-3xl font-semibold text-pp-navy">Your mandate</h1>
      <p className="mt-3 text-pp-muted">
        Tell your agent what it may buy, in your own words. Behest reads it back to you, and your agent can only pay
        within what you confirm.
      </p>

      {notice && (
        <Notice kind={TONE_KIND[notice.tone]} className="mt-6">
          {notice.text}
        </Notice>
      )}

      {mandate && (
        <section aria-labelledby="active-heading" className="mt-8 rounded-xl border border-pp-border bg-pp-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="active-heading" className="text-lg font-semibold text-pp-navy">
              Active mandate
            </h2>
            <span
              className={`rounded-full px-3 py-1 text-sm ${
                wallet?.status === 'linked' ? 'bg-pp-highlight text-pp-blue-dark' : 'bg-pp-canvas text-pp-muted'
              }`}
            >
              {WALLET_LABELS[wallet?.status ?? 'none']}
            </span>
          </div>
          <blockquote className="mt-3 border-l-2 border-pp-border pl-3 text-pp-muted">{mandate.sourceText}</blockquote>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            {mandate.readback.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-pp-muted">Signed on {mandate.confirmedAt.toISOString().slice(0, 10)} (UTC).</p>
        </section>
      )}

      <section aria-labelledby="write-heading" className="mt-10">
        <h2 id="write-heading" className="text-lg font-semibold text-pp-navy">
          {mandate ? 'Write a new mandate' : 'Write your mandate'}
        </h2>
        {mandate && <p className="mt-1 text-sm text-pp-muted">Confirming a new mandate replaces the one above.</p>}
        <MandateForm replacing={mandate !== undefined} />
      </section>
    </div>
  );
}
