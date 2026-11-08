import { describe, expect, it } from 'vitest';
import { PERSONAS } from '@/lib/session';
import { PIN_KEYS } from '@/lib/tour/pins';
import { NOT_LOADED, ROLE_LABEL, TOUR_END, TOUR_STEPS } from '@/lib/tour/steps';

// The guided demo's steps are data. These checks keep the copy to the house rules and keep each
// step's target consistent with the records it needs.

const ALL = [...TOUR_STEPS, TOUR_END];
const sentences = (text: string) => text.split(/(?<=\.)\s+/).filter(Boolean);

describe('the steps', () => {
  it('are fourteen, in the order the demo video tells them', () => {
    expect(TOUR_STEPS.map((step) => step.id)).toEqual([
      'welcome',
      'mandate',
      'signature',
      'ledger',
      'held',
      'blocked',
      'hidden',
      'orders',
      'receipt',
      'dispute',
      'answer',
      'evidence',
      'dashboard',
      'security',
    ]);
  });

  it('have unique kebab-case ids', () => {
    const ids = ALL.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z-]*$/);
  });

  it('each ring an anchor, and the end card none', () => {
    for (const step of TOUR_STEPS) expect(step.anchor).toMatch(/^[a-z][a-z-]*$/);
    expect(TOUR_END.anchor).toBeNull();
  });

  it('switch only to the demo roles', () => {
    for (const step of ALL) if (step.role !== null) expect(PERSONAS).toContain(step.role);
  });

  it('open pages on this site', () => {
    for (const step of ALL) expect(step.path).toMatch(/^\//);
  });

  it('need the dispute pin wherever the path names the dispute', () => {
    for (const step of ALL) if (step.path.includes('{dispute}')) expect(step.needs).toBe('dispute');
  });

  it('need every record they scroll to or open', () => {
    for (const step of ALL) {
      for (const pin of [step.row, step.open]) {
        if (pin === undefined) continue;
        expect(PIN_KEYS).toContain(pin);
        expect(step.needs).toBe(pin);
      }
    }
  });
});

describe('the copy', () => {
  it('keeps every body to three sentences at most', () => {
    for (const step of ALL) {
      expect(sentences(step.body).length, step.id).toBeGreaterThan(0);
      expect(sentences(step.body).length, step.id).toBeLessThanOrEqual(3);
    }
  });

  it('uses no em or en dash', () => {
    for (const text of [...ALL.flatMap((step) => [step.title, step.body]), NOT_LOADED]) expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it('never tells the reader how to judge the project', () => {
    for (const step of ALL) expect(`${step.title} ${step.body}`).not.toMatch(/\b(judge|judges|rate|score|best)\b/i);
  });

  it('mentions the linked wallet on the step whose panel shows it', () => {
    const body = (id: string) => ALL.find((step) => step.id === id)?.body ?? '';
    expect(body('mandate')).toContain('wallet');
    expect(body('signature')).not.toContain('wallet');
  });

  it('names each role the way the top bar does', () => {
    expect(ROLE_LABEL).toEqual({ buyer: 'Buyer', seller: 'Seller', operator: 'Operator' });
  });

  it('ends by handing over to the judge, pointing at the sandbox login in the Devpost submission', () => {
    expect(TOUR_END.title).toBe('Try it yourself');
    expect(TOUR_END.body).toContain("Devpost submission's testing instructions");
  });
});
