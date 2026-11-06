import { hasPrice } from './prices';

// Each place the app calls the model is a route with its own model, effort and output budget.
// CLAUDE_MODEL_<ROUTE> and CLAUDE_EFFORT_<ROUTE> override them, e.g. CLAUDE_EFFORT_INTENT_CHECK=medium.

export type LlmRoute =
  | 'mandate_compile'
  | 'shopping_agent'
  | 'intent_check'
  | 'catalog_build'
  | 'dispute_evidence'
  | 'studio_analyst';

const EFFORTS = ['low', 'medium', 'high'] as const;
export type LlmEffort = (typeof EFFORTS)[number];

export type RouteConfig = { model: string; effort: LlmEffort; maxTokens: number };

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Every model request names its route in this header, for logs and for replaying recorded replies. */
export const ROUTE_HEADER = 'x-behest-route';

const DEFAULTS: Record<LlmRoute, { effort: LlmEffort; maxTokens: number }> = {
  mandate_compile: { effort: 'medium', maxTokens: 8000 },
  shopping_agent: { effort: 'medium', maxTokens: 16000 },
  intent_check: { effort: 'low', maxTokens: 4000 },
  catalog_build: { effort: 'medium', maxTokens: 16000 },
  dispute_evidence: { effort: 'high', maxTokens: 16000 },
  studio_analyst: { effort: 'low', maxTokens: 8000 },
};

export const LLM_ROUTES = Object.keys(DEFAULTS) as LlmRoute[];

function isEffort(value: string): value is LlmEffort {
  return (EFFORTS as readonly string[]).includes(value);
}

/** The model, effort and output budget for a route. Throws on an override it cannot honour. */
export function routeConfig(route: LlmRoute, env: NodeJS.ProcessEnv = process.env): RouteConfig {
  const suffix = route.toUpperCase();
  const defaults = DEFAULTS[route];

  const modelVariable = `CLAUDE_MODEL_${suffix}`;
  const model = env[modelVariable]?.trim() || DEFAULT_MODEL;
  if (!hasPrice(model)) throw new Error(`${modelVariable} names ${model}, which has no price`);

  const effortVariable = `CLAUDE_EFFORT_${suffix}`;
  const effort = env[effortVariable]?.trim() || defaults.effort;
  if (!isEffort(effort)) throw new Error(`${effortVariable} must be low, medium or high, got "${effort}"`);

  return { model, effort, maxTokens: defaults.maxTokens };
}
