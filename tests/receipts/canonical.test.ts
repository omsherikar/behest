import { expect, it } from 'vitest';
import { canonicalJson, hashOf, sha256Hex } from '@/lib/receipts/canonical';

it('ignores key order', () => expect(hashOf({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(hashOf({ a: [2, { c: 4, d: 3 }], b: 1 })));
it('serializes per RFC 8785', () => expect(canonicalJson({ b: 1e21, a: 'é', c: [true, null] })).toBe('{"a":"é","b":1e+21,"c":[true,null]}'));
it('hashes to lowercase hex sha256', () => expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));

it('refuses values JSON cannot represent instead of hashing nothing', () => {
  expect(() => canonicalJson(undefined)).toThrow('no JSON representation');
  expect(() => hashOf(() => 1)).toThrow('no JSON representation');
});
