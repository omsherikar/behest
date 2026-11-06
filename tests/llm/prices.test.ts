import { expect, it } from 'vitest';
import { estimateCostUsd, PRICES } from '@/lib/llm/prices';

it('lists per-million-token prices for each model', () => {
  expect(PRICES).toEqual({
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  });
});

it('prices input and output tokens', () => {
  expect(estimateCostUsd('claude-opus-5-5', { input_tokens: 1000, output_tokens: 500 })).toBe(0.014);
  expect(estimateCostUsd('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500 })).toBe(0.007);
});

it('prices cache reads and writes at their own rates', () => {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  };
  expect(estimateCostUsd('claude-haiku-5-5', usage)).toBe(0.135);
  expect(estimateCostUsd('claude-opus-5-5', usage)).toBe(5.2);
});

it('treats missing cache counts as zero', () => {
  const usage = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null };
  expect(estimateCostUsd('claude-opus-5-5', usage)).toBe(0.004);
});

it('rounds to the micro-dollar the cost column stores', () => {
  expect(estimateCostUsd('claude-opus-5-5', { input_tokens: 3, output_tokens: 1 })).toBe(0.000032);
  expect(estimateCostUsd('claude-haiku-5-5', { input_tokens: 4, output_tokens: 0 })).toBe(0);
});

it('refuses to price a model it has no price for', () => {
  expect(() => estimateCostUsd('claude-unknown-1', { input_tokens: 1, output_tokens: 1 })).toThrow(
    'No price for model claude-unknown-1',
  );
});
