import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthorityTrace } from '@/components/ui/authority-trace';
import { Console } from '@/components/ui/console';
import { JwsView } from '@/components/ui/jws-view';
import { Notice } from '@/components/ui/notice';
import { ProofId } from '@/components/ui/proof-id';
import { trailFromPurchase } from '@/lib/ui/trail';

// The shared components as the server renders them: what a screen reader gets, and which parts are
// interactive. Behaviour in the browser (opening a node, copying) is checked by hand.

/** The text a screen reader reads: tags and hidden decoration dropped. */
const text = (html: string) =>
  html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<span aria-hidden="true">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();

const held = trailFromPurchase('awaiting_approval', 'ASK', 'ASK', false);

describe('AuthorityTrace', () => {
  const render = (props: Parameters<typeof AuthorityTrace>[0]) => renderToStaticMarkup(createElement(AuthorityTrace, props));

  it('numbers the five steps and says each state in words', () => {
    const html = render({ states: held, label: 'Authority trace of this purchase' });
    expect(html).toContain('aria-label="Authority trace of this purchase"');
    expect(text(html)).toBe('1 Mandate Done 2 Gate Held 3 Intent check Done 4 PayPal Held 5 Receipt Not reached');
  });

  it('makes only the steps with proof into disclosure buttons, all closed at first', () => {
    const html = render({ states: held, proof: { gate: 'Price over your $25 limit', receipt: 'Not signed yet' } });
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(([tag]) => tag);
    expect(buttons).toHaveLength(2);
    for (const tag of buttons) {
      expect(tag).toContain('aria-expanded="false"');
      expect(tag).toMatch(/aria-controls="[^"]+-proof"/);
    }
    // Closed proof is in the page but hidden until its node is opened.
    expect(html).toMatch(/<div[^>]*role="region"[^>]*hidden=""[^>]*>[\s\S]*Price over your \$25 limit/);
  });

  it('opens the step named by defaultOpen', () => {
    const html = render({ states: held, proof: { gate: 'Price over your $25 limit' }, defaultOpen: 'gate' });
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/role="region"[^>]*hidden/);
  });

  it('plays only for visitors who allow motion', () => {
    const still = render({ states: held });
    expect(still).not.toContain('animate-trace-play');
    expect(still).not.toContain('animation-delay');
    const playing = render({ states: held, play: true });
    const animated = [...playing.matchAll(/class="([^"]*animate-trace-(?:play|rail)[^"]*)"/g)].map(([, classes]) => classes);
    expect(animated.length).toBeGreaterThan(0);
    for (const classes of animated) expect(classes).toMatch(/(^|\s)motion-safe:animate-trace-(play|rail-x|rail-y)(\s|$)/);
    expect(playing).toContain('animation-delay:1520ms');
  });
});

describe('ProofId', () => {
  const value = '0f8e6a1c-52d4-4f27-9a3b-7c1de0b4e21b';

  it('shows the short id but gives a screen reader the whole value', () => {
    const html = renderToStaticMarkup(createElement(ProofId, { value, label: 'Receipt id' }));
    expect(html).toContain('0f8e6a1c...e21b');
    expect(text(html)).toContain(`Receipt id: ${value}`);
    expect(html).toContain('aria-label="Copy receipt id"');
    expect(html).toContain('font-mono');
  });

  it('keeps a brand name in the copy label', () => {
    const html = renderToStaticMarkup(createElement(ProofId, { value: '8MC58745YK1234567', label: 'PayPal order id' }));
    expect(html).toContain('aria-label="Copy PayPal order id"');
  });
});

describe('JwsView', () => {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = { alg: 'EdDSA', kid: 'behest-2026-11', typ: 'behest-receipt+jws' };
  const payload = { v: 1, iss: 'behest', cart: { totalCents: 1875 } };
  const jws = `${b64url(header)}.${b64url(payload)}.${Buffer.alloc(64, 9).toString('base64url')}`;

  it('colours the three segments and decodes the header and the payload', () => {
    const html = renderToStaticMarkup(createElement(JwsView, { jws }));
    const [h, p, s] = jws.split('.');
    expect(html).toContain(`<span class="text-jws-header">${h}</span>`);
    expect(html).toContain(`<span class="text-jws-payload">${p}</span>`);
    expect(html).toContain(`<span class="text-jws-signature">${s}</span>`);
    expect(text(html)).toContain('"kid" : "behest-2026-11"');
    expect(text(html)).toContain('"totalCents" : 1875');
    expect(text(html)).toContain('does not check the signature');
    expect(html).toContain('aria-label="Copy JWS"');
  });

  it('says what is wrong with a token that is not a compact JWS', () => {
    const html = renderToStaticMarkup(createElement(JwsView, { jws: 'not-a-token' }));
    expect(text(html)).toContain('This is not a compact JWS');
  });
});

describe('Console', () => {
  it('sets tool calls and times in mono and plain lines in sans', () => {
    const html = renderToStaticMarkup(
      createElement(Console, {
        label: 'Your agent run',
        rows: [
          { id: '1', at: '2026-11-07T14:02:07Z', kind: 'tool', label: 'search_sellers', body: 'query: "turmeric"' },
          { id: '2', at: '2026-11-07T14:02:08Z', kind: 'status', body: '3 results from Ravi’s Spice Co.' },
        ],
      }),
    );
    expect(html).toContain('<time dateTime="2026-11-07T14:02:07Z"');
    expect(text(html)).toContain('14:02:07 search_sellers query: "turmeric" 14:02:08 3 results');
    expect(html).toMatch(/class="[^"]*font-mono[^"]*">search_sellers</);
    expect(html).toMatch(/class="[^"]*text-body[^"]*">3 results/);
  });

  it('shows its empty message before the first row', () => {
    const html = renderToStaticMarkup(createElement(Console, { label: 'Your agent run', rows: [], empty: 'Send your agent to start a run.' }));
    expect(text(html)).toBe('Send your agent to start a run.');
  });
});

describe('Notice', () => {
  it('interrupts only for a stop', () => {
    const role = (kind: 'info' | 'success' | 'hold' | 'stop') =>
      // The message goes in as children, the third argument; its type comes from Notice's props.
      renderToStaticMarkup(createElement(Notice, { kind } as ComponentProps<typeof Notice>, 'Message')).match(/role="(\w+)"/)?.[1];
    expect(role('stop')).toBe('alert');
    expect(role('hold')).toBe('status');
    expect(role('success')).toBe('status');
    expect(role('info')).toBe('status');
  });
});
