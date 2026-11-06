// What model calls cost, so every call can be logged with an estimate and held to the daily cap.

/** US dollars per million tokens. */
export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** The token counts of a Messages API `usage` object. The API reports absent cache counts as null. */
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Whether the model has a price of its own. */
export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

/** Each rate at its highest across PRICES, for a model without a price (such as a fallback model). */
const HIGHEST_PRICE: ModelPrice = {
  input: Math.max(...Object.values(PRICES).map((price) => price.input)),
  output: Math.max(...Object.values(PRICES).map((price) => price.output)),
  cacheRead: Math.max(...Object.values(PRICES).map((price) => price.cacheRead)),
  cacheWrite: Math.max(...Object.values(PRICES).map((price) => price.cacheWrite)),
};

/**
 * The estimated cost of one model attempt in US dollars, rounded to the micro-dollar the log stores.
 * A model without a price is charged the highest rates, so tokens already spent are never left out.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = hasPrice(model) ? PRICES[model] : HIGHEST_PRICE;
  const perMillion =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite;
  return Math.round(perMillion) / 1_000_000;
}
