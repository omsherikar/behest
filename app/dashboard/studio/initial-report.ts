// The built-in report for each persona, as AG Studio report state. Every persona gets the pages
// that make sense for it: the buyer sees its agent's decisions, budget, receipts and the
// catalogue; the seller sees the orders placed with it, its receipts and payouts and its
// catalogue, with nothing about how the buyer's agent decided (its data has none); the operator
// sees everything plus reconciliation against PayPal. Field ids
// ('purchases.total') refer to the data sources in ./data.ts; 'behest-*' widgets are in ./widgets.ts.

import type { AgPageState, AgWidgetLayoutState } from 'ag-studio';
import type { Persona } from '@/lib/session';
import type { BehestRegistry, ReportState } from './widgets';

// --- Helpers ----------------------------------------------------------------------

type PageState = AgPageState<BehestRegistry>;

// Position on the canvas grid, in tracks: 24 columns wide, rows of studioCanvasRowHeight.
const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({
  xTrack,
  yTrack,
  xSpan,
  ySpan,
});
const title = (text: string) => ({ title: { enabled: true, text } });
const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const avg = (id: string) => ({ id, aggregation: 'avg' as const });
const countd = (id: string) => ({ id, aggregation: 'countd' as const });
const withLegend = { style: { theme: { common: { legend: { enabled: true } } } } };

// The app's type (app/globals.css): IBM Plex Sans for words, IBM Plex Mono for the numbers.
const SANS = 'var(--font-sans-stack)';
const MONO = 'var(--font-mono-stack)';

const typography = (fontSize: number, fontWeight: 'normal' | 'bold' = 'normal', fontFamily = SANS) => ({
  fontFamily,
  fontSize,
  fontWeight,
  fontStyle: 'normal' as const,
});

// A KPI tile, styled the same everywhere: bold title, large value, optional sparkline along `sparklineX`.
const kpi = (text: string, value: { id: string; aggregation?: 'sum' | 'avg' | 'countd' }, sparklineX?: string) => ({
  type: 'value' as const,
  dataMapping: {
    value: [value],
    ...(sparklineX && { sparklineX: [{ id: sparklineX }] }),
  },
  format: {
    title: { enabled: true, text, typography: typography(14, 'bold') },
    caption: { enabled: true, text: '', typography: typography(0) },
    style: { typography: typography(22, 'normal', MONO) },
  },
});

// --- Pages ------------------------------------------------------------------------

const decisions: PageState = {
  id: 'decisions',
  widgets: {
    'kpi-proposals': kpi('Proposals', sum('purchases.proposals'), 'calendar::day'),
    'kpi-allowed': kpi('Allowed', sum('purchases.allowed')),
    'kpi-asked': kpi('Needed approval', sum('purchases.asked')),
    'kpi-blocked': kpi('Blocked', sum('purchases.blocked')),
    verdict: {
      type: 'button-filter',
      // Allowed, Needs approval and Blocked, as the ledger's badges say them, rather than the codes.
      dataMapping: { value: [{ id: 'purchases.verdictWords' }] },
      format: {
        ...title('Verdict'),
        style: { selection: { type: 'multiple' }, dimensions: { height: 28, minWidth: 56 } },
      },
    },
    ledger: {
      type: 'behest-ledger',
      dataMapping: {
        columns: [
          { id: 'purchases.createdAt' },
          { id: 'sellers.name' },
          { id: 'purchases.request' },
          { id: 'purchases.total' },
          { id: 'purchases.status' },
        ],
      },
      format: title('Decision ledger'),
    },
    // Follows the ledger: clicking a paid purchase there shows and verifies its receipt here.
    receipt: { type: 'behest-receipt', dataMapping: {}, format: title('Receipt for the selected purchase') },
    'rule-outcomes': {
      type: 'bar-chart-stacked',
      dataMapping: {
        categoryKey: [{ id: 'gateOutcomes.rule' }],
        valueKey: [countd('gateOutcomes.id')],
        legendKey: [{ id: 'gateOutcomes.result' }],
      },
      format: { ...title('Rules that asked or blocked'), ...withLegend },
    },
    'intent-check': {
      type: 'donut-chart',
      dataMapping: { categoryKey: [{ id: 'purchases.intent' }], valueKey: [sum('purchases.proposals')] },
      format: {
        ...title('Intent check results'),
        style: { custom: { pieDataLabel: { enabled: true }, totalLabel: { enabled: true } } },
      },
    },
  },
  widgetLayout: {
    'kpi-proposals': at(0, 0, 6, 7),
    'kpi-allowed': at(6, 0, 6, 7),
    'kpi-asked': at(12, 0, 6, 7),
    'kpi-blocked': at(18, 0, 6, 7),
    // A row of its own, so "Needs approval" has room beside the other two verdicts.
    verdict: at(0, 7, 24, 7),
    ledger: at(0, 14, 24, 30),
    receipt: at(0, 44, 9, 36),
    'rule-outcomes': at(9, 44, 15, 18),
    'intent-check': at(9, 62, 15, 18),
  },
  filter: {
    // Passing and skipped rules would drown out the few that decided anything.
    widget: {
      'rule-outcomes': [{ field: { id: 'gateOutcomes.result' }, model: { operator: 'isIn', value: ['Ask', 'Block'] } }],
    },
  },
};

