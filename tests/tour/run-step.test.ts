import { describe, expect, it } from 'vitest';
import { runStep, type StepActions } from '@/components/tour/run-step';
import type { TourTarget } from '@/lib/tour/state';
import { TOUR_STEPS, type TourStep } from '@/lib/tour/steps';

// One step of the guided demo with the browser replaced by a recording: what it switches, where it
// goes, what it scrolls, and what it returns to ring.

const step = (id: string): TourStep => {
  const found = TOUR_STEPS.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

function browser(start: string, present: { anchors?: string[]; rows?: string[] } = {}) {
  const calls: string[] = [];
  let at = start;
  const element = (name: string) => ({ name }) as unknown as Element;
  const actions: StepActions = {
    here: () => at,
    switchRole: async (role) => {
      calls.push(`role ${role}`);
    },
    push: (path) => {
      calls.push(`push ${path}`);
      at = path;
    },
    refresh: () => calls.push('refresh'),
    waitFor: async (probe) => probe() || null,
    findRow: (id) => (present.rows?.includes(id) ? element(`row ${id}`) : null),
    findAnchor: (anchor) => (present.anchors?.includes(anchor) ? element(`anchor ${anchor}`) : null),
    revealRow: (row) => calls.push(`reveal ${(row as unknown as { name: string }).name}`),
    revealAnchor: (anchor) => calls.push(`reveal ${(anchor as unknown as { name: string }).name}`),
  };
  return { actions, calls };
}

const target = (path: string, anchor: string | null, rowId: string | null = null): TourTarget => ({ path, anchor, rowId, missing: false });

describe('runStep', () => {
  it('switches the role on every step that has one, before going to its page', async () => {
    const { actions, calls } = browser('/buyer');
    await runStep(step('signature'), target('/buyer/ledger', 'ledger-grid'), actions, () => false);
    await runStep(step('ledger'), target('/buyer/ledger', 'ledger-grid'), actions, () => false);
    expect(calls.filter((call) => call.startsWith('role'))).toEqual(['role buyer', 'role buyer']);
    expect(calls.indexOf('role buyer')).toBeLessThan(calls.indexOf('push /buyer/ledger'));
  });

  it('reloads the page it is already on after switching the role, so the page shows that role', async () => {
    const { actions, calls } = browser('/buyer');
    await runStep(step('mandate'), target('/buyer', 'mandate-readback'), actions, () => false);
    expect(calls).toContain('refresh');
    expect(calls.some((call) => call.startsWith('push'))).toBe(false);
  });

  it('switches no role on a public page', async () => {
    const { actions, calls } = browser('/buyer', { anchors: ['security-figures'] });
    await runStep(step('security'), target('/security', 'security-figures'), actions, () => false);
    expect(calls.some((call) => call.startsWith('role'))).toBe(false);
  });

  it('returns the anchor, revealed, once the page is there', async () => {
    const { actions, calls } = browser('/', { anchors: ['hero'] });
    expect(await runStep(step('welcome'), target('/', 'hero'), actions, () => false)).toEqual({ name: 'anchor hero' });
    expect(calls).toEqual(['reveal anchor hero']);
  });

  it('reveals the pinned row rather than the whole grid when the row is there', async () => {
    const { actions, calls } = browser('/buyer/ledger', { anchors: ['ledger-grid'], rows: ['p1'] });
    await runStep(step('ledger'), target('/buyer/ledger', 'ledger-grid', 'p1'), actions, () => false);
    expect(calls).toContain('reveal row p1');
    expect(calls).not.toContain('reveal anchor ledger-grid');
  });

  it('reveals the grid itself when the pinned row cannot be found', async () => {
    const { actions, calls } = browser('/buyer/ledger', { anchors: ['ledger-grid'] });
    await runStep(step('ledger'), target('/buyer/ledger', 'ledger-grid', 'p1'), actions, () => false);
    expect(calls).toContain('reveal anchor ledger-grid');
  });

  it('rings nothing for a step with nothing to point at', async () => {
    const { actions } = browser('/security');
    expect(await runStep(step('security'), target('/security', null), actions, () => false)).toBeNull();
  });

  it('stops as soon as the judge has moved on', async () => {
    const { actions, calls } = browser('/', { anchors: ['ledger-grid'] });
    expect(await runStep(step('ledger'), target('/buyer/ledger', 'ledger-grid'), actions, () => true)).toBeNull();
    expect(calls.some((call) => call.startsWith('push') || call.startsWith('reveal'))).toBe(false);
  });
});
