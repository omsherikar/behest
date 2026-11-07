import { z } from 'zod';
import { Verdict } from '@/lib/domain/verdict';
import { GATE_RULES } from '@/lib/gate/rules';
import { ATTACK_IDS } from './attacks';

// What the attack replay records, and the shape of lib/security/results.json, which the replay script
// writes and the security page reads. Every layer's outcome is a state: `stopped` means the attack
// cannot get past it, `flagged` that the layer marked it or held it for the buyer, and `passed` that
// it went through the layer unchanged.

export const LayerState = z.enum(['stopped', 'flagged', 'passed']);
export type LayerState = z.infer<typeof LayerState>;

const AttackId = z.enum(ATTACK_IDS);

/** Onboarding: the CSV reader and the fixed screen, as the demo seed applies them. */
const ScreenLayer = z.object({
  state: LayerState,
  /** Whether the stored listing carries the flag that hides it from agents and blocks it at the gate. */
  flagged: z.boolean(),
  /** The phrases the screen matched in the listing as stored, by strength. */
  strong: z.array(z.string()),
  weak: z.array(z.string()),
  /** How many hidden characters the CSV reader dropped from the seller's text before the screen read it. */
  hiddenRemoved: z.number().int().nonnegative(),
  /** Phrases aimed at agents that only the dropped characters spelled, so none was stored. */
  hiddenPhrases: z.array(z.string()),
});

/** What the shopping agent's tools show of the listing. */
const VisibilityLayer = z.object({
  state: LayerState,
  /** Whether search_sellers lists it. */
  listed: z.boolean(),
  /** Whether get_product shows it. */
  shown: z.boolean(),
  /** The seller-written fields (seller name, title, description) shown outside an untrusted quote. */
  unquoted: z.array(z.string()),
});

const RuleOutcome = z.object({
  rule: z.enum([...GATE_RULES, 'internal_error']),
  result: z.enum(['pass', 'ask', 'block', 'skip']),
  detail: z.string(),
});

/** The gate on the cart the attack wants, under the demo mandate. */
const GateLayer = z.object({
  state: LayerState,
  verdict: Verdict,
  cart: z.object({ sku: z.string(), quantity: z.number().int(), totalCents: z.number().int() }).nullable(),
  rules: z.array(RuleOutcome),
});

export const ReplayResult = z.object({ attack: AttackId, screen: ScreenLayer, visibility: VisibilityLayer, gate: GateLayer });
export type ReplayResult = z.infer<typeof ReplayResult>;

/** A live run's outcome: a layer state, or `failed` when the run ended in an error before it could show one. */
export const LiveState = z.enum([...LayerState.options, 'failed']);
export type LiveState = z.infer<typeof LiveState>;

const LiveProposal = z.object({
  sellerSlug: z.string(),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int() })),
  /** The agent's own words, so untrusted. */
  rationale: z.string(),
  /** Whether the proposal includes the attack's listing. */
  targetsAttack: z.boolean(),
  gateVerdict: Verdict,
  intent: z.object({ verdict: z.string(), reasons: z.array(z.string()) }).nullable(),
  finalVerdict: Verdict.nullable(),
  status: z.string(),
});
export type LiveProposal = z.infer<typeof LiveProposal>;

export const LiveResult = z.object({
  attack: AttackId,
  state: LiveState,
  proposals: z.array(LiveProposal),
  /** What the agent told the buyer, or Behest's own message when the run failed. */
  summary: z.string(),
  error: z.string().nullable(),
  /** Model calls logged in llm_calls for this attack, and their estimated cost in US dollars. */
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type LiveResult = z.infer<typeof LiveResult>;

export const LiveRun = z.object({
  ranAt: z.iso.datetime(),
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  results: z.array(LiveResult),
  /** Attacks not run because the run's spend reached its cap. */
  skipped: z.array(AttackId),
});
export type LiveRun = z.infer<typeof LiveRun>;

export const ResultsFile = z.object({
  version: z.literal(1),
  /** The readback of the mandate every attack ran under. */
  mandate: z.array(z.string()),
  deterministic: z.array(ReplayResult),
  /** Null until the live replay has run. */
  live: LiveRun.nullable(),
});
export type ResultsFile = z.infer<typeof ResultsFile>;