const budget: PageState = {
  id: 'budget',
  widgets: {
    'kpi-budget': kpi('Budget this period', sum('budgets.budget')),
    'kpi-spent': kpi('Spent', sum('budgets.spent')),
    'kpi-in-flight': kpi('Reserved in flight', sum('budgets.inFlight')),
    'kpi-left': kpi('Budget left', sum('budgets.remaining')),
    'burn-down': { type: 'behest-burn-down', dataMapping: {}, format: title('Budget burn-down') },
    'kpi-used': kpi('Budget used', { id: 'budgetUsed' }),
    limits: {
      type: 'grid',
      dataMapping: {
        cols: [{ id: 'mandates.confirmedAt' }, { id: 'mandates.perPurchaseMax' }, { id: 'mandates.askAbove' }],
      },
      format: title('Mandate limits'),
    },
    counted: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'budgetSteps.at' },
          { id: 'purchases.request' },
          { id: 'budgetSteps.effect' },
          // One row per counted purchase, so amounts are shown as they are.
          { id: 'budgetSteps.amount' },
          { id: 'budgetSteps.remaining' },
        ],
      },
      sort: [{ field: { id: 'budgetSteps.at' }, direction: 'desc' }],
      format: title('Counted against the budget this period'),
    },
    'by-category': {
      type: 'donut-chart',
      dataMapping: { categoryKey: [{ id: 'cartItems.category' }], valueKey: [sum('cartItems.lineTotal')] },
      format: {
        ...title('Spend by category, all time'),
        style: { custom: { pieDataLabel: { enabled: true }, totalLabel: { enabled: true } } },
      },
    },
  },
  widgetLayout: {
    'kpi-budget': at(0, 0, 6, 7),
    'kpi-spent': at(6, 0, 6, 7),
    'kpi-in-flight': at(12, 0, 6, 7),
    'kpi-left': at(18, 0, 6, 7),
    'burn-down': at(0, 7, 16, 24),
    'kpi-used': at(16, 7, 8, 7),
    limits: at(16, 14, 8, 17),
    counted: at(0, 31, 15, 20),
    'by-category': at(15, 31, 9, 20),
  },
  filter: {
    // Only what counts against a budget: captured or reserved, not blocked or refunded.
    widget: {
      'by-category': [{ field: { id: 'purchases.budgetEffect' }, model: { operator: 'isIn', value: ['Spent', 'In flight'] } }],
      limits: [{ field: { id: 'mandates.status' }, model: { operator: 'isIn', value: ['Active'] } }],
    },
  },
};

const receipts: PageState = {
  id: 'receipts',
  widgets: {
    'kpi-receipts': kpi('Receipts issued', countd('receipts.id')),
    'kpi-paid-out': kpi('Paid out to sellers', sum('payouts.amount')),
    'kpi-pending': kpi('Payouts pending', sum('payouts.pending')),
    receipt: { type: 'behest-receipt', dataMapping: {}, format: title('Receipt') },
    'receipt-list': {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'receipts.issuedAt' },
          { id: 'receipts.id' },
          { id: 'receipts.sellerSlug' },
          { id: 'purchases.verdict' },
          { id: 'purchases.approver' },
          // One receipt per purchase, so the purchase total is shown as is, not summed.
          { id: 'purchases.total' },
          { id: 'receipts.keyId' },
        ],
      },
      sort: [{ field: { id: 'receipts.issuedAt' }, direction: 'desc' }],
      format: title('Receipts'),
    },
    payouts: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'payouts.createdAt' },
          sum('payouts.amount'),
          { id: 'payouts.status' },
          { id: 'purchases.request' },
          { id: 'payouts.paypalBatchId' },
        ],
      },
      sort: [{ field: { id: 'payouts.createdAt' }, direction: 'desc' }],
      format: title('PayPal payouts'),
    },
  },
  widgetLayout: {
    'kpi-receipts': at(0, 0, 8, 7),
    'kpi-paid-out': at(8, 0, 8, 7),
    'kpi-pending': at(16, 0, 8, 7),
    receipt: at(0, 7, 9, 36),
    'receipt-list': at(9, 7, 15, 18),
    payouts: at(9, 25, 15, 18),
  },
};

