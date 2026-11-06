import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MandatePolicy } from '@/lib/domain/policy';
import { renderReadback } from '@/lib/mandate/readback';
import { demoPolicy } from '@/tests/helpers/fixtures';

const demoReadback = [
  'Your agent can spend up to $60.00 per calendar month (UTC).',
  'Any single purchase over $60.00 is blocked.',
  'Purchases over $25.00 need your approval.',
  'Allowed categories: groceries, spices.',
  'Never: electronics.',
  'Any seller.',
  'No limit on how often it buys.',
  'No end date.',
];

/** The readback of the demo policy with some fields changed. The result is validated first. */
const readbackWith = (changes: Partial<MandatePolicy>) => renderReadback(MandatePolicy.parse({ ...demoPolicy, ...changes }));

/** The demo readback with the line at `index` replaced. */
const demoWithLine = (index: number, line: string) => demoReadback.map((l, i) => (i === index ? line : l));

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

it('renders the demo mandate line by line', () => expect(renderReadback(demoPolicy)).toEqual(demoReadback));

it('renders every line in a fixed order when every field is set', () =>
  expect(
    readbackWith({
      merchants: { allow: ['ravi-spices'], deny: ['bad-shop'] },
      velocity: { maxPurchases: 2, windowHours: 24 },
      expiresAt: '2026-12-31T23:59:59.999Z',
    }),
  ).toEqual([
    'Your agent can spend up to $60.00 per calendar month (UTC).',
    'Any single purchase over $60.00 is blocked.',
    'Purchases over $25.00 need your approval.',
    'Allowed categories: groceries, spices.',
    'Never: electronics.',
    'Only these sellers: ravi-spices.',
    'Never from: bad-shop.',
    'At most 2 purchases in any 24 hours.',
    'Ends on 2026-12-31.',
  ]));

describe('budget', () => {
  it('reads a one-off budget as a total', () =>
    expect(readbackWith({ budget: { amountCents: 6000, period: 'once' } })).toEqual(
      demoWithLine(0, 'Your agent can spend up to $60.00 in total.'),
    ));

  it('reads daily and weekly budgets as UTC calendar periods', () => {
    expect(readbackWith({ budget: { amountCents: 6000, period: 'day' } })[0]).toBe(
      'Your agent can spend up to $60.00 per calendar day (UTC).',
    );
    expect(readbackWith({ budget: { amountCents: 6000, period: 'week' } })[0]).toBe(
      'Your agent can spend up to $60.00 per calendar week (Monday to Sunday, UTC).',
    );
  });
});

it('says no purchase needs approval for its amount when there is no approval limit', () =>
  expect(readbackWith({ askAboveCents: null })).toEqual(
    demoWithLine(2, 'No purchase needs your approval because of its amount alone.'),
  ));

describe('categories', () => {
  it('allows any category not denied when there is no allow list', () =>
    expect(readbackWith({ categories: { allow: null, deny: ['electronics'] } })).toEqual(
      demoWithLine(3, 'Any category not listed below.'),
    ));

  it('omits the never line when no category is denied', () => {
    const lines = readbackWith({ categories: { allow: ['groceries', 'spices'], deny: [] } });
    expect(lines).toEqual(demoReadback.filter((l) => l !== 'Never: electronics.'));
    expect(lines.some((l) => l.startsWith('Never:'))).toBe(false);
  });

  it('allows any category when nothing is listed either way', () =>
    expect(readbackWith({ categories: { allow: null, deny: [] } })).toEqual(
      demoReadback.filter((l) => l !== 'Never: electronics.').map((l, i) => (i === 3 ? 'Any category.' : l)),
    ));

  it('says no category is allowed when the allow list is empty', () =>
    expect(readbackWith({ categories: { allow: [], deny: ['electronics'] } })).toEqual(
      demoWithLine(3, 'No category is allowed.'),
    ));

  it('shows category ids as words', () =>
    expect(readbackWith({ categories: { allow: ['personal_care'], deny: ['gift_cards', 'electronics'] } })).toEqual(
      demoWithLine(3, 'Allowed categories: personal care.').map((l, i) =>
        i === 4 ? 'Never: gift cards, electronics.' : l,
      ),
    ));
});

describe('sellers', () => {
  it('limits purchases to the listed sellers', () =>
    expect(readbackWith({ merchants: { allow: ['ravi-spices'], deny: [] } })).toEqual(
      demoWithLine(5, 'Only these sellers: ravi-spices.'),
    ));

  it('lists denied sellers after the sellers line', () =>
    expect(readbackWith({ merchants: { allow: null, deny: ['bad-shop', 'worse-shop'] } })).toEqual([
      ...demoReadback.slice(0, 5),
      'Any seller not listed below.',
      'Never from: bad-shop, worse-shop.',
      ...demoReadback.slice(6),
    ]));

  it('says no seller is allowed when the allow list is empty', () =>
    expect(readbackWith({ merchants: { allow: [], deny: [] } })).toEqual(demoWithLine(5, 'No seller is allowed.')));
});

