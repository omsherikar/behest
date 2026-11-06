'use client';

// The receipt card: a signed receipt's claims, checked live. For the receipt in view it asks
// Behest's verifier (POST /api/receipts/verify), in audit mode, with the receipt and the cart it
// was issued for, and marks each claim once the verifier accepts the receipt. Audit mode checks
// the signature, seller, cart and amount; it skips freshness and replay, which only matter when a
// seller first takes the order. It
// follows the page's filters, so selecting a purchase in a decision ledger on the same page shows
// that purchase's receipt.

import { useEffect, useState } from 'react';
import type { AgWidgetDataFormat, AgWidgetParams } from 'ag-studio';
import {
  decodeReceipt,
  formatUtc,
  receiptClaims,
  verifyReceipt,
  type ReceiptClaim,
  type Verification,
} from '@/lib/dashboard/receipt';
import { Cart } from '@/lib/domain/cart';
import { WIDGET_FIELDS } from '../studio/fields';
import { asDate, findFields, LoadFailed, MissingFields, useWidgetLoad, WidgetMessage } from './shared';

export type ReceiptCardStyle = {
  /** Also list the claims carried under the signature (decision, rules, mandate, payment). */
  showSignedClaims?: boolean;
};

export interface ReceiptCardDef {
  type: 'behest-receipt';
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<ReceiptCardStyle>;
}

type ReceiptRow = { id: string; issuedAt: Date | null; sellerSlug: string | null; jws: string; cart: Cart | null };

const F = WIDGET_FIELDS;
const RECEIPT_FIELDS = [F.receiptId, F.receiptIssuedAt, F.receiptSellerSlug, F.receiptJws, F.receiptCart] as const;

/** The receipts in view, newest first; null when the report lacks the receipt fields. */
async function loadReceipts({ widgetApi }: AgWidgetParams<ReceiptCardDef>): Promise<ReceiptRow[] | null> {
  const f = findFields(widgetApi, RECEIPT_FIELDS);
  if (!f) return null;
  const response = await widgetApi.getData(
    { fields: RECEIPT_FIELDS.map((id) => f[id]), sort: [{ field: f[F.receiptIssuedAt], direction: 'desc' }] },
    { queryId: 'receipts' },
  );
  return response.results.rows.map((row) => {
    const cartJson = row[f[F.receiptCart].key];
    let cart: Cart | null = null;
    try {
      const parsed = Cart.safeParse(typeof cartJson === 'string' ? JSON.parse(cartJson) : null);
      cart = parsed.success ? parsed.data : null;
    } catch {
      cart = null;
    }
    const sellerSlug = row[f[F.receiptSellerSlug].key];
    return {
      id: String(row[f[F.receiptId].key]),
      issuedAt: asDate(row[f[F.receiptIssuedAt].key]),
      sellerSlug: typeof sellerSlug === 'string' ? sellerSlug : null,
      jws: String(row[f[F.receiptJws].key] ?? ''),
      cart,
    };
  });
}

async function verify(receipt: ReceiptRow, signal: AbortSignal): Promise<Verification> {
  if (!receipt.cart || !receipt.sellerSlug) {
    return { state: 'unavailable', message: 'The cart this receipt was issued for is missing, so it cannot be checked.' };
  }
  return verifyReceipt({ jws: receipt.jws, cart: receipt.cart, sellerSlug: receipt.sellerSlug }, { signal });
}

// --- Pieces -----------------------------------------------------------------------

type Status = Verification['state'] | 'verifying';

const STATUS: Record<Status, { label: string; pill: string; icon: string; path: string }> = {
  verified: {
    label: 'Verified',
    pill: 'border-pp-success/30 bg-pp-success/10',
    icon: 'text-pp-success',
    path: 'm5 12.5 4.5 4.5L19 7.5',
  },
  rejected: {
    label: 'Not verified',
    pill: 'border-pp-danger/30 bg-pp-danger/10',
    icon: 'text-pp-danger',
    path: 'M7 7l10 10M17 7 7 17',
  },
  unavailable: {
    label: 'Verification unavailable',
    pill: 'border-pp-border bg-pp-canvas',
    icon: 'text-pp-muted',
    path: 'M12 7v6M12 17h.01',
  },
  verifying: {
    label: 'Verifying',
    pill: 'border-pp-blue/30 bg-pp-highlight',
    icon: 'text-pp-blue animate-spin',
    path: 'M12 4a8 8 0 1 0 8 8',
  },
};

function StatusPill({ status }: { status: Status }) {
  const style = STATUS[status];
  return (
    <span
      role="status"
      className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-sm font-semibold text-pp-ink ${style.pill}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`size-4 ${style.icon}`}>
        <path d={style.path} />
      </svg>
      {style.label}
    </span>
  );
}

function ClaimMark({ verified }: { verified: boolean }) {
  return verified ? (
    <span aria-label="Verified" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-pp-success text-white">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3">
        <path d="m5 12.5 4.5 4.5L19 7.5" />
      </svg>
    </span>
  ) : (
    <span aria-label="Not verified" className="size-5 shrink-0 rounded-full border-2 border-dashed border-pp-border" />
  );
}