// Statuses in which the buyer's money has been captured.
const PAID = ['Captured', 'Accepted', 'Settled', 'Disputed', 'Resolved'];

const sellerOrders: PageState = {
  id: 'orders',
  widgets: {
    'kpi-orders': kpi('Agent orders', sum('purchases.proposals'), 'calendar::day'),
    'kpi-allowed': kpi('Allowed', sum('purchases.allowed')),
    'kpi-asked': kpi('Needed approval', sum('purchases.asked')),
    'kpi-blocked': kpi('Blocked', sum('purchases.blocked')),
    verdict: {
      type: 'button-filter',
      // Allowed, Needs approval and Blocked, as the ledger's badges say them, rather than the codes.
      dataMapping: { value: [{ id: 'purchases.verdictWords' }] },
      format: {
        ...title('Verdict'),
        style: { selection: { type: 'multiple' }, dimensions: { height: 28, minWidth: 56 } },
      },
    },
    ledger: {
      type: 'behest-ledger',
      dataMapping: {
        columns: [
          { id: 'purchases.createdAt' },
          { id: 'purchases.itemCount' },
          { id: 'purchases.total' },
          { id: 'purchases.status' },
          { id: 'purchases.captureId' },
        ],
      },
      format: title('Orders from buyer agents'),
    },
    // Follows the ledger: clicking a paid order there shows and verifies its receipt here.
    receipt: { type: 'behest-receipt', dataMapping: {}, format: title('Receipt for the selected order') },
    items: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'purchases.createdAt' },
          { id: 'cartItems.sku' },
          { id: 'cartItems.title' },
          { id: 'cartItems.quantity' },
          { id: 'cartItems.lineTotal' },
          { id: 'purchases.status' },
        ],
      },
      sort: [{ field: { id: 'purchases.createdAt' }, direction: 'desc' }],
      format: title('Items ordered'),
    },
    'sales-by-item': {
      type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'cartItems.title' }], valueKey: [sum('cartItems.lineTotal')] },
      format: title('Paid sales by item'),
    },
  },
  widgetLayout: {
    'kpi-orders': at(0, 0, 6, 7),
    'kpi-allowed': at(6, 0, 6, 7),
    'kpi-asked': at(12, 0, 6, 7),
    'kpi-blocked': at(18, 0, 6, 7),
    // A row of its own, so "Needs approval" has room beside the other two verdicts.
    verdict: at(0, 7, 24, 7),
    ledger: at(0, 14, 24, 26),
    receipt: at(0, 40, 9, 36),
    items: at(9, 40, 15, 18),
    'sales-by-item': at(9, 58, 15, 18),
  },
  filter: {
    widget: {
      'sales-by-item': [{ field: { id: 'purchases.status' }, model: { operator: 'isIn', value: PAID } }],
    },
  },
};

const sellerReceipts: PageState = {
  id: 'receipts',
  widgets: {
    'kpi-receipts': kpi('Receipts received', countd('receipts.id')),
    'kpi-paid-out': kpi('Paid out to you', sum('payouts.amount')),
    'kpi-pending': kpi('Payouts pending', sum('payouts.pending')),
    receipt: { type: 'behest-receipt', dataMapping: {}, format: title('Receipt') },
    'receipt-list': {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'receipts.issuedAt' },
          { id: 'receipts.id' },
          { id: 'purchases.verdict' },
          // One receipt per purchase, so the purchase total is shown as is, not summed.
          { id: 'purchases.total' },
          { id: 'receipts.keyId' },
        ],
      },
      sort: [{ field: { id: 'receipts.issuedAt' }, direction: 'desc' }],
      format: title('Receipts'),
    },
    payouts: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'payouts.createdAt' },
          sum('payouts.amount'),
          { id: 'payouts.status' },
          { id: 'payouts.paypalBatchId' },
        ],
      },
      sort: [{ field: { id: 'payouts.createdAt' }, direction: 'desc' }],
      format: title('PayPal payouts'),
    },
  },
  widgetLayout: {
    'kpi-receipts': at(0, 0, 8, 7),
    'kpi-paid-out': at(8, 0, 8, 7),
    'kpi-pending': at(16, 0, 8, 7),
    receipt: at(0, 7, 9, 36),
    'receipt-list': at(9, 7, 15, 18),
    payouts: at(9, 25, 15, 18),
  },
};

