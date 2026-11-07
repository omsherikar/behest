import { expect, it, vi } from 'vitest';
import { CATEGORIES } from '@/lib/domain/categories';
import { MandatePolicy } from '@/lib/domain/policy';
import { DECLINE_ANSWER } from '@/lib/mandate/decline';
import { MANDATE_SYSTEM_PROMPT } from '@/lib/mandate/prompts';

it('lists every category id in order', () => expect(MANDATE_SYSTEM_PROMPT).toContain(CATEGORIES.join(', ')));

it('describes every policy field', () => {
  for (const field of Object.keys(MandatePolicy.shape)) expect(MANDATE_SYSTEM_PROMPT).toContain(field);
});

it('holds no calendar date, so every request sends the same prompt', () =>
  expect(MANDATE_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/));

it('says how a limit the policy cannot hold is listed', () =>
  expect(MANDATE_SYSTEM_PROMPT).toContain('"not enforced: '));

it('asks for the decline option exactly as the page recognises it, as the last option', () =>
  expect(MANDATE_SYSTEM_PROMPT).toContain(`as the last option, exactly "${DECLINE_ANSWER}"`));

it('takes the decline option from DECLINE_ANSWER, so the two never differ', async () => {
  vi.resetModules();
  vi.doMock('@/lib/mandate/decline', () => ({ DECLINE_ANSWER: 'Stop, no mandate' }));
  try {
    const { MANDATE_SYSTEM_PROMPT: prompt } = await import('@/lib/mandate/prompts');
    expect(prompt).toContain('exactly "Stop, no mandate"');
    expect(prompt).not.toContain(DECLINE_ANSWER);
  } finally {
    vi.doUnmock('@/lib/mandate/decline');
    vi.resetModules();
  }
});
