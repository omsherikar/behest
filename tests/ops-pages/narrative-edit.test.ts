import { describe, expect, it } from 'vitest';
import { narrativeProblem, submittableNarrative, toggleCitation } from '@/lib/ops-pages/narrative-edit';

const PACK = ['mandate', 'readback', 'receipt', 'cart', 'purchase_log'];

describe('toggleCitation', () => {
  it('adds an item the claim does not cite yet, in the order the pack lists its items', () => {
    expect(toggleCitation(['receipt'], 'mandate', PACK)).toEqual(['mandate', 'receipt']);
    expect(toggleCitation(['mandate'], 'purchase_log', PACK)).toEqual(['mandate', 'purchase_log']);
    expect(toggleCitation([], 'cart', PACK)).toEqual(['cart']);
  });

  it('removes an item the claim already cites', () => {
    expect(toggleCitation(['mandate', 'receipt'], 'mandate', PACK)).toEqual(['receipt']);
    expect(toggleCitation(['cart'], 'cart', PACK)).toEqual([]);
  });

  it('never adds an item the pack does not hold', () => {
    expect(toggleCitation(['mandate'], 'tracking', PACK)).toEqual(['mandate']);
    expect(toggleCitation([], 'approval', PACK)).toEqual([]);
  });

  it('drops a citation of an item the pack no longer holds, and any repeat', () => {
    expect(toggleCitation(['tracking', 'mandate', 'mandate'], 'cart', PACK)).toEqual(['mandate', 'cart']);
  });

  it('leaves the list it was given as it was', () => {
    const cited = ['receipt'];
    toggleCitation(cited, 'mandate', PACK);
    expect(cited).toEqual(['receipt']);
  });
});

describe('narrativeProblem', () => {
  const claim = (text: string, evidenceIds: string[]) => ({ text, evidenceIds });
  const ready = {
    summary: 'The buyer authorized this purchase.',
    claims: [claim('The buyer signed a mandate.', ['mandate']), claim('Behest signed a receipt.', ['receipt', 'cart'])],
  };

  it('finds nothing wrong with a summary and claims that each cite an item of the pack', () => {
    expect(narrativeProblem(ready, PACK)).toBeNull();
  });

  it('asks for a summary', () => {
    expect(narrativeProblem({ ...ready, summary: ' \n ' }, PACK)).toBe('Write a summary before you submit.');
  });

  it('asks for at least one claim', () => {
    expect(narrativeProblem({ ...ready, claims: [] }, PACK)).toBe('Add at least one claim before you submit.');
  });

  it('names the way the answer goes when it is a message to the buyer', () => {
    expect(narrativeProblem({ ...ready, summary: '' }, PACK, 'send')).toBe('Write a summary before you send.');
    expect(narrativeProblem({ ...ready, claims: [] }, PACK, 'send')).toBe('Add at least one claim before you send.');
  });

  it('names a claim with no text by its number', () => {
    const claims = [...ready.claims, claim('  ', ['cart'])];
    expect(narrativeProblem({ ...ready, claims }, PACK)).toBe('Claim 3 has no text. Write it or remove the claim.');
  });

  it('names a claim that cites no item of the pack, since PayPal would never get it', () => {
    for (const evidenceIds of [[], ['tracking']]) {
      const claims = [ready.claims[0], claim('The seller shipped it.', evidenceIds)];
      expect(narrativeProblem({ ...ready, claims }, PACK)).toBe(
        'Claim 2 cites no evidence item. Choose at least one, or remove the claim.',
      );
    }
  });
});

describe('submittableNarrative', () => {
  it('sends trimmed text and only the citations of items the pack holds, in pack order', () => {
    expect(
      submittableNarrative(
        {
          summary: '  The buyer authorized this purchase. \n',
          claims: [{ text: ' Behest signed a receipt. ', evidenceIds: ['receipt', 'tracking', 'mandate'] }],
        },
        PACK,
      ),
    ).toEqual({
      summary: 'The buyer authorized this purchase.',
      claims: [{ text: 'Behest signed a receipt.', evidenceIds: ['mandate', 'receipt'] }],
    });
  });

  it('keeps no field but the summary and the claims', () => {
    const edited = { summary: 'S', claims: [{ text: 'T', evidenceIds: ['cart'], key: 4 }], key: 1 };
    expect(submittableNarrative(edited, PACK)).toEqual({ summary: 'S', claims: [{ text: 'T', evidenceIds: ['cart'] }] });
  });
});