function ClaimList({ title, claims, verified }: { title: string; claims: ReceiptClaim[]; verified: boolean }) {
  return (
    <section>
      <h3 className="pb-1.5 text-xs font-semibold uppercase tracking-wider text-pp-muted">{title}</h3>
      <ul className="flex flex-col gap-2">
        {claims.map((claim) => (
          <li key={claim.label} className="flex items-start gap-2.5">
            <ClaimMark verified={verified} />
            <span className="min-w-0 text-sm leading-5">
              <span className="font-semibold text-pp-navy">{claim.label}</span>{' '}
              <span className={`break-words ${verified ? 'text-pp-ink' : 'text-pp-muted'}`}>{claim.value}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PagerButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-full text-lg leading-none text-pp-navy hover:bg-pp-highlight disabled:text-pp-border disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// --- Widget -----------------------------------------------------------------------

export function ReceiptCardWidget(params: AgWidgetParams<ReceiptCardDef>) {
  const load = useWidgetLoad(params, loadReceipts);
  const receipts = load.status === 'loaded' ? load.value : null;
  const [position, setPosition] = useState(0);
  // Verifier answers by receipt id and attempt, so "Verify again" asks afresh.
  const [answers, setAnswers] = useState<Record<string, Verification>>({});
  const [attempt, setAttempt] = useState(0);
  const showSignedClaims = params.format?.style?.showSignedClaims !== false;

  const index = receipts ? Math.min(position, Math.max(receipts.length - 1, 0)) : 0;
  const receipt = receipts?.[index];
  const answerKey = receipt ? `${receipt.id}#${attempt}` : null;
  const answer = answerKey ? answers[answerKey] : undefined;

  useEffect(() => {
    if (!receipt || !answerKey || answers[answerKey]) return;
    const controller = new AbortController();
    verify(receipt, controller.signal).then((result) => {
      if (!controller.signal.aborted) setAnswers((current) => ({ ...current, [answerKey]: result }));
    });
    return () => controller.abort();
  }, [receipt, answerKey, answers]);

  if (load.status === 'loading') return null;
  if (load.status === 'failed') return <LoadFailed />;
  if (receipts === null) return <MissingFields widget="receipt card" />;
  if (!receipt) {
    return (
      <WidgetMessage title="No receipts in view">
        A receipt is issued for every paid purchase. Select a paid purchase in the ledger, or clear the filters.
      </WidgetMessage>
    );
  }

  const decoded = decodeReceipt(receipt.jws);
  const status: Status = answer?.state ?? 'verifying';
  const verified = answer?.state === 'verified';
  const claims = decoded
    ? receiptClaims(verified ? { ...decoded, payload: answer.payload } : decoded)
    : [];
  const checked = claims.filter((c) => c.kind === 'checked');
  const signed = claims.filter((c) => c.kind === 'signed');

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-2 pb-2 font-paypal text-pp-ink">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <StatusPill status={status} />
          <p className="mt-2 truncate font-mono text-xs text-pp-muted" title={receipt.id}>
            Receipt {receipt.id}
          </p>
          <p className="text-sm text-pp-muted">
            {receipt.issuedAt ? `Issued ${formatUtc(receipt.issuedAt)}` : 'Issue time unknown'}
            {receipt.sellerSlug && ` to ${receipt.sellerSlug}`}
          </p>
        </div>
        {receipts.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 text-sm text-pp-muted">
            <PagerButton label="Newer receipt" disabled={index === 0} onClick={() => setPosition(index - 1)}>
              ‹
            </PagerButton>
            <span className="tabular-nums">
              {index + 1} of {receipts.length}
            </span>
            <PagerButton label="Older receipt" disabled={index === receipts.length - 1} onClick={() => setPosition(index + 1)}>
              ›
            </PagerButton>
          </div>
        )}
      </div>

      {answer?.state === 'rejected' && (
        <p className="rounded-md border border-pp-danger/30 bg-pp-danger/10 px-3 py-2 text-sm">
          <span className="font-semibold">The verifier rejected this receipt:</span> {answer.reason}. None of its claims can be trusted.
        </p>
      )}
      {answer?.state === 'unavailable' && (
        <p className="rounded-md border border-pp-border bg-pp-canvas px-3 py-2 text-sm text-pp-muted">
          {answer.message} The claims below are shown as issued, not verified.
        </p>
      )}

      {decoded ? (
        <>
          <ClaimList title="Checked against the cart" claims={checked} verified={verified} />
          {showSignedClaims && <ClaimList title="Signed claims" claims={signed} verified={verified} />}
        </>
      ) : (
        <p className="text-sm text-pp-muted">This receipt could not be read as a Behest receipt.</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-pp-gridline pt-3">
        <p className="text-xs text-pp-muted">Checked in audit mode: signature, seller, cart and amount.</p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          disabled={status === 'verifying'}
          className="inline-flex h-8 shrink-0 items-center rounded-full px-3 text-sm font-semibold text-pp-blue hover:bg-pp-highlight disabled:text-pp-muted"
        >
          Verify again
        </button>
      </div>
    </div>
  );
}
