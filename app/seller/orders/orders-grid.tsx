'use client';

import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { useState } from 'react';
import { JwsView } from '@/components/ui/jws-view';
import { Money } from '@/components/ui/money';
import { ProofId } from '@/components/ui/proof-id';
import { SidePanel } from '@/components/ui/side-panel';
import { type BadgeTone, StatusBadge } from '@/components/ui/status-badge';
import { VerifyReceipt } from '@/components/ui/verify-receipt';
import { formatUsd } from '@/lib/domain/money';
import { shortId } from '@/lib/ui/format';
import type { PayoutState, ReceiptCheck, SellerOrderRow } from '@/lib/seller-pages/orders';
import { SellerGrid } from '../seller-grid';

// The seller's agent orders, newest first: how the check of the receipt presented with each one
// went, why it was refused when it was, the cart total and, for an accepted order, the payout.
// Clicking a row, or pressing Enter on it, opens the order: the cart received and the receipt as
// presented, decoded, which the seller can check again in audit mode. Nothing about the buyer is
// here: no request, no reasons, no intent check and no mandate.

// 6 Nov 2026, 11:20, in UTC as the column header says.
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

const CHECKS: Record<ReceiptCheck, { tone: BadgeTone; word: string }> = {
  verified: { tone: 'seal', word: 'Verified' },
  rejected: { tone: 'stop', word: 'Rejected' },
  replayed: { tone: 'stop', word: 'Replayed' },
};

const PAYOUTS: Record<PayoutState, BadgeTone> = { paid: 'seal', pending: 'muted', held: 'hold', failed: 'stop' };

function CheckBadge({ check }: { check: ReceiptCheck }) {
  return (
    <StatusBadge tone={CHECKS[check].tone} label="Receipt check">
      {CHECKS[check].word}
    </StatusBadge>
  );
}

function PayoutBadge({ row }: { row: SellerOrderRow }) {
  if (row.payoutState === null || row.payout === null) return null;
  return (
    <StatusBadge tone={PAYOUTS[row.payoutState]} label="Payout">
      {row.payout}
    </StatusBadge>
  );
}

const CheckCell = ({ data }: CustomCellRendererProps<SellerOrderRow>) => (data ? <CheckBadge check={data.check} /> : null);
const PayoutCell = ({ data }: CustomCellRendererProps<SellerOrderRow>) => (data ? <PayoutBadge row={data} /> : null);

const columns: ColDef<SellerOrderRow>[] = [
  {
    field: 'createdAt',
    headerName: 'Time (UTC)',
    sort: 'desc',
    cellClass: 'font-mono',
    valueFormatter: ({ value }: ValueFormatterParams<SellerOrderRow, string>) =>
      value ? dateTime.format(new Date(value)) : '',
    getQuickFilterText: ({ value }) => (value ? dateTime.format(new Date(value)) : ''),
  },
  {
    field: 'check',
    headerName: 'Receipt check',
    valueGetter: ({ data }) => (data ? CHECKS[data.check].word : ''),
    cellRenderer: CheckCell,
  },
  { field: 'reason', headerName: 'Why rejected', valueFormatter: ({ value }) => value ?? '' },
  {
    field: 'totalCents',
    headerName: 'Cart total',
    type: 'numeric',
    valueFormatter: ({ value }: ValueFormatterParams<SellerOrderRow, number | null>) =>
      typeof value === 'number' ? formatUsd(value) : '',
    filter: 'agNumberColumnFilter',
    filterValueGetter: ({ data }) => (typeof data?.totalCents === 'number' ? data.totalCents / 100 : null),
  },
  { field: 'payout', headerName: 'Payout', valueGetter: ({ data }) => data?.payout ?? '', cellRenderer: PayoutCell },
  {
    field: 'receiptId',
    headerName: 'Receipt id',
    cellClass: 'font-mono',
    valueFormatter: ({ value }) => (value ? shortId(value) : 'None readable'),
  },
];

/** The side panel for one order: its check, its payout, the cart received and the receipt presented. */
function OrderPanel({ order, sellerSlug, onClose }: { order: SellerOrderRow | null; sellerSlug: string; onClose: () => void }) {
  return (
    <SidePanel
      open={order !== null}
      onClose={onClose}
      title={order ? `Order of ${order.totalCents === null ? 'an unknown amount' : formatUsd(order.totalCents)}` : ''}
      subtitle={order && `Received ${dateTime.format(new Date(order.createdAt))} UTC`}
    >
      {order && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CheckBadge check={order.check} />
            <PayoutBadge row={order} />
          </div>
          {order.reason && <p className="-mt-3 text-body text-stop">{order.reason}.</p>}
          {order.check === 'replayed' && (
            <p className="-mt-4 text-body text-muted">
              The receipt itself may be genuine: it was refused because an earlier order already used it.
            </p>
          )}

          <section aria-labelledby="order-items">
            <h3 id="order-items" className="text-meta text-muted">
              What was ordered
            </h3>
            <ul className="mt-2 divide-y divide-line rounded-panel border border-line">
              {order.cart.items.map((item) => (
                <li key={item.sku} className="flex items-baseline justify-between gap-4 px-4 py-3 text-body">
                  <span className="min-w-0 break-words text-text">
                    {item.quantity} × {item.title} <span className="ml-1 font-mono text-meta text-muted">{item.sku}</span>
                  </span>
                  <Money cents={item.unitPriceCents * item.quantity} mono className="shrink-0 text-meta text-text" />
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="order-receipt" className="grid gap-3">
            <h3 id="order-receipt" className="text-meta text-muted">
              The receipt presented with it
            </h3>
            {order.receiptId && <ProofId value={order.receiptId} label="Receipt id" />}
            <JwsView jws={order.receiptJws} decoded="folded" token="short" />
            <VerifyReceipt jws={order.receiptJws} cart={order.cart} sellerSlug={sellerSlug} />
          </section>
        </>
      )}
    </SidePanel>
  );
}

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function OrdersGrid({ rows, labelledBy, sellerSlug }: { rows: SellerOrderRow[]; labelledBy: string; sellerSlug: string }) {
  const [open, setOpen] = useState<SellerOrderRow | null>(null);
  return (
    <>
      <SellerGrid rows={rows} columns={columns} label="orders" labelledBy={labelledBy} onOpen={setOpen} />
      <OrderPanel order={open} sellerSlug={sellerSlug} onClose={() => setOpen(null)} />
    </>
  );
}
