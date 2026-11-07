import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Money } from '@/components/ui/money';
import { consoleTime, shortId } from '@/lib/ui/format';

describe('shortId', () => {
  it('keeps the start and the end of a long id', () => {
    expect(shortId('0f8e6a1c-52d4-4f27-9a3b-7c1de0b4e21b')).toBe('0f8e6a1c...e21b');
  });

  it('returns an id that is already short as it is', () => {
    expect(shortId('rct_7f3a')).toBe('rct_7f3a');
    expect(shortId('abcdefghijklmno')).toBe('abcdefghijklmno');
  });

  it('takes other lengths, or the start alone', () => {
    expect(shortId('a3f1c9e0d2b47788aa', 4, 4)).toBe('a3f1...88aa');
    expect(shortId('a3f1c9e0d2b47788aa', 6, 0)).toBe('a3f1c9...');
  });
});

describe('consoleTime', () => {
  it('writes the UTC clock time to the second', () => {
    expect(consoleTime(new Date('2026-11-07T14:02:07.912Z'))).toBe('14:02:07');
    expect(consoleTime('2026-11-07T09:05:00+05:30')).toBe('03:35:00');
  });

  it('is null for a date that does not parse', () => {
    expect(consoleTime('not a date')).toBeNull();
  });
});

describe('Money', () => {
  const render = (props: Parameters<typeof Money>[0]) => renderToStaticMarkup(createElement(Money, props));

  it('formats cents as dollars in tabular figures', () => {
    const html = render({ cents: 1875 });
    expect(html).toContain('$18.75');
    expect(html).toContain('tabular-nums');
  });

  it('formats thousands and whole dollars', () => {
    expect(render({ cents: 123456 })).toContain('$1,234.56');
    expect(render({ cents: 2500 })).toContain('$25.00');
  });

  it('says so when there is no amount', () => {
    expect(render({ cents: null })).toContain('Not priced');
    expect(render({ cents: null, missing: 'Amount unknown' })).toContain('Amount unknown');
  });

  it('sets amounts in tables in mono', () => {
    expect(render({ cents: 450, mono: true })).toContain('font-mono');
    expect(render({ cents: 450 })).not.toContain('font-mono');
  });
});