describe('velocity', () => {
  it('reads a purchase limit over a rolling window', () =>
    expect(readbackWith({ velocity: { maxPurchases: 2, windowHours: 24 } })).toEqual(
      demoWithLine(6, 'At most 2 purchases in any 24 hours.'),
    ));

  it('uses the singular for a count of one', () =>
    expect(readbackWith({ velocity: { maxPurchases: 1, windowHours: 1 } })[6]).toBe('At most 1 purchase in any 1 hour.'));
});

describe('end date', () => {
  it('reads an expiry at the last millisecond of a UTC day as that date', () =>
    expect(readbackWith({ expiresAt: '2026-12-31T23:59:59.999Z' })).toEqual(demoWithLine(7, 'Ends on 2026-12-31.')));

  it('adds the UTC time to any other expiry', () => {
    expect(readbackWith({ expiresAt: '2026-12-31T00:00:00Z' })).toEqual(
      demoWithLine(7, 'Ends on 2026-12-31 at 00:00 UTC.'),
    );
    expect(readbackWith({ expiresAt: '2026-12-31T14:05:00Z' })[7]).toBe('Ends on 2026-12-31 at 14:05 UTC.');
    expect(readbackWith({ expiresAt: '2026-12-31T09:30:00Z' })[7]).toBe('Ends on 2026-12-31 at 09:30 UTC.');
  });

  it('adds the time to an expiry one minute before the end of the day', () =>
    expect(readbackWith({ expiresAt: '2026-12-31T23:59:00Z' })[7]).toBe('Ends on 2026-12-31 at 23:59 UTC.'));

  it('uses the UTC date and time whatever the server time zone', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(readbackWith({ expiresAt: '2026-12-31T23:59:59.999Z' })[7]).toBe('Ends on 2026-12-31.');
    expect(readbackWith({ expiresAt: '2026-12-31T23:30:00Z' })[7]).toBe('Ends on 2026-12-31 at 23:30 UTC.');
    process.env.TZ = 'America/Los_Angeles';
    expect(readbackWith({ expiresAt: '2027-01-01T00:30:00Z' })[7]).toBe('Ends on 2027-01-01 at 00:30 UTC.');
  });
});

