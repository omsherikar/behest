import { describe, expect, it } from 'vitest';
import { base64UrlText, jsonLines, jsonTokens, splitJws } from '@/lib/ui/jws';

const b64url = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

const header = { alg: 'EdDSA', kid: 'behest-2026-11', typ: 'behest-receipt+jws' };
const payload = { v: 1, iss: 'behest', iat: 1794067331, seller: { slug: 'ravis-spice-co' }, note: 'Kashmiri saffron, 2 g' };
const signature = Buffer.alloc(64, 7).toString('base64url');
const token = `${b64url(header)}.${b64url(payload)}.${signature}`;

describe('splitJws', () => {
  it('splits a compact JWS into its three segments', () => {
    const parts = splitJws(token);
    expect(parts && [parts.header, parts.payload, parts.signature].join('.')).toBe(token);
  });

  it('decodes the header and the payload from base64url', () => {
    expect(splitJws(token)?.decodedHeader).toEqual(header);
    expect(splitJws(token)?.decodedPayload).toEqual(payload);
  });

  it('ignores whitespace around the token', () => {
    expect(splitJws(`  ${token}\n`)?.signature).toBe(signature);
  });

  it('leaves a segment that is not JSON undecoded', () => {
    const parts = splitJws(`${b64url('not json')}.${b64url(payload)}.${signature}`);
    expect(parts?.decodedHeader).toBeUndefined();
    expect(parts?.decodedPayload).toEqual(payload);
  });

  it('refuses anything that is not three base64url segments', () => {
    expect(splitJws('')).toBeNull();
    expect(splitJws('a.b')).toBeNull();
    expect(splitJws('a.b.c.d')).toBeNull();
    expect(splitJws('a..c')).toBeNull();
    expect(splitJws('a+b.c/d.e=f')).toBeNull();
  });
});

describe('base64UrlText', () => {
  it('reads UTF-8 text without padding', () => {
    expect(base64UrlText(b64url('Ravi’s Spice Co.'))).toBe('Ravi’s Spice Co.');
    expect(base64UrlText(b64url('ab'))).toBe('ab');
  });

  it('is null for text that is not base64url or not UTF-8', () => {
    expect(base64UrlText('a')).toBeNull();
    expect(base64UrlText('ab+c')).toBeNull();
    expect(base64UrlText(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'))).toBeNull();
  });
});

describe('jsonTokens', () => {
  it('gives back the indented JSON when joined', () => {
    expect(jsonTokens(payload).map((token) => token.text).join('')).toBe(JSON.stringify(payload, null, 2));
  });

  it('tells keys from values', () => {
    const tokens = jsonTokens({ alg: 'EdDSA', n: -1.5e3, ok: true, none: null });
    const kinds = (kind: string) => tokens.filter((token) => token.kind === kind).map((token) => token.text);
    expect(kinds('key')).toEqual(['"alg"', '"n"', '"ok"', '"none"']);
    expect(kinds('string')).toEqual(['"EdDSA"']);
    expect(kinds('number')).toEqual(['-1500']);
    expect(kinds('literal')).toEqual(['true', 'null']);
  });

  it('keeps escaped quotes inside one string', () => {
    const tokens = jsonTokens({ quote: 'say "hi"' });
    expect(tokens.find((token) => token.kind === 'string')?.text).toBe('"say \\"hi\\""');
  });
});

describe('jsonLines', () => {
  it('gives each line its indentation and its tokens', () => {
    const lines = jsonLines({ mandate: { policyHash: 'f'.repeat(64) } });
    expect(lines.map((line) => line.indent)).toEqual([0, 2, 4, 2, 0]);
    expect(lines[2].tokens.map((token) => token.kind)).toEqual(['key', 'punctuation', 'punctuation', 'string']);
  });

  it('gives back the indented JSON when each line is indented and joined', () => {
    const lines = jsonLines(payload);
    const json = lines.map((line) => ' '.repeat(line.indent) + line.tokens.map((token) => token.text).join('')).join('\n');
    expect(json).toBe(JSON.stringify(payload, null, 2));
  });
});
