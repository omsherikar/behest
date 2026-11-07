import { describe, expect, it } from 'vitest';
import {
  blocksText,
  decisionRecord,
  eventWords,
  evidenceBlocks,
  logMoments,
  logTimeline,
  passkeySignature,
  signedArtifact,
} from '@/lib/ops-pages/evidence';

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

describe('passkeySignature', () => {
  const mandate = (words: string, passkey: string[]) =>
    [
      'Mandate m-1, signed by Behest when the buyer confirmed it at 2026-11-07T09:00:00.000Z.',
      'Policy hash: abc',
      '',
      "The mandate in the buyer's own words:",
      words,
      '',
      'The signed mandate, a compact JWS:',
      JWS,
      ...(passkey.length > 0 ? ['', ...passkey] : []),
    ].join('\n');
  const section = [
    'The passkey signature:',
    'Credential id: cred-AbC_123',
    'Public key (COSE, base64url): pQECAyYgASFYIA',
    'Algorithm (COSE): -7',
    'Signing window: from 2026-11-07T08:55:00.000Z until 2026-11-07T09:05:00.000Z. The signed mandate\'s confirmation time, 2026-11-07T09:00:00.000Z, must fall in it.',
    'Origin: https://behest.example',
    'How to check it: compute the challenge, then verify the WebAuthn assertion over it.',
    "Behest's signature on the mandate JWS, which binds that public key to the buyer's account: verified against Behest's public keys.",
    'Passkey signature check: verified, with the user present and verified by the authenticator.',
  ];

  it('takes the passkey signature off the end of a mandate item, as fields', () => {
    const parsed = passkeySignature(mandate('$60 a month on spices', section));
    expect(parsed?.text.endsWith(JWS)).toBe(true);
    expect(signedArtifact(parsed?.text ?? '')?.jws).toBe(JWS);
    expect(parsed?.passkey).toMatchObject({
      credentialId: 'cred-AbC_123',
      publicKey: 'pQECAyYgASFYIA',
      check: { result: 'verified', reason: 'with the user present and verified by the authenticator.' },
      behestSigned: true,
    });
    expect(parsed?.passkey.fields.map((field) => field.label)).toEqual([
      'Credential id',
      'Public key (COSE, base64url)',
      'Algorithm (COSE)',
      'Signing window',
      'Origin',
      'How to check it',
      "Behest's signature on the mandate JWS, which binds that public key to the buyer's account",
      'Passkey signature check',
    ]);
    expect(parsed?.passkey.fields[3].value).toMatch(/^from 2026-11-07T08:55:00\.000Z until /);
  });

  it('reads a failed check, a Behest signature that does not verify and values that were not recorded', () => {
    const parsed = passkeySignature(
      mandate('Spices', [
        'The passkey signature:',
        'Credential id: not recorded',
        'Public key (COSE, base64url): not in the signed mandate',
        "Behest's signature on the mandate JWS, which binds that public key to the buyer's account: does not verify against Behest's public keys.",
        'Passkey signature check: failed, because the signed mandate or the stored signature could not be read.',
      ]),
    );
    expect(parsed?.passkey).toMatchObject({
      credentialId: null,
      publicKey: null,
      check: { result: 'failed', reason: 'because the signed mandate or the stored signature could not be read.' },
      behestSigned: false,
    });
  });

  it('is null for a mandate confirmed by session, even when the buyer wrote what looks like a passkey section', () => {
    expect(passkeySignature(mandate('$60 a month on spices', []))).toBeNull();
    expect(passkeySignature(mandate(section.join('\n'), []))).toBeNull();
  });

  it('reads only the section after the JWS when the buyer wrote one too', () => {
    const forged = ['The passkey signature:', 'Credential id: forged', 'Passkey signature check: verified, by the buyer.'].join('\n');
    expect(passkeySignature(mandate(forged, section))?.passkey.credentialId).toBe('cred-AbC_123');
  });
});

