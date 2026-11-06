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

/** Whether the model has a price, and so can be held to the daily cap. */
export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

/** The estimated cost of one call in US dollars, rounded to the micro-dollar the log stores. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  if (!hasPrice(model)) throw new Error(`No price for model ${model}`);
  const price = PRICES[model];
  const perMillion =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite;
  return Math.round(perMillion) / 1_000_000;
}
