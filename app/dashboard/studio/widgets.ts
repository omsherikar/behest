// Behest's custom AG Studio widgets (../widgets): the decision ledger, the budget burn-down and
// the receipt card. They join Studio's own widgets in the Compose panel under "Behest", and the
// built-in reports (./initial-report.ts) place them on their pages.

import type {
  AgDefaultWidgetDefinition,
  AgReportState,
  AgWidgetForm,
  AgWidgetFormItemControl,
  AgWidgetFormTabGroup,
  AgWidgetsConfig,
} from 'ag-studio';
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from 'ag-studio-react';
import { BurnDownWidget, type BurnDownDef } from '../widgets/burn-down';
import { LedgerWidget, type LedgerDef } from '../widgets/ledger';
import { ReceiptCardWidget, type ReceiptCardDef } from '../widgets/receipt-card';

export interface BehestRegistry extends AgRegistry {
  widgets: readonly (
    | AgDefaultWidgetDefinition
    | AgWidgetDefinition<'behest-ledger', LedgerDef>
    | AgWidgetDefinition<'behest-burn-down', BurnDownDef>
    | AgWidgetDefinition<'behest-receipt', ReceiptCardDef>
  )[];
}

/** A report's AG Studio state, with Behest's widgets allowed in it. */
export type ReportState = AgReportState<BehestRegistry>;

// Compose panel icons, 24px stroke icons like the shell's (components/ui/icons.tsx).
const icon = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

/** Adds a section of style toggles to the Format tab of a widget's default form. */
function withToggles<TId>(
  form: AgWidgetFormTabGroup<TId>,
  label: string,
  toggles: { id: TId; label: string }[],
): AgWidgetForm<TId> {
  const formatTab = form.items.at(-1);
  formatTab?.items.push({
    type: 'section',
    key: 'behest-style',
    label,
    defaultExpanded: true,
    items: toggles.map((toggle): AgWidgetFormItemControl<TId> => ({ type: 'toggle', ...toggle, defaultValue: true })),
  });
  return form;
}

const ledger: AgWidgetDefinition<'behest-ledger', LedgerDef> = {
  id: 'behest-ledger',
  label: 'Decision ledger',
  icon: icon('<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="2"/>'),
  dataMapping: {
    columns: {
      type: 'fieldset',
      supportedRoles: ['category', 'temporal', 'numeric'],
      aiDescription: 'Purchase details shown as columns beside the verdict and the reasons.',
    },
  },
  form: (params) =>
    withToggles(
      params.createDefaults({ dataMappingItems: [{ key: 'columns', label: 'Columns' }] }),
      'Ledger',
      [
        { id: 'format.style.showVerdictMix', label: 'Verdict counts' },
        { id: 'format.style.showReasons', label: 'Rule reasons' },
      ],
    ),
  defaultState: {
    dataMapping: {
      columns: [{ id: 'purchases.createdAt' }, { id: 'sellers.name' }, { id: 'purchases.request' }, { id: 'purchases.total' }, { id: 'purchases.status' }],
    },
    format: { title: { enabled: true, text: 'Decision ledger' } },
  },
  comp: LedgerWidget,
  featureConfig: { crossFilter: { supportsHighlight: true } },
  defaultSize: { width: 900, height: 480 },
  minSize: { width: 480, height: 240 },
  ai: {
    description:
      'A table of every purchase the agent proposed, newest first: a verdict chip (ALLOW green, ASK amber, BLOCK red), chosen ' +
      'purchase columns, and the gate rules that asked or blocked it, in words. Clicking a row cross-filters the page.',
    usage: 'Use it to answer why a purchase was allowed, needed approval or was blocked.',
  },
};

const burnDown: AgWidgetDefinition<'behest-burn-down', BurnDownDef> = {
  id: 'behest-burn-down',
  label: 'Budget burn-down',
  icon: icon('<path d="M4 4v16h16"/><path d="M7 7h4v4h4v4h4"/>'),
  form: (params) =>
    withToggles(params.createDefaults({ dataMappingItems: [] }), 'Burn-down', [
      { id: 'format.style.showPace', label: 'Even pace line' },
    ]),
  defaultState: { format: { title: { enabled: true, text: 'Budget burn-down' } } },
  comp: BurnDownWidget,
  defaultSize: { width: 640, height: 420 },
  minSize: { width: 360, height: 260 },
  ai: {
    description:
      "The active mandate's budget for the current UTC period: what is left, money reserved by purchases still in flight, " +
      'and money already spent, stepping down over time against an even-pace line.',
    usage: 'Use it for questions about how much budget is left or how fast it is being used.',
  },
};

const receiptCard: AgWidgetDefinition<'behest-receipt', ReceiptCardDef> = {
  id: 'behest-receipt',
  label: 'Receipt card',
  icon: icon('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="m9 11 2 2 4-4"/>'),
  form: (params) =>
    withToggles(params.createDefaults({ dataMappingItems: [] }), 'Receipt', [
      { id: 'format.style.showSignedClaims', label: 'Signed claims' },
    ]),
  defaultState: { format: { title: { enabled: true, text: 'Receipt' } } },
  comp: ReceiptCardWidget,
  defaultSize: { width: 420, height: 560 },
  minSize: { width: 320, height: 360 },
  ai: {
    description:
      "One signed purchase receipt at a time, newest first, with each of its claims (signature, seller, cart, amount, decision, " +
      "mandate, payment) and a pass mark once Behest's verifier accepts it against the purchase's cart.",
    usage: 'Use it to show the proof behind a paid purchase. It follows cross-filters, so it shows the selected purchase.',
  },
};

/** Studio's widgets plus Behest's, which get their own group in the Compose panel. */
export const behestWidgets = (defaults: AgWidgetsConfig): AgWidgetsConfig<BehestRegistry> =>
  createWidgets<BehestRegistry>({
    additionalTypes: [ledger, burnDown, receiptCard],
    menu: [{ label: 'Behest', widgetIds: ['behest-ledger', 'behest-burn-down', 'behest-receipt'] }, ...defaults.menu],
  });
