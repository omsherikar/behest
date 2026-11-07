// AG Studio's data sources for the dashboard: a table for each row type the data route returns
// (lib/dashboard/scope.ts), two tables derived from them (decision outcomes and cart lines), and
// two for the budget burn-down (lib/dashboard/budget.ts). Money arrives in integer cents and is
// shown in dollars, so Studio's currency format can display it. The seller's rows carry nothing
// about how the buyer's purchases were decided, so its report has no decision outcomes, mandates
// or budgets, and its purchases only the fields a seller may see.

import type {
  AgDataSourcesDefinition,
  AgExpressionFieldDefinition,
  AgFieldDefinition,
  AgFormat,
  AgRelationDefinition,
} from 'ag-studio';
import { budgetEffect, burnDown, periodBounds, type BudgetEffect } from '@/lib/dashboard/budget';
import { decisionOutcomes } from '@/lib/dashboard/reasons';
import type { DashboardData, DashboardPurchase, SellerPurchase } from '@/lib/dashboard/scope';
import type { TransactionMatch } from '@/lib/dashboard/transactions';
import { verdictWords } from '@/lib/ui/verdict';
import type { BehestRegistry } from './widgets';

// --- Helpers ----------------------------------------------------------------------

const CALENDAR_ID = 'calendar';

// [id, name, format, hide?]
type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean];

// Every amount is in US dollars, so money shows with its symbol.
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const fields = (specs: FieldSpec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({
    id,
    name,
    format,
    ...(format === 'currencyFormat' && { formatOptions: { format: USD } }),
    ...(hide && { hide }),
  }));

// Foreign key 'table.field' -> primary key 'table.field'.
const manyToOne = (id: string, source: string, target: string): AgRelationDefinition => {
  const [sourceTable, sourceField] = source.split('.');
  const [targetTable, targetField] = target.split('.');
  return {
    id,
    source: { tableId: sourceTable, fieldId: sourceField },
    target: { tableId: targetTable, fieldId: targetField },
    type: 'many-to-one',
  };
};

const onCalendar = (tableId: string, fieldId: string): AgRelationDefinition => ({
  id: `${tableId}-${fieldId}-calendar`,
  source: { tableId, fieldId },
  target: { calendarId: CALENDAR_ID },
  truncate: 'day',
});

const ratio = (id: string, name: string, description: string, numerator: string, denominator: string): AgExpressionFieldDefinition => ({
  id,
  name,
  description,
  format: 'percentageFormat',
  isMeasure: true,
  expression: { operator: 'divide', inputs: [{ id: numerator, aggregation: 'sum' }, { id: denominator, aggregation: 'sum' }] },
});

const dollars = (cents: number | null) => (cents === null ? null : cents / 100);
const flag = (on: boolean) => (on ? 1 : 0);

// 'awaiting_approval' -> 'Awaiting approval'
const words = (code: string) => code[0].toUpperCase() + code.slice(1).replaceAll('_', ' ');

const EFFECT_LABEL: Record<BudgetEffect, string> = { spent: 'Spent', in_flight: 'In flight', released: 'Released' };

const MATCH_LABEL: Record<TransactionMatch, string> = {
  capture: 'Purchase capture',
  related: 'Linked to a purchase',
  payout: 'Payout',
  unmatched: 'Not matched',
};


// --- Rows -------------------------------------------------------------------------

/** The buyer's and the operator's data, which say how each purchase was decided. */
type FullData = Exclude<DashboardData, { persona: 'seller' }>;

const nonPassing = (p: DashboardPurchase) =>
  decisionOutcomes(p).filter((o) => o.result === 'ask' || o.result === 'block').length;

/** A purchase as every persona may see it. */
const purchaseRow = (p: SellerPurchase) => ({
  id: p.id,
  createdAt: p.createdAt,
  sellerId: p.sellerId,
  verdict: p.verdict,
  // The verdict as the app's badges word it, for the page's verdict filter.
  verdictWords: verdictWords(p.verdict, false),
  status: words(p.status),
  itemCount: p.cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? null,
  total: dollars(p.totalCents),
  proposals: 1,
  allowed: flag(p.verdict === 'ALLOW'),
  asked: flag(p.verdict === 'ASK'),
  blocked: flag(p.verdict === 'BLOCK'),
  captureId: p.paypalCaptureId ?? 'None',
});

