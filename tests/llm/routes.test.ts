import { expect, it } from 'vitest';
import { LLM_ROUTES, routeConfig } from '@/lib/llm/routes';

const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...vars });

it('gives every route the default model with its own effort and token budget', () => {
  const configs = Object.fromEntries(LLM_ROUTES.map((route) => [route, routeConfig(route, env())]));
  expect(configs).toEqual({
    mandate_compile: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 8000 },
    shopping_agent: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 16000 },
    intent_check: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 4000 },
    catalog_build: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 16000 },
    dispute_evidence: { model: 'claude-opus-5-5', effort: 'high', maxTokens: 16000 },
    studio_analyst: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 8000 },
  });
});

it('reads model and effort overrides named after the route', () => {
  const overrides = env({ CLAUDE_MODEL_MANDATE_COMPILE: 'claude-haiku-5-5', CLAUDE_EFFORT_MANDATE_COMPILE: 'high' });
  expect(routeConfig('mandate_compile', overrides)).toEqual({
    model: 'claude-haiku-5-5',
    effort: 'high',
    maxTokens: 8000,
  });
  expect(routeConfig('intent_check', overrides)).toEqual({ model: 'claude-opus-5-5', effort: 'low', maxTokens: 4000 });
});

it('treats blank overrides as unset', () => {
  const blank = env({ CLAUDE_MODEL_INTENT_CHECK: ' ', CLAUDE_EFFORT_INTENT_CHECK: '' });
  expect(routeConfig('intent_check', blank)).toEqual({ model: 'claude-opus-5-5', effort: 'low', maxTokens: 4000 });
});

it('rejects an effort the routes do not use', () => {
  expect(() => routeConfig('intent_check', env({ CLAUDE_EFFORT_INTENT_CHECK: 'max' }))).toThrow(
    'CLAUDE_EFFORT_INTENT_CHECK must be low, medium or high, got "max"',
  );
});

it('rejects a model the cost log cannot price', () => {
  expect(() => routeConfig('intent_check', env({ CLAUDE_MODEL_INTENT_CHECK: 'claude-unknown-1' }))).toThrow(
    'CLAUDE_MODEL_INTENT_CHECK names claude-unknown-1, which has no price',
  );
});
