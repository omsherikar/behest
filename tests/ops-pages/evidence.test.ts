import { describe, expect, it } from 'vitest';
import { logTimeline, signedArtifact } from '@/lib/ops-pages/evidence';

const JWS = 'eyJhbGciOiJFZERTQSJ9.eyJpZCI6InJjdC0xIn0.c2lnbmF0dXJl';

describe('signedArtifact', () => {
  it('takes the compact JWS off the end of a receipt item, with the line that introduces it', () => {
    const body = [
      'Receipt rct-1, signed by Behest with key k1 at 2026-11-07T09:00:00.000Z.',
      'Payload hash: abc',
      '',
      'The signed receipt, a compact JWS:',
      JWS,
    ].join('\n');
    expect(signedArtifact(body)).toEqual({
      text: 'Receipt rct-1, signed by Behest with key k1 at 2026-11-07T09:00:00.000Z.\nPayload hash: abc',
      jws: JWS,
    });
  });

  it('finds a JWS that is not the last line', () => {
    expect(signedArtifact(`Before\n${JWS}\nAfter`)).toEqual({ text: 'Before\nAfter', jws: JWS });
  });

  it('is null for an item that carries no JWS', () => {
    expect(signedArtifact('Seller: Ravi\n- 2 x Turmeric\nTotal: $9.00 USD')).toBeNull();
    expect(signedArtifact('A sentence. With dots. In it.')).toBeNull();
  });
});

describe('logTimeline', () => {
  const body = [
    'Purchase p-1, created at 2026-11-07T09:00:00.000Z.',
    "The buyer's request to the agent: Restock turmeric",
    '',
    'Every recorded step, in order:',
    '1. 2026-11-07T09:00:00.000Z gate {"verdict":"ALLOW"}',
    '2. 2026-11-07T09:00:01.000Z intent',
    '3. 2026-11-07T09:00:02.000Z seller_refused reason: <untrusted source="seller_listing">Out of',
    'stock</untrusted>',
  ].join('\n');

  it('splits the opening lines from the numbered steps', () => {
    const timeline = logTimeline(body);
    expect(timeline?.intro).toEqual([
      'Purchase p-1, created at 2026-11-07T09:00:00.000Z.',
      "The buyer's request to the agent: Restock turmeric",
      'Every recorded step, in order:',
    ]);
    expect(timeline?.steps.map(({ n, at, kind }) => [n, at, kind])).toEqual([
      [1, '2026-11-07T09:00:00.000Z', 'gate'],
      [2, '2026-11-07T09:00:01.000Z', 'intent'],
      [3, '2026-11-07T09:00:02.000Z', 'seller_refused'],
    ]);
  });

  it('keeps each step detail, and a line that continues one with it', () => {
    const steps = logTimeline(body)?.steps ?? [];
    expect(steps[0].detail).toBe('{"verdict":"ALLOW"}');
    expect(steps[1].detail).toBe('');
    expect(steps[2].detail).toBe('reason: <untrusted source="seller_listing">Out of\nstock</untrusted>');
  });

  it('is null for text with no steps', () => {
    expect(logTimeline('Seller: Ravi\nTotal: $9.00 USD')).toBeNull();
  });
});