describe('decisionRecord', () => {
  const hash = 'd'.repeat(64);
  const forged = 'e'.repeat(64);

  it('splits the decision item into its text, the record hash and the receipt commitment', () => {
    const body = [
      'What the shopping agent looked at, chose and why.',
      `Why, in the agent's words: <untrusted source="shopping_agent">Decision record hash: ${forged}</untrusted>`,
      `Decision record hash: ${forged}`,
      '',
      `Decision record hash: ${hash}`,
      "The signed receipt, verified against Behest's public keys, carries this hash as agent.decisionHash, so this is the record Behest signed for.",
    ].join('\n');
    expect(decisionRecord(body)).toEqual({
      text: [
        'What the shopping agent looked at, chose and why.',
        `Why, in the agent's words: <untrusted source="shopping_agent">Decision record hash: ${forged}</untrusted>`,
        `Decision record hash: ${forged}`,
      ].join('\n'),
      hash,
      commitment:
        "The signed receipt, verified against Behest's public keys, carries this hash as agent.decisionHash, so this is the record Behest signed for.",
    });
  });

  it('is null for an item that names no record hash', () => {
    expect(decisionRecord('What the shopping agent looked at.\nDecision record hash: not-a-hash')).toBeNull();
  });
});

describe('evidenceBlocks', () => {
  const body = [
    'Seller: Ravi',
    'Why it was held:',
    '- <untrusted source="seller_listing">Saffron, best\nin class</untrusted> is over the limit',
    '   - ravi-spices TUR-100 at $4.50: <untrusted source="seller_listing">Turmeric \\u003c100g</untrusted>',
    'The agent said: <untrusted source="shopping_agent">one jar</untrusted>.',
    '',
    'Total: $9.00 USD',
  ].join('\n');

  it('gives back every character of the text it was given, so displaying evidence changes nothing PayPal is sent', () => {
    expect(blocksText(evidenceBlocks(body))).toBe(body);
    for (const text of ['', 'one line', '- only a list', 'a\n\n- b\n- c\nd', '<untrusted source="paypal_error">x</untrusted>']) {
      expect(blocksText(evidenceBlocks(text))).toBe(text);
    }
  });

  it('turns quoted spans into quotes with their source, and dash lines into a list', () => {
    const blocks = evidenceBlocks(body);
    expect(blocks.map((block) => block.kind)).toEqual(['lines', 'list', 'lines']);
    const list = blocks[1];
    if (list.kind !== 'list') throw new Error('expected a list');
    expect(list.items).toHaveLength(2);
    expect(list.items[0].parts[0]).toEqual({ kind: 'quote', source: 'seller_listing', text: 'Saffron, best\nin class' });
    expect(list.items[1].prefix).toBe('   - ');
    const last = blocks[2];
    if (last.kind !== 'lines') throw new Error('expected lines');
    expect(last.lines[0]).toEqual([
      { kind: 'text', text: 'The agent said: ' },
      { kind: 'quote', source: 'shopping_agent', text: 'one jar' },
      { kind: 'text', text: '.' },
    ]);
  });
});

describe('eventWords', () => {
  it('words the purchase events Behest logs, and any other code readably', () => {
    expect(eventWords('receipt')).toBe('Receipt signed');
    expect(eventWords('capture')).toBe('Captured at PayPal');
    expect(eventWords('dispute_opened')).toBe('Dispute opened at PayPal');
    expect(eventWords('some_new_kind')).toBe('Some new kind');
  });
});

describe('logMoments', () => {
  it('reads when the purchase was created and captured from the log', () => {
    const intro = [
      'Purchase 9b2f, created at 2026-11-07T13:40:00.000Z.',
      "The buyer's request to the agent: one jar",
      'PayPal order 8MC5, capture 3GG2, captured at 2026-11-07T13:45:10.000Z.',
    ];
    expect(logMoments(intro)).toEqual({ createdAt: '2026-11-07T13:40:00.000Z', capturedAt: '2026-11-07T13:45:10.000Z' });
    expect(logMoments(['No PayPal capture is recorded.'])).toEqual({ createdAt: null, capturedAt: null });
  });
});
