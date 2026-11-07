import { describe, expect, it } from 'vitest';
import { proseBlocks, proseInline } from '@/lib/ui/prose';

describe('proseBlocks', () => {
  it('reads the shopping summary as paragraphs and a bullet list with bold labels', () => {
    const summary = [
      'Your turmeric and cumin are bought and paid. Behest accepted the purchase.',
      '',
      "I placed one order with Ravi's Spice Co. for $8.25 in total:",
      '- **Turmeric:** one 100g jar of Lakadong Turmeric Powder for $4.50.',
      '- **Cumin:** one 100g jar of Whole Cumin Seeds for $3.75.',
      '',
      'The only cumin this seller listed is whole seeds, not ground.',
    ].join('\n');

    expect(proseBlocks(summary)).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: 'Your turmeric and cumin are bought and paid. Behest accepted the purchase.' }]] },
      {
        kind: 'paragraph',
        lines: [[{ kind: 'text', text: "I placed one order with Ravi's Spice Co. for $8.25 in total:" }]],
      },
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            { kind: 'strong', text: 'Turmeric:' },
            { kind: 'text', text: ' one 100g jar of Lakadong Turmeric Powder for $4.50.' },
          ],
          [
            { kind: 'strong', text: 'Cumin:' },
            { kind: 'text', text: ' one 100g jar of Whole Cumin Seeds for $3.75.' },
          ],
        ],
      },
      { kind: 'paragraph', lines: [[{ kind: 'text', text: 'The only cumin this seller listed is whole seeds, not ground.' }]] },
    ]);
  });

  it('keeps single line breaks inside a paragraph', () => {
    expect(proseBlocks('First line.\nSecond line.')).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: 'First line.' }], [{ kind: 'text', text: 'Second line.' }]] },
    ]);
  });

  it('reads numbered lists apart from bullet lists', () => {
    const blocks = proseBlocks('1. Search\n2. Propose\n- a note');
    expect(blocks.map((block) => (block.kind === 'list' ? [block.ordered, block.items.length] : block.kind))).toEqual([
      [true, 2],
      [false, 1],
    ]);
  });

  it('continues a list item on the line after it', () => {
    expect(proseBlocks('- one jar\n  of turmeric')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            { kind: 'text', text: 'one jar' },
            { kind: 'text', text: ' ' },
            { kind: 'text', text: 'of turmeric' },
          ],
        ],
      },
    ]);
  });

  it('reads a heading as a bold paragraph', () => {
    expect(proseBlocks('## What I bought')).toEqual([{ kind: 'paragraph', lines: [[{ kind: 'strong', text: 'What I bought' }]] }]);
  });

  it('gives back no blocks for empty text', () => {
    expect(proseBlocks('  \n\n')).toEqual([]);
  });
});

describe('proseInline', () => {
  it('reads bold, emphasis and code', () => {
    expect(proseInline('**Paid** for *one* `TUR-100`')).toEqual([
      { kind: 'strong', text: 'Paid' },
      { kind: 'text', text: ' for ' },
      { kind: 'em', text: 'one' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'TUR-100' },
    ]);
  });

  it('leaves asterisks that open or close on a space as text', () => {
    expect(proseInline('5 * 3 = 15 and ** not bold **')).toEqual([{ kind: 'text', text: '5 * 3 = 15 and ** not bold **' }]);
  });

  it('leaves an unclosed marker as text', () => {
    expect(proseInline('**Turmeric: one jar')).toEqual([{ kind: 'text', text: '**Turmeric: one jar' }]);
  });

  it('never reads markup as anything but text', () => {
    expect(proseInline('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});
