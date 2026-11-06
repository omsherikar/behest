import { z } from 'zod';
import { CATEGORIES } from '@/lib/domain/categories';
import { BudgetPeriod, MandatePolicy } from '@/lib/domain/policy';
import type { LlmDeps, LlmFailure } from '@/lib/llm/client';
import { callStructured } from '@/lib/llm/structured';
import { MANDATE_SYSTEM_PROMPT } from './prompts';
import { renderReadback } from './readback';

// Turns a buyer's plain-English mandate into a policy. The model drafts the policy; this code
// normalizes the expiry, validates the draft against MandatePolicy and renders the readback from
// the validated policy, so nothing the model writes reaches the buyer as the readback.

const category = z.enum(CATEGORIES);

/**
 * The policy as the model writes it: MandatePolicy's fields and types without its refinements, so a
 * reply that breaks a policy rule still parses and the rule is reported as an issue. The currency
 * is any code, so a mandate in another currency comes back as one rather than as a converted amount.
 */
const DraftPolicy = z.object({
  version: z.literal(1),
  currency: z.string(),
  budget: z.object({ amountCents: z.number().int(), period: BudgetPeriod }),
  perPurchaseMaxCents: z.number().int(),
  askAboveCents: z.number().int().nullable(),
  categories: z.object({ allow: z.array(category).nullable(), deny: z.array(category) }),
  merchants: z.object({ allow: z.array(z.string()).nullable(), deny: z.array(z.string()) }),
  velocity: z.object({ maxPurchases: z.number().int(), windowHours: z.number().int() }).nullable(),
  /** Any ISO datetime. An offset is accepted because the instant is converted to UTC before validation. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

export const CompileOutput = z.object({
  policy: DraftPolicy,
  assumptions: z.array(z.string()),
  questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.string()) })),
});
export type CompileOutput = z.infer<typeof CompileOutput>;

export type CompileResult =
  | {
      ok: true;
      policy: MandatePolicy;
      readback: string[];
      assumptions: string[];
      questions: CompileOutput['questions'];
    }
  | { ok: false; error: LlmFailure | 'invalid_policy'; issues?: string[] };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The expiry the gate enforces for the one the model wrote, in UTC. Any time in the last minute of
 * a UTC day becomes the last millisecond of that day, which the readback shows as the date alone.
 * Any other time is floored to its whole minute, never later, so normalizing never extends what
 * the mandate allows.
 */
function normalizeExpiry(expiresAt: string | null): string | null {
  if (expiresAt === null) return null;
  const time = new Date(expiresAt).getTime();
  // The draft schema only lets valid datetimes through; anything else is left for MandatePolicy to report.
  if (Number.isNaN(time)) return expiresAt;
  const intoDay = ((time % DAY_MS) + DAY_MS) % DAY_MS;
  const normalized = intoDay >= DAY_MS - MINUTE_MS ? time - intoDay + DAY_MS - 1 : time - (intoDay % MINUTE_MS);
  return new Date(normalized).toISOString();
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

/**
 * The user message: today's UTC date for relative dates, the buyer's text verbatim inside
 * <mandate>, and any answers inside <answers> as one `id: answer` line each.
 */
function userMessage(text: string, answers: Record<string, string>, now: Date): string {
  const today = `Today is ${WEEKDAY.format(now)}, ${now.toISOString().slice(0, 10)} (UTC).`;
  const parts = [today, `<mandate>\n${text}\n</mandate>`];
  const lines = Object.entries(answers).map(([id, answer]) => `${id}: ${answer}`);
  if (lines.length > 0) parts.push(`<answers>\n${lines.join('\n')}\n</answers>`);
  return parts.join('\n\n');
}

/**
 * Compiles a buyer's mandate, with their answers to earlier questions, into a validated policy and
 * its readback. A failed model call returns its failure; a draft that breaks a policy rule returns
 * `invalid_policy` with one `path: message` issue per broken rule.
 */
export async function compileMandate(
  deps: LlmDeps,
  text: string,
  answers: Record<string, string> = {},
): Promise<CompileResult> {
  const reply = await callStructured(deps, 'mandate_compile', {
    system: MANDATE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage(text, answers, deps.now()) }],
    schema: CompileOutput,
  });
  if (!reply.ok) return { ok: false, error: reply.error };

  const { policy: draft, assumptions, questions } = reply.value;
  const checked = MandatePolicy.safeParse({ ...draft, expiresAt: normalizeExpiry(draft.expiresAt) });
  if (!checked.success) {
    const issues = checked.error.issues.map(({ path, message }) =>
      path.length > 0 ? `${path.map(String).join('.')}: ${message}` : message,
    );
    return { ok: false, error: 'invalid_policy', issues };
  }

  const policy = checked.data;
  return { ok: true, policy, readback: renderReadback(policy), assumptions, questions };
}
