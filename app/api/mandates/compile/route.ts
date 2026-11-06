import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { llmDeps } from '@/lib/app-deps';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { compileMandate, type CompileResult } from '@/lib/mandate/compile';
import { confirmToken } from '@/lib/mandate/confirm-token';
import { isDeclineAnswer, withDeclineOption } from '@/lib/mandate/decline';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Compiles the buyer's mandate, with their answers to the questions an earlier compile asked, into a
// policy and the readback rendered from it. Only a compile that leaves no question open comes with
// a confirm token, and the confirm route signs nothing without one.

const ROUTE = 'mandate_compile';

const MAX_TEXT_LENGTH = 2_000;
const MAX_ANSWER_LENGTH = 500;
const MAX_ANSWERS = 20;
/** A question id as the compiler writes them, in snake_case, so an answer line holds no line break. */
const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

const NOT_JSON = 'Send the mandate as JSON.';
const UNKNOWN_QUESTION = 'Each answer must name a question Behest asked.';
const SHORT_ANSWER = 'Each answer must be short text.';
const ONE_LINE = 'Each answer must be one line.';

const Text = z
  .string({ error: 'Write your mandate first.' })
  .max(MAX_TEXT_LENGTH, { error: 'Keep your mandate under 2,000 characters.' })
  .refine((text) => text.trim() !== '', { error: 'Write your mandate first.' });

/**
 * One answer. It goes to the compiler as one `id: answer` line inside the <answers> block, so a line
 * break, even a trailing one, could add a line or close the block.
 */
const Answer = z
  .string({ error: SHORT_ANSWER })
  .regex(/^[^\r\n]*$/, { error: ONE_LINE })
  .trim()
  .min(1, { error: SHORT_ANSWER })
  .max(MAX_ANSWER_LENGTH, { error: SHORT_ANSWER });

/** Answers keyed by question id. */
const Answers = z.record(z.string(), Answer, { error: UNKNOWN_QUESTION }).refine(
  (answers) => {
    const ids = Object.keys(answers);
    return ids.length <= MAX_ANSWERS && ids.every((id) => QUESTION_ID.test(id));
  },
  { error: UNKNOWN_QUESTION },
);

const CompileRequest = z.object({ text: Text, answers: Answers.optional() }, { error: NOT_JSON });

type CompileFailure = Extract<CompileResult, { ok: false }>['error'];

const TRY_AGAIN = 'Compiling the mandate failed. Try again.';

/** The status and buyer-facing message for each way a compile fails. Nothing about the model call reaches the buyer. */
const FAILURES: Record<CompileFailure, [status: number, message: string]> = {
  invalid_policy: [
    422,
    'Behest could not turn this into a mandate it can enforce. Amounts must be in US dollars. Try rewording it.',
  ],
  refusal: [422, 'This mandate could not be compiled. Try rewording it.'],
  invalid_output: [502, TRY_AGAIN],
  max_tokens: [502, TRY_AGAIN],
  api_error: [502, TRY_AGAIN],
  spend_cap: [503, "Behest has used today's budget for model calls. Try again tomorrow."],
};

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** `POST { text, answers? }`: the compiled policy, readback, assumptions and questions, and a confirm token once no question is open. */
export async function POST(request: NextRequest) {
  // Logs the model call to the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'buyer');
  if (refusal) return refusal;
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:buyer`, MODEL_ROUTE_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }

  const raw = await readBody(request, FORM_BODY_BYTES);
  if (raw === null) return error(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, NOT_JSON);
  }
  const parsed = CompileRequest.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0].message);
  const { text, answers = {} } = parsed.data;
  // A decline ends the flow on the page. Compiled as an answer it could drop the limit the buyer wanted.
  if (Object.values(answers).some(isDeclineAnswer)) {
    return error(400, 'You chose not to set up this mandate, so it was not compiled.');
  }

  const result = await compileMandate(llmDeps(), text, answers);
  if (!result.ok) {
    const [status, message] = FAILURES[result.error];
    return Response.json({ error: { code: result.error, message } }, { status });
  }
  if (result.questions.length > 0) {
    // The model words its decline option freely; the page recognises only the exact one.
    const questions = result.questions.map((question) => ({ ...question, options: withDeclineOption(question.options) }));
    return Response.json({ ...result, questions });
  }
  return Response.json({ ...result, confirmToken: confirmToken(text, result.policy) });
}
