import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VerdictBadge } from '@/components/ui/verdict-badge';
import { VERDICT_STATE, verdictWords } from '@/lib/ui/verdict';

/** The badge's text as a screen reader reads it: tags dropped, nothing hidden from it. */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');

describe('verdictWords', () => {
  it('words each verdict for the buyer', () => {
    expect(verdictWords('ALLOW')).toBe('Allowed');
    expect(verdictWords('ASK')).toBe('Needs your approval');
    expect(verdictWords('BLOCK')).toBe('Blocked');
  });

  it('leaves the person out where others read it', () => {
    expect(verdictWords('ASK', false)).toBe('Needs approval');
    expect(verdictWords('ALLOW', false)).toBe('Allowed');
  });

  it('gives each verdict the trace state it looks like', () => {
    expect(VERDICT_STATE).toEqual({ ALLOW: 'done', ASK: 'held', BLOCK: 'stopped' });
  });
});

describe('VerdictBadge', () => {
  it('says the verdict in words, never as a code', () => {
    const html = renderToStaticMarkup(createElement(VerdictBadge, { verdict: 'ASK' }));
    expect(text(html)).toBe('Verdict: Needs your approval');
    expect(html).not.toContain('ASK');
  });

  it('draws a different shape for each verdict, hidden from screen readers', () => {
    const shapes = (['ALLOW', 'ASK', 'BLOCK'] as const).map((verdict) => {
      const html = renderToStaticMarkup(createElement(VerdictBadge, { verdict }));
      expect(html).toContain('aria-hidden="true"');
      return html.match(/<svg[\s\S]*?<\/svg>/)?.[0];
    });
    expect(new Set(shapes).size).toBe(3);
  });

  it('adds a count after the words', () => {
    const html = renderToStaticMarkup(createElement(VerdictBadge, { verdict: 'BLOCK', count: 4, personal: false }));
    expect(text(html)).toBe('Verdict: Blocked4');
    expect(html).toContain('tabular-nums');
  });
});
