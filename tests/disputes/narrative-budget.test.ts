import { describe, expect, it } from 'vitest';
import { DISPUTE_SYSTEM_PROMPT, NARRATIVE_CHAR_BUDGET } from '@/lib/disputes/narrative';
import { MAX_NOTES_CHARS } from '@/lib/disputes/submit';

describe('the narrative length', () => {
  it('tells the model the budget, in the words it reads', () => {
    expect(DISPUTE_SYSTEM_PROMPT).toContain(`under ${NARRATIVE_CHAR_BUDGET.toLocaleString('en-US')} characters`);
    expect(DISPUTE_SYSTEM_PROMPT).toContain('at most six claims');
  });

  it("leaves room in PayPal's limit for the heading, six cited claims and the receipt lines", () => {
    // About 50 for the heading, 45 for each claim's number and citations, 150 for the receipt lines.
    const around = 50 + 6 * 45 + 150;
    expect(NARRATIVE_CHAR_BUDGET + around).toBeLessThanOrEqual(MAX_NOTES_CHARS);
  });
});
