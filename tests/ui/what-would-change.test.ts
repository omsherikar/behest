import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WhatWouldChange } from '@/components/ui/what-would-change';

// The panel names the mandate a purchase was decided under, since the explanation is worked out
// against that mandate even after the buyer has signed another one.

const render = (change: Parameters<typeof WhatWouldChange>[0]['change']) =>
  renderToStaticMarkup(createElement(WhatWouldChange, { change, reasons: [] })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('WhatWouldChange', () => {
  it('names the mandate the purchase was decided under before one change', () => {
    const html = render({ kind: 'changes', approve: false, together: false, changes: [{ text: 'Raise the limit to $50.00.', outcome: 'ALLOW' }] });
    expect(html).toContain('This change to the mandate it was decided under would have let it through:');
  });

  it('says so for several changes, together or alone', () => {
    const changes = [
      { text: 'A.', outcome: 'ALLOW' as const },
      { text: 'B.', outcome: 'ALLOW' as const },
    ];
    expect(render({ kind: 'changes', approve: false, together: true, changes })).toContain('These changes to the mandate it was decided under together would have let it through:');
    expect(render({ kind: 'changes', approve: false, together: false, changes })).toContain('One of these changes to the mandate it was decided under would have let it through:');
  });

  it('says when no change to that mandate could allow it', () => {
    expect(render({ kind: 'cannot', reason: 'This mandate was revoked.' })).toContain(
      'This one cannot be allowed by changing the mandate it was decided under.',
    );
    expect(render({ kind: 'changes', approve: false, together: false, changes: [] })).toContain('No change to that mandate alone would allow it.');
  });
});
