import { describe, expect, it } from 'vitest';
import { buildStudioData } from '@/app/dashboard/studio/data';
import { BUILT_IN_REPORTS } from '@/app/dashboard/studio/initial-report';
import type { DashboardData } from '@/lib/dashboard/scope';
import type { Persona } from '@/lib/session';

// The built-in reports name fields by id; a field the persona's data lacks leaves a widget empty,
// and for the seller would mean the report expects buyer-private data.

const common = {
  asOf: '2026-11-06T12:00:00.000Z',
  purchaseEvents: [],
  receipts: [],
  payouts: [],
  sellers: [],
  products: [],
  transactions: [],
  warnings: [],
};

const dataFor = (persona: Persona): DashboardData =>
  persona === 'seller'
    ? { ...common, persona, purchases: [], mandates: [] }
    : { ...common, persona, purchases: [], mandates: [] };

/** Every field id the report state refers to: in data mappings, sorts and filters. */
function referencedFields(node: unknown, inside = false, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) referencedFields(item, inside, found);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'id' && inside && typeof value === 'string') found.add(value);
      else referencedFields(value, inside || key === 'dataMapping' || key === 'field', found);
    }
  }
  return found;
}

function availableFields(persona: Persona): Set<string> {
  const studio = buildStudioData(dataFor(persona));
  return new Set([
    ...studio.sources.flatMap((source) =>
      'fields' in source && source.fields ? source.fields.map((field) => `${source.id}.${field.id}`) : [],
    ),
    ...(studio.expressions ?? []).map((expression) => expression.id),
  ]);
}

describe('built-in reports', () => {
  it.each(['buyer', 'seller', 'operator'] as const)('only use fields the %s data has', (persona) => {
    const available = availableFields(persona);
    const missing = [...referencedFields(BUILT_IN_REPORTS[persona].state)].filter(
      (id) => !id.startsWith('calendar::') && !available.has(id),
    );
    expect(missing).toEqual([]);
  });

  it("give the seller no field about how the buyer's purchases were decided", () => {
    const available = [...availableFields('seller')];
    const buyerSide = available.filter(
      (id) =>
        /^(gateOutcomes|mandates|budgets|budgetSteps)\./.test(id) ||
        ['purchases.request', 'purchases.intent', 'purchases.gateVerdict', 'purchases.buyerId', 'purchases.mandateId', 'purchases.budgetEffect', 'purchases.rulesFlagged', 'purchases.approver', 'budgetUsed'].includes(id),
    );
    expect(buyerSide).toEqual([]);
    expect(available).toEqual(
      expect.arrayContaining(['purchases.verdict', 'purchases.verdictWords', 'purchases.total', 'purchases.status', 'receipts.jws']),
    );
  });
});