/** A purchase as the buyer and the operator see it, with how it was decided. */
const detailedPurchaseRow = (p: DashboardPurchase) => ({
  ...purchaseRow(p),
  buyerId: p.buyerId,
  mandateId: p.mandateId,
  request: p.request,
  gateVerdict: p.gateVerdict,
  intent: p.intent ? words(p.intent.verdict) : 'Not run',
  approver: p.approver === 'human' ? 'Buyer' : p.approver === 'policy' ? 'Policy' : null,
  budgetEffect: EFFECT_LABEL[budgetEffect(p.status)],
  rulesFlagged: nonPassing(p),
});

/** Every gate rule's outcome for each purchase, then the intent check's reasons when it asked or blocked. */
function decisionRows(data: FullData) {
  return data.purchases.flatMap((p) =>
    decisionOutcomes(p).map((o, position) => ({
      id: `${p.id}:${position}`,
      purchaseId: p.id,
      position,
      rule: words(o.rule),
      result: words(o.result),
      detail: o.detail,
    })),
  );
}

function cartItemRows(data: DashboardData) {
  return data.purchases.flatMap((p) =>
    (p.cart?.items ?? []).map((item) => ({
      id: `${p.id}:${item.sku}`,
      purchaseId: p.id,
      sku: item.sku,
      title: item.title,
      category: words(item.category),
      quantity: item.quantity,
      unitPrice: dollars(item.unitPriceCents),
      lineTotal: dollars(item.unitPriceCents * item.quantity),
    })),
  );
}

function receiptRows(data: DashboardData) {
  const purchases = new Map(data.purchases.map((p) => [p.id, p]));
  return data.receipts.map((r) => {
    const cart = purchases.get(r.purchaseId)?.cart ?? null;
    return {
      id: r.id,
      purchaseId: r.purchaseId,
      issuedAt: r.createdAt,
      keyId: r.keyId,
      sellerSlug: cart?.seller.slug ?? null,
      jws: r.jws,
      // The cart the receipt was issued for, as the seller received it; the receipt card sends it
      // to the verifier along with the receipt.
      cart: cart ? JSON.stringify(cart) : null,
    };
  });
}

/** One row per active mandate: its budget for the current period, and how much of it is used. */
function budgetTables(data: FullData) {
  const now = new Date(data.asOf);
  const budgets = [];
  const steps = [];
  for (const mandate of data.mandates.filter((m) => m.status === 'active')) {
    const { amountCents, period } = mandate.policy.budget;
    const bounds = periodBounds(
      period,
      now,
      new Date(mandate.confirmedAt),
      mandate.expiresAt ? new Date(mandate.expiresAt) : null,
    );
    // The gate counts all of a buyer's purchases in the period against the active mandate.
    const purchases = data.purchases
      .filter((p) => p.buyerId === mandate.buyerId)
      .map((p) => ({ id: p.id, createdAt: new Date(p.createdAt), totalCents: p.totalCents, status: p.status }));
    const burn = burnDown(amountCents, bounds, purchases);

    budgets.push({
      mandateId: mandate.id,
      period: words(period === 'once' ? 'one_off' : period),
      periodStart: burn.start.toISOString(),
      periodEnd: burn.end?.toISOString() ?? null,
      budget: dollars(burn.budgetCents),
      spent: dollars(burn.spentCents),
      inFlight: dollars(burn.inFlightCents),
      remaining: dollars(burn.remainingCents),
      committed: dollars(burn.spentCents + burn.inFlightCents),
    });
    steps.push(
      ...burn.steps.map((s) => ({
        id: `${mandate.id}:${s.purchaseId}`,
        mandateId: mandate.id,
        purchaseId: s.purchaseId,
        at: s.at.toISOString(),
        effect: EFFECT_LABEL[s.effect],
        amount: dollars(s.amountCents),
        spentToDate: dollars(s.spentCents),
        inFlightToDate: dollars(s.inFlightCents),
        remaining: dollars(s.remainingCents),
      })),
    );
  }
  return { budgets, steps };
}