const catalogue: PageState = {
  id: 'catalogue',
  widgets: {
    'kpi-listings': kpi('Listings', countd('products.id')),
    'kpi-flagged': kpi('Flagged by screening', sum('products.flagged')),
    'kpi-sellers': kpi('Sellers', countd('sellers.id')),
    'price-to-market': {
      type: 'bar-chart-grouped',
      dataMapping: {
        categoryKey: [{ id: 'products.title' }],
        valueKey: [sum('products.price'), sum('products.marketMedian')],
      },
      format: { ...title('Price against the market median'), ...withLegend },
    },
    listings: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'sellers.name' },
          { id: 'products.sku' },
          { id: 'products.title' },
          { id: 'products.category' },
          sum('products.price'),
          sum('products.marketMedian'),
          avg('products.priceToMarket'),
          sum('products.stock'),
          { id: 'products.flags' },
        ],
      },
      format: title('Listings'),
    },
  },
  widgetLayout: {
    'kpi-listings': at(0, 0, 8, 7),
    'kpi-flagged': at(8, 0, 8, 7),
    'kpi-sellers': at(16, 0, 8, 7),
    'price-to-market': at(0, 7, 24, 18),
    listings: at(0, 25, 24, 20),
  },
};

const reconciliation: PageState = {
  id: 'reconciliation',
  widgets: {
    'kpi-transactions': kpi('Transactions (31 days)', countd('transactions.id')),
    'kpi-captures': kpi('Matched captures', sum('transactions.captures')),
    'kpi-unmatched': kpi('Not matched', sum('transactions.unmatched')),
    'kpi-fees': kpi('PayPal fees', sum('transactions.fee')),
    'by-match': {
      type: 'donut-chart',
      dataMapping: { categoryKey: [{ id: 'transactions.match' }], valueKey: [countd('transactions.id')] },
      format: {
        ...title('Transactions by reconciliation'),
        style: { custom: { pieDataLabel: { enabled: true }, totalLabel: { enabled: true } } },
      },
    },
    'daily-flow': {
      type: 'column-chart-stacked',
      dataMapping: {
        categoryKey: [{ id: 'calendar::day' }],
        valueKey: [sum('transactions.amount')],
        legendKey: [{ id: 'transactions.match' }],
      },
      format: { ...title('Money through the account by day'), ...withLegend },
    },
    ledger: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'transactions.date' },
          { id: 'transactions.eventType' },
          { id: 'transactions.match' },
          { id: 'purchases.request' },
          { id: 'purchases.verdict' },
          sum('transactions.amount'),
          sum('transactions.fee'),
          sum('transactions.net'),
          { id: 'transactions.status' },
          { id: 'transactions.counterparty' },
        ],
      },
      sort: [{ field: { id: 'transactions.date' }, direction: 'desc' }],
      format: title('PayPal transactions'),
    },
  },
  widgetLayout: {
    'kpi-transactions': at(0, 0, 6, 7),
    'kpi-captures': at(6, 0, 6, 7),
    'kpi-unmatched': at(12, 0, 6, 7),
    'kpi-fees': at(18, 0, 6, 7),
    'by-match': at(0, 7, 9, 18),
    'daily-flow': at(9, 7, 15, 18),
    ledger: at(0, 25, 24, 24),
  },
};

// --- Reports ----------------------------------------------------------------------

export type BuiltInReport = { name: string; pageTitles: Record<string, string>; state: ReportState };

const report = (name: string, pages: [PageState, string][]): BuiltInReport => ({
  name,
  pageTitles: Object.fromEntries(pages.map(([page, pageTitle]) => [page.id, pageTitle])),
  // Each report opens on its first page.
  state: { selectedPageId: pages[0][0].id, pages: pages.map(([page]) => page) },
});

export const BUILT_IN_REPORTS: Record<Persona, BuiltInReport> = {
  buyer: report('My agent', [
    [decisions, 'Decisions'],
    [budget, 'Budget'],
    [receipts, 'Receipts'],
    [catalogue, 'Catalogue'],
  ]),
  seller: report('My shop', [
    [sellerOrders, 'Agent orders'],
    [sellerReceipts, 'Receipts and payouts'],
    [catalogue, 'Catalogue'],
  ]),
  operator: report('Operations', [
    [decisions, 'Decisions'],
    [budget, 'Budgets'],
    [receipts, 'Receipts and payouts'],
    [catalogue, 'Catalogue'],
    [reconciliation, 'Reconciliation'],
  ]),
};