describe('covers every field the gate enforces', () => {
  // Every field holds a value, and the lists are not empty, so a change that keeps a list's shape
  // but alters its contents must still show in the readback.
  const base = MandatePolicy.parse({
    ...demoPolicy,
    merchants: { allow: ['ravi-spices'], deny: ['bad-shop'] },
    velocity: { maxPurchases: 2, windowHours: 24 },
    expiresAt: '2026-12-31T23:59:59.999Z',
  });
  const { merchants } = base;

  const changes: { field: string; to: string; policy: unknown }[] = [
    { field: 'budget.amountCents', to: '7000', policy: { ...base, budget: { amountCents: 7000, period: 'month' } } },
    { field: 'budget.period', to: 'week', policy: { ...base, budget: { amountCents: 6000, period: 'week' } } },
    { field: 'perPurchaseMaxCents', to: '5000', policy: { ...base, perPurchaseMaxCents: 5000 } },
    { field: 'askAboveCents', to: '3000', policy: { ...base, askAboveCents: 3000 } },
    { field: 'askAboveCents', to: 'null', policy: { ...base, askAboveCents: null } },
    {
      field: 'categories.allow',
      to: 'a shorter list',
      policy: { ...base, categories: { allow: ['groceries'], deny: ['electronics'] } },
    },
    { field: 'categories.allow', to: 'null', policy: { ...base, categories: { allow: null, deny: ['electronics'] } } },
    {
      field: 'categories.deny',
      to: 'a longer list',
      policy: { ...base, categories: { allow: ['groceries', 'spices'], deny: ['electronics', 'software'] } },
    },
    { field: 'categories.deny', to: 'empty', policy: { ...base, categories: { allow: ['groceries', 'spices'], deny: [] } } },
    {
      field: 'merchants.allow',
      to: 'a longer list',
      policy: { ...base, merchants: { ...merchants, allow: ['ravi-spices', 'cumin-co'] } },
    },
    { field: 'merchants.allow', to: 'null', policy: { ...base, merchants: { ...merchants, allow: null } } },
    {
      field: 'merchants.deny',
      to: 'a longer list',
      policy: { ...base, merchants: { ...merchants, deny: ['bad-shop', 'worse-shop'] } },
    },
    { field: 'merchants.deny', to: 'empty', policy: { ...base, merchants: { ...merchants, deny: [] } } },
    { field: 'velocity', to: 'null', policy: { ...base, velocity: null } },
    { field: 'velocity.maxPurchases', to: '3', policy: { ...base, velocity: { maxPurchases: 3, windowHours: 24 } } },
    { field: 'velocity.windowHours', to: '48', policy: { ...base, velocity: { maxPurchases: 2, windowHours: 48 } } },
    { field: 'expiresAt', to: 'another date', policy: { ...base, expiresAt: '2027-01-15T23:59:59.999Z' } },
    { field: 'expiresAt', to: 'the start of the same day', policy: { ...base, expiresAt: '2026-12-31T00:00:00Z' } },
    { field: 'expiresAt', to: 'one minute earlier', policy: { ...base, expiresAt: '2026-12-31T23:59:00Z' } },
    { field: 'expiresAt', to: 'null', policy: { ...base, expiresAt: null } },
  ];

  it.each(changes)('changes the readback when $field changes to $to', ({ policy }) =>
    expect(renderReadback(MandatePolicy.parse(policy))).not.toEqual(renderReadback(base)),
  );

  /** Schema types that hold a single value with no fields inside it. */
  const VALUE_TYPES = [z.ZodString, z.ZodISODateTime, z.ZodNumber, z.ZodBoolean, z.ZodEnum];
  const isValue = (schema: unknown) => VALUE_TYPES.some((type) => schema instanceof type);

  /**
   * Every field of a schema that can take more than one value: each value, plus each wrapped
   * object, which can switch between a value and null, absence or its default. Literals such as
   * version and currency have only one valid value, so they cannot change. Any other schema type
   * throws, so a field can never sit behind a wrapper the walk does not look inside.
   */
  function changeableFields(schema: unknown, path: string[] = []): string[] {
    const field = path.join('.');
    if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
      const inner = changeableFields(schema.unwrap(), path);
      return inner.includes(field) ? inner : [field, ...inner];
    }
    if (schema instanceof z.ZodObject) {
      return Object.entries(schema.shape).flatMap(([key, value]) => changeableFields(value, [...path, key]));
    }
    if (schema instanceof z.ZodLiteral) return [];
    if (isValue(schema) || (schema instanceof z.ZodArray && isValue(schema.element))) return [field];
    throw new Error(`the field walk does not recognise the schema at ${field || 'the root'}`);
  }

  it('has a change for every policy field, so no field is enforced without being shown', () =>
    expect(new Set(changes.map((c) => c.field))).toEqual(new Set(changeableFields(MandatePolicy))));

  it('walks into nullable, optional and defaulted fields', () =>
    expect(
      changeableFields(
        z.object({
          a: z.string().optional(),
          b: z.object({ c: z.number(), d: z.literal(1) }).default({ c: 1, d: 1 }),
          e: z.object({ f: z.array(z.enum(['x', 'y'])) }).nullable(),
          g: z.object({ h: z.boolean() }),
        }),
      ),
    ).toEqual(['a', 'b', 'b.c', 'e', 'e.f', 'g.h']));

  it.each([
    ['a read-only field', z.object({ a: z.string().readonly() }), 'a'],
    ['a transformed field', z.object({ a: z.object({ b: z.string().transform((s) => s.length) }) }), 'a.b'],
    ['a list of objects', z.object({ a: z.array(z.object({ b: z.string() })) }), 'a'],
  ])('refuses %s rather than skip fields it cannot see', (_, schema, field) =>
    expect(() => changeableFields(schema)).toThrow(`at ${field}`),
  );
});

it('ends every line with a full stop and uses no em dash', () => {
  const policies: Partial<MandatePolicy>[] = [
    {},
    { budget: { amountCents: 6000, period: 'once' }, askAboveCents: null },
    { categories: { allow: null, deny: [] }, merchants: { allow: [], deny: ['bad-shop'] } },
    { velocity: { maxPurchases: 1, windowHours: 1 }, expiresAt: '2026-12-31T14:05:00Z' },
    { expiresAt: '2026-12-31T23:59:59.999Z' },
  ];
  const lines = policies.flatMap((changes) => readbackWith(changes));
  expect(lines.length).toBeGreaterThan(policies.length);
  for (const line of lines) {
    expect(line).toMatch(/\.$/);
    expect(line).not.toContain(String.fromCharCode(0x2014));
  }
});
