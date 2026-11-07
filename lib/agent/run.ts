import { randomUUID } from 'node:crypto';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { mandates } from '@/lib/db/schema';
import type { PurchaseProposal } from '@/lib/domain/proposal';
import type { LlmDeps, LlmFailure } from '@/lib/llm/client';
import { runToolLoop } from '@/lib/llm/tool-loop';
import type { ProposalOutcome, PurchaseDeps } from '@/lib/purchases/deps';
import { proposePurchase } from '@/lib/purchases/propose';
import { SHOPPING_SYSTEM_PROMPT } from './prompt';
import { buildShoppingTools, type MarketSearch } from './tools';

// One run of the shopping agent for a buyer's request. The agent searches Behest's sellers with its
// tools and proposes purchases; each proposal goes through the purchase flow, which charges it, asks
// the buyer, or blocks it. The run reports its progress as events for the buyer's page. Every message
// in an event is Behest's own, apart from the tool inputs the agent chose and its closing summary.

/** What a run tells the buyer's page as it goes. */
export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'proposal'; outcome: ProposalOutcome }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string };

/** The model, the purchase flow, and the market search, without which market prices are not available. */
export type AgentDeps = LlmDeps & { purchases: PurchaseDeps; search?: MarketSearch };

export type AgentRequest = {
  buyerId: string;
  /** What the buyer asked for, in their own words. */
  request: string;
  /** Must not throw: the tools call it, and a tool that throws reports a failure to the agent. */
  onEvent: (event: AgentEvent) => void;
  /** Aborted when the buyer goes away: the run then stops at the next turn boundary, quietly. */
  signal?: AbortSignal;
};

export type AgentResult = { runId: string; outcomes: ProposalOutcome[]; summary: string };

/** The most requests one run makes. */
const MAX_TURNS = 12;

const NO_MANDATE = 'Sign a mandate first.';
const STARTED = 'Your agent is looking for what you asked for.';
const OUT_OF_TURNS = 'Your agent ran out of steps before it finished. Each proposal it made is shown above.';
const NO_SUMMARY = 'Your agent finished without a summary. Each proposal it made is shown above.';

/** What the buyer is told when a run fails in a way Behest did not expect. */
export const RUN_FAILED = 'Your agent stopped because something went wrong. Check your purchases, then try again.';

/** What the buyer is told for each way the model loop can fail. Nothing the model wrote reaches them. */
const FAILURES: Record<LlmFailure, string> = {
  spend_cap: "Behest has used today's budget for model calls. Try again tomorrow.",
  refusal: 'Your agent could not take on this request. Try rewording it.',
  max_tokens: RUN_FAILED,
  invalid_output: RUN_FAILED,
  api_error: RUN_FAILED,
};

/** The readback of the buyer's mandate, if they have one that is active and has not reached its end. */
async function activeMandateReadback(db: Db, buyerId: string, now: Date): Promise<string[] | null> {
  const [mandate] = await db
    .select({ readback: mandates.readback })
    .from(mandates)
    .where(
      and(
        eq(mandates.buyerId, buyerId),
        eq(mandates.status, 'active'),
        or(isNull(mandates.expiresAt), gt(mandates.expiresAt, now)),
      ),
    );
  return mandate?.readback ?? null;
}

/** The run's first message. The request is the buyer's and the readback Behest's, so neither is quoted. */
function firstMessage(request: string, readback: string[]): string {
  return [
    `The buyer's request, in their own words:\n<request>\n${request}\n</request>`,
    `The mandate the buyer signed, as Behest reads it back to them. Behest checks every proposal against it.\n<mandate>\n${readback.join('\n')}\n</mandate>`,
  ].join('\n\n');
}

/** `tool`, telling the buyer each time it runs and with what input. A call whose input does not parse never runs. */
function announced(tool: BetaRunnableTool, onEvent: AgentRequest['onEvent']): BetaRunnableTool {
  return {
    ...tool,
    run: (input, context) => {
      onEvent({ type: 'tool', name: tool.name, input });
      return tool.run(input, context);
    },
  };
}

/**
 * What the agent told the buyer in its last reply. Text from before a fallback block came from a
 * model that declined, so only the text after the last one counts.
 */
function summaryOf(reply: BetaMessage): string {
  // The last reply asked for tools when the run ran out of turns.
  if (reply.stop_reason === 'tool_use') return OUT_OF_TURNS;
  const lastFallback = reply.content.findLastIndex((block) => block.type === 'fallback');
  const text = reply.content
    .slice(lastFallback + 1)
    .flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
  return text || NO_SUMMARY;
}

/**
 * Runs the shopping agent on the buyer's request for at most 12 turns. A buyer without an active
 * mandate that has not reached its end gets the error "Sign a mandate first." and no model is called.
 * Otherwise the agent gets the request and the mandate's readback, and each proposal it makes goes
 * through proposePurchase under a new run id, with the buyer's own request beside it, never the
 * agent's words; each outcome is a `proposal` event. A run ends with `done` and the agent's summary,
 * or with one `error` whose message is Behest's own, logged on the server.
 *
 * Once `signal` aborts the run stops at the next turn boundary and emits nothing more: a proposal
 * already running finishes, and its outcome is recorded. Throws on misconfiguration and database
 * errors, as runToolLoop does.
 */
export async function runShoppingAgent(deps: AgentDeps, i: AgentRequest): Promise<AgentResult> {
  const runId = randomUUID();
  const outcomes: ProposalOutcome[] = [];
  const readback = await activeMandateReadback(deps.db, i.buyerId, deps.now());
  if (!readback) {
    i.onEvent({ type: 'error', message: NO_MANDATE });
    return { runId, outcomes, summary: '' };
  }
  i.onEvent({ type: 'status', text: STARTED });

  const propose = async (proposal: PurchaseProposal) => {
    const outcome = await proposePurchase(deps.purchases, { buyerId: i.buyerId, runId, request: i.request, proposal });
    outcomes.push(outcome);
    i.onEvent({ type: 'proposal', outcome });
    return outcome;
  };
  const tools = buildShoppingTools({ db: deps.db, buyerId: i.buyerId, runId, request: i.request, propose, search: deps.search });

  const result = await runToolLoop(deps, 'shopping_agent', {
    system: SHOPPING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: firstMessage(i.request, readback) }],
    tools: tools.map((tool) => announced(tool, i.onEvent)),
    maxTurns: MAX_TURNS,
    signal: i.signal,
  });
  // The buyer has gone, so there is no one left to tell. Each model call is in the call log.
  if (i.signal?.aborted) return { runId, outcomes, summary: '' };
  if (!result.ok) {
    console.error(`[agent] Run ${runId} failed with ${[result.error, result.detail].filter(Boolean).join(': ')}`);
    i.onEvent({ type: 'error', message: FAILURES[result.error] });
    return { runId, outcomes, summary: '' };
  }
  const summary = summaryOf(result.value);
  i.onEvent({ type: 'done', summary });
  return { runId, outcomes, summary };
}
