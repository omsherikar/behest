import { expect, it } from 'vitest';
import { CATEGORIES } from '@/lib/domain/categories';
import { MandatePolicy } from '@/lib/domain/policy';
import { MANDATE_SYSTEM_PROMPT } from '@/lib/mandate/prompts';

it('lists every category id in order', () => expect(MANDATE_SYSTEM_PROMPT).toContain(CATEGORIES.join(', ')));

it('describes every policy field', () => {
  for (const field of Object.keys(MandatePolicy.shape)) expect(MANDATE_SYSTEM_PROMPT).toContain(field);
});

it('holds no calendar date, so every request sends the same prompt', () =>
  expect(MANDATE_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/));

it('says how a limit the policy cannot hold is listed', () =>
  expect(MANDATE_SYSTEM_PROMPT).toContain('"not enforced: '));