// --- Data sources -----------------------------------------------------------------

// Whether there is anything to report on. Without it, Studio would only show empty widgets.
export const hasData = (data: DashboardData) =>
  [data.purchases, data.products, data.mandates].some((rows) => rows.length > 0);

// Tables only the buyer and the operator get: how purchases were decided, and budgets.
const BUYER_SIDE_TABLES = new Set(['gateOutcomes', 'mandates', 'budgets', 'budgetSteps']);

const tablesOf = (relation: AgRelationDefinition) =>
  [relation.source, relation.target].flatMap((end) => ('tableId' in end ? [end.tableId] : []));

export function buildStudioData(data: DashboardData): AgDataSourcesDefinition<BehestRegistry> {
  const full = data.persona === 'seller' ? null : data;
  const visible = (tableId: string) => full !== null || !BUYER_SIDE_TABLES.has(tableId);
  const purchases = full ? full.purchases.map(detailedPurchaseRow) : data.purchases.map(purchaseRow);
  const { budgets, steps } = full ? budgetTables(full) : { budgets: [], steps: [] };
  const dates = [...data.purchases.map((p) => p.createdAt), ...data.transactions.map((t) => t.date)]
    .filter((d): d is string => !!d)
    .map((d) => d.slice(0, 10))
    .sort();
  const today = data.asOf.slice(0, 10);

  return {
    description:
      'Behest: an AI shopping agent buys inside a spending mandate its buyer signed. A deterministic policy gate gives every ' +
      'proposed purchase a verdict: ALLOW pays at once, ASK waits for the buyer to approve at PayPal, BLOCK pays nothing. ' +
      'Each paid purchase carries a signed receipt, and sellers are paid by PayPal Payouts. Money is in USD. ' +
      `These rows are what the ${data.persona} may see.`,
    sources: [
      {
        id: 'purchases',
        description:
          'One row per purchase the agent proposed. Verdict is the final one (after the intent check). Allowed, Needed ' +
          'approval and Blocked are 1 or 0, so their sums count purchases.' +
          (full
            ? ' Budget effect says whether the total counts against the budget as spent, is reserved in flight, or was ' +
              'released (blocked, cancelled, failed or refunded).'
            : ''),
        data: purchases,
        fields: fields([
          ['id', 'Purchase ID', 'textFormat'],
          ['createdAt', 'Proposed at', 'dateTimeFormat'],
          ['sellerId', 'Seller ID', 'textFormat', true],
          ['verdict', 'Verdict', 'textFormat'],
          ['verdictWords', 'Verdict in words', 'textFormat'],
          ['status', 'Status', 'textFormat'],
          ['itemCount', 'Items', 'integerFormat'],
          ['total', 'Total', 'currencyFormat'],
          ['proposals', 'Proposals', 'integerFormat'],
          ['allowed', 'Allowed', 'integerFormat'],
          ['asked', 'Needed approval', 'integerFormat'],
          ['blocked', 'Blocked', 'integerFormat'],
          ['captureId', 'PayPal capture', 'textFormat'],
          ...(full
            ? ([
                ['buyerId', 'Buyer ID', 'textFormat', true],
                ['mandateId', 'Mandate ID', 'textFormat', true],
                ['request', 'Request', 'textFormat'],
                ['gateVerdict', 'Gate verdict', 'textFormat'],
                ['intent', 'Intent check', 'textFormat'],
                ['approver', 'Approved by', 'textFormat'],
                ['budgetEffect', 'Budget effect', 'textFormat'],
                ['rulesFlagged', 'Rules flagged', 'integerFormat'],
              ] satisfies FieldSpec[])
            : []),
        ]),
      },
      {
        id: 'gateOutcomes',
        name: 'Decision outcomes',
        description:
          'Every policy gate rule evaluated for each purchase, in rule order, then the intent check (rule "Intent check") ' +
          'when it asked or blocked. Result is Pass, Ask, Block or Skip; detail explains it in words. The reasons for a ' +
          'verdict are the outcomes that asked or blocked.',
        data: full ? decisionRows(full) : [],
        fields: fields([
          ['id', 'Outcome ID', 'textFormat', true],
          ['purchaseId', 'Outcome purchase ID', 'textFormat'],
          ['position', 'Rule order', 'integerFormat'],
          ['rule', 'Rule', 'textFormat'],
          ['result', 'Rule result', 'textFormat'],
          ['detail', 'Rule detail', 'textFormat'],
        ]),
      },
      {
        id: 'cartItems',
        name: 'Cart lines',
        description: 'The lines of each purchase cart, rebuilt from the seller catalogue at proposal time.',
        data: cartItemRows(data),
        fields: fields([
          ['id', 'Cart line ID', 'textFormat', true],
          ['purchaseId', 'Purchase ID', 'textFormat', true],
          ['sku', 'SKU', 'textFormat'],
          ['title', 'Item', 'textFormat'],
          ['category', 'Category', 'textFormat'],
          ['quantity', 'Quantity', 'integerFormat'],
          ['unitPrice', 'Unit price', 'currencyFormat'],
          ['lineTotal', 'Line total', 'currencyFormat'],
        ]),
      },
      {
        id: 'purchaseEvents',
        name: 'Purchase events',
        description:
          'The append-only log of each purchase. Status events record a status change, with the status before and after; ' +
          'the seller sees only those.',
        data: data.purchaseEvents.map((e) => ({
          ...e,
          kind: words(e.kind),
          from: e.from && words(e.from),
          to: e.to && words(e.to),
        })),
        fields: fields([
          ['id', 'Event ID', 'textFormat', true],
          ['purchaseId', 'Purchase ID', 'textFormat', true],
          ['seq', 'Event order', 'integerFormat', true],
          ['kind', 'Event', 'textFormat'],
          ['from', 'Status before', 'textFormat'],
          ['to', 'Status after', 'textFormat'],
          ['createdAt', 'Event time', 'dateTimeFormat'],
        ]),
      },
      {
        id: 'receipts',
        description:
          'Signed receipts (compact JWS, Ed25519) for paid purchases, with the cart each was issued for. A seller verifies ' +
          'one with Behest\'s public key, the receipt and that cart.',
        data: receiptRows(data),
        fields: fields([
          ['id', 'Receipt ID', 'textFormat'],
          ['purchaseId', 'Receipt purchase ID', 'textFormat', true],
          ['issuedAt', 'Issued at', 'dateTimeFormat'],
          ['keyId', 'Signing key', 'textFormat'],
          ['sellerSlug', 'Receipt seller', 'textFormat'],
          ['jws', 'Receipt JWS', 'textFormat'],
          ['cart', 'Receipt cart', 'textFormat'],
        ]),
      },
      {
        id: 'payouts',
        description: 'PayPal Payouts to sellers, one per settled purchase.',
        data: data.payouts.map((p) => ({ ...p, amount: dollars(p.amountCents), pending: flag(p.status === 'PENDING') })),
        fields: fields([
          ['id', 'Payout ID', 'textFormat', true],
          ['purchaseId', 'Payout purchase ID', 'textFormat', true],
          ['createdAt', 'Payout created', 'dateTimeFormat'],
          ['amount', 'Payout amount', 'currencyFormat'],
          ['status', 'Payout status', 'textFormat'],
          ['pending', 'Payouts pending', 'integerFormat'],
          ['paypalBatchId', 'PayPal payout batch', 'textFormat'],
        ]),
      },
      {
        id: 'sellers',
        description: 'Sellers whose catalogues the agent can buy from.',
        data: data.sellers,
        fields: fields([
          ['id', 'Seller ID', 'textFormat', true],
          ['slug', 'Seller slug', 'textFormat'],
          ['name', 'Seller', 'textFormat'],
        ]),
      },
      {
        id: 'products',
        description:
          'Catalogue listings. Market median is the Channel3 benchmark price; the gate asks when a price is over 1.5 times it. ' +
          'Flagged listings failed screening (for example, text aimed at agents) and are always blocked.',
        data: data.products.map((p) => ({
          ...p,
          category: words(p.category),
          price: dollars(p.priceCents),
          marketMedian: dollars(p.marketMedianCents),
          priceToMarket: p.marketMedianCents ? p.priceCents / p.marketMedianCents : null,
          flagged: flag(p.flags.length > 0),
          flags: p.flags.length > 0 ? p.flags.map(words).join(', ') : 'None',
        })),
        fields: fields([
          ['id', 'Product ID', 'textFormat', true],
          ['sellerId', 'Seller ID', 'textFormat', true],
          ['sku', 'Product SKU', 'textFormat'],
          ['title', 'Product', 'textFormat'],
          ['category', 'Product category', 'textFormat'],
          ['price', 'Price', 'currencyFormat'],
          ['marketMedian', 'Market median', 'currencyFormat'],
          ['priceToMarket', 'Price to market', 'percentageFormat'],
          ['stock', 'Stock', 'integerFormat'],
          ['flagged', 'Flagged listings', 'integerFormat'],
          ['flags', 'Screening flags', 'textFormat'],
        ]),
      },
      {
        id: 'mandates',
        description: 'Spending mandates the buyer signed: budget per period, per-purchase cap and the amount above which the agent asks.',
        data: (full?.mandates ?? []).map((m) => ({
          id: m.id,
          status: words(m.status),
          period: words(m.policy.budget.period === 'once' ? 'one_off' : m.policy.budget.period),
          budget: dollars(m.policy.budget.amountCents),
          perPurchaseMax: dollars(m.policy.perPurchaseMaxCents),
          askAbove: dollars(m.policy.askAboveCents),
          confirmedAt: m.confirmedAt,
          expiresAt: m.expiresAt,
        })),
        fields: fields([
          ['id', 'Mandate', 'textFormat', true],
          ['status', 'Mandate status', 'textFormat'],
          ['period', 'Mandate period', 'textFormat'],
          ['budget', 'Mandate budget', 'currencyFormat'],
          ['perPurchaseMax', 'Per-purchase cap', 'currencyFormat'],
          ['askAbove', 'Ask above', 'currencyFormat'],
          ['confirmedAt', 'Confirmed at', 'dateTimeFormat'],
          ['expiresAt', 'Expires at', 'dateTimeFormat'],
        ]),
      },
      {
        id: 'budgets',
        name: 'Budget this period',
        description:
          'For each active mandate, its budget in the current UTC period (calendar day, week from Monday, month, or one-off) ' +
          'and how much of it is spent (captured) or reserved by purchases still in flight. Budget left is what the gate ' +
          'would still allow.',
        data: budgets,
        fields: fields([
          ['mandateId', 'Budget mandate ID', 'textFormat'],
          ['period', 'Budget period', 'textFormat'],
          ['periodStart', 'Period start', 'dateTimeFormat'],
          ['periodEnd', 'Period end', 'dateTimeFormat'],
          ['budget', 'Budget', 'currencyFormat'],
          ['spent', 'Spent this period', 'currencyFormat'],
          ['inFlight', 'Reserved in flight', 'currencyFormat'],
          ['remaining', 'Budget left', 'currencyFormat'],
          ['committed', 'Spent or reserved', 'currencyFormat'],
        ]),
      },
      {
        id: 'budgetSteps',
        name: 'Budget steps',
        description: 'Each purchase counted against an active mandate this period, in time order, with running totals.',
        data: steps,
        fields: fields([
          ['id', 'Step ID', 'textFormat', true],
          ['mandateId', 'Step mandate ID', 'textFormat'],
          ['purchaseId', 'Step purchase ID', 'textFormat', true],
          ['at', 'Counted at', 'dateTimeFormat'],
          ['effect', 'Counted as', 'textFormat'],
          ['amount', 'Amount counted', 'currencyFormat'],
          ['spentToDate', 'Spent to date', 'currencyFormat'],
          ['inFlightToDate', 'In flight to date', 'currencyFormat'],
          ['remaining', 'Left after step', 'currencyFormat'],
        ]),
      },
      {
        id: 'transactions',
        description:
          'The merchant account ledger from PayPal Transaction Search, last 31 days (operator only). Reconciliation says ' +
          'whether a transaction is a purchase capture, references one (refunds, reversals, holds), is a payout, or matches nothing.',
        data: data.transactions.map((t) => ({
          ...t,
          match: MATCH_LABEL[t.match],
          amount: t.amountCents / 100,
          fee: t.feeCents / 100,
          net: (t.amountCents + t.feeCents) / 100,
          captures: flag(t.match === 'capture'),
          unmatched: flag(t.match === 'unmatched'),
        })),
        fields: fields([
          ['id', 'Transaction ID', 'textFormat'],
          ['purchaseId', 'Transaction purchase ID', 'textFormat', true],
          ['date', 'Transaction date', 'dateTimeFormat'],
          ['eventType', 'Event type', 'textFormat'],
          ['status', 'Transaction status', 'textFormat'],
          ['match', 'Reconciliation', 'textFormat'],
          ['amount', 'Transaction amount', 'currencyFormat'],
          ['fee', 'Transaction fee', 'currencyFormat'],
          ['net', 'Transaction net', 'currencyFormat'],
          ['captures', 'Matched captures', 'integerFormat'],
          ['unmatched', 'Unmatched transactions', 'integerFormat'],
          ['counterparty', 'Counterparty', 'textFormat'],
          ['note', 'Transaction note', 'textFormat'],
        ]),
      },
    ].filter((source) => visible(source.id)),
    relationships: [
      manyToOne('purchase-seller', 'purchases.sellerId', 'sellers.id'),
      manyToOne('purchase-mandate', 'purchases.mandateId', 'mandates.id'),
      manyToOne('outcome-purchase', 'gateOutcomes.purchaseId', 'purchases.id'),
      manyToOne('item-purchase', 'cartItems.purchaseId', 'purchases.id'),
      manyToOne('event-purchase', 'purchaseEvents.purchaseId', 'purchases.id'),
      manyToOne('receipt-purchase', 'receipts.purchaseId', 'purchases.id'),
      manyToOne('payout-purchase', 'payouts.purchaseId', 'purchases.id'),
      manyToOne('product-seller', 'products.sellerId', 'sellers.id'),
      manyToOne('budget-mandate', 'budgets.mandateId', 'mandates.id'),
      manyToOne('step-purchase', 'budgetSteps.purchaseId', 'purchases.id'),
      manyToOne('transaction-purchase', 'transactions.purchaseId', 'purchases.id'),
      onCalendar('purchases', 'createdAt'),
      onCalendar('purchaseEvents', 'createdAt'),
      onCalendar('payouts', 'createdAt'),
      onCalendar('transactions', 'date'),
    ].filter((relation) => tablesOf(relation).every(visible)),
    calendars: [
      {
        id: CALENDAR_ID,
        label: 'Calendar',
        range: {
          from: { type: 'date', value: dates[0] ?? today },
          to: { type: 'date', value: dates.at(-1) ?? today },
        },
        fragments: ['year', 'quarter', 'month', 'week', 'day', 'dayOfWeek'],
      },
    ],
    expressions: [
      ...(full
        ? [ratio('budgetUsed', 'Budget used', 'Share of the budget this period that is spent or reserved in flight.', 'budgets.committed', 'budgets.budget')]
        : []),
      ratio('approvalRate', 'Approval rate', 'Share of proposals that needed the buyer to approve.', 'purchases.asked', 'purchases.proposals'),
      ratio('blockRate', 'Block rate', 'Share of proposals the gate or intent check blocked.', 'purchases.blocked', 'purchases.proposals'),
    ],
  };
}
