'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { buttonClass } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { MandatePolicy } from '@/lib/domain/policy';
import { isDeclineAnswer } from '@/lib/mandate/decline';
import { MandateActions } from './mandate-actions';
import { SignWithPasskey } from './passkey-sign';
import { post, type RequestFailed, type Signed } from './requests';

// The buyer writes a mandate, Behest reads back the policy compiled from it, the buyer answers any
// open questions until none is left, then confirms, which signs the mandate, and links PayPal unless
// a wallet is already linked. The buyer can also confirm with a passkey registered to their account
// signing the mandate.
// Answers from every round are sent again with each compile, which keeps no state between calls.
// The readback reads as a draft until it is signed; the signing actions sit in MandateActions.

type Question = { id: string; question: string; options: string[] };

type Compiled = {
  policy: MandatePolicy;
  readback: string[];
  assumptions: string[];
  questions: Question[];
  /** Present only when no question is open: the confirm route needs it to sign. */
  confirmToken?: string;
};

/** The question the compiler asks when the buyer gave no amount. Its draft budget is a placeholder. */
const BUDGET_QUESTION = 'budget_amount';

const PLACEHOLDER = '$60 a month on groceries and spices, ask me above $25, never electronics';

const primaryButton = buttonClass('primary');
const secondaryButton = buttonClass('secondary');

export function MandateForm({ replacing }: { replacing: boolean }) {
  const router = useRouter();
  const [text, setText] = useState('');
  /** The last compile and the exact text it compiled, which a confirm must send back unchanged. */
  const [compiled, setCompiled] = useState<{ text: string; result: Compiled } | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [declined, setDeclined] = useState(false);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [busy, setBusy] = useState<'compile' | 'confirm' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const questions = compiled?.result.questions ?? [];
  const budgetPending = questions.some((q) => q.id === BUDGET_QUESTION);
  const allAnswered = questions.every((q) => (answers[q.id] ?? '').trim() !== '');
  const confirmToken = questions.length === 0 ? compiled?.result.confirmToken : undefined;

  function startOver() {
    setCompiled(null);
    setAnswers({});
    setDeclined(false);
    setSigned(null);
    setError(null);
  }

  async function compile(withAnswers: Record<string, string>) {
    // A decline ends here: it is never sent to the compiler.
    if (Object.values(withAnswers).some(isDeclineAnswer)) {
      setDeclined(true);
      return;
    }
    setBusy('compile');
    setError(null);
    try {
      const result = await post<Compiled>('/api/mandates/compile', { text, answers: withAnswers });
      setCompiled({ text, result });
      setAnswers(withAnswers);
    } catch (failure) {
      setError((failure as RequestFailed).message);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!compiled || !confirmToken) return;
    setBusy('confirm');
    setError(null);
    try {
      const body = { text: compiled.text, policy: compiled.result.policy, confirmToken };
      setSigned(await post<Signed>('/api/mandates/confirm', body));
      // Shows the new mandate as the active one above, with the wallet that pays within it.
      router.refresh();
    } catch (failure) {
      setError((failure as RequestFailed).message);
      // A 502 means the mandate was signed, replacing the old one, before PayPal failed.
      if ((failure as RequestFailed).status === 502) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function choose(question: Question, option: string) {
    if (isDeclineAnswer(option)) setDeclined(true);
    else setAnswers({ ...answers, [question.id]: option });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startOver();
    void compile({});
  }

  if (declined) {
    return (
      <div className="mt-4 grid gap-3">
        <Notice kind="info" title="You chose not to set up this mandate.">
          Nothing was signed. You can reword it and try again.
        </Notice>
        <button type="button" onClick={startOver} className={`justify-self-start ${secondaryButton}`}>
          Edit your mandate
        </button>
      </div>
    );
  }

  if (signed) {
    return (
      <div className="mt-4 grid gap-3">
        <Notice kind="success" title="Your mandate is signed.">
          {signed.approveUrl === null
            ? 'Your linked PayPal wallet pays within it, as shown above.'
            : 'Link your PayPal wallet so your agent can pay within it. You approve this at PayPal, then come back here.'}
        </Notice>
        {signed.approveUrl !== null && (
          <a href={signed.approveUrl} className={`justify-self-start ${primaryButton}`}>
            Link PayPal
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <form onSubmit={onSubmit}>
        <label htmlFor="mandate-text" className="block font-medium text-text">
          {replacing ? 'Your new mandate' : 'Your mandate'}
        </label>
        <textarea
          id="mandate-text"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (compiled) startOver();
          }}
          disabled={busy !== null}
          rows={3}
          maxLength={2000}
          placeholder={PLACEHOLDER}
          className="mt-2 w-full rounded-control border border-line-strong bg-panel p-3 text-text placeholder:text-muted disabled:opacity-60"
        />
        <button type="submit" disabled={busy !== null || text.trim() === ''} className={`mt-3 ${primaryButton}`}>
          {busy === 'compile' && !compiled ? 'Reading it back...' : 'Read it back'}
        </button>
      </form>

      {error && (
        <Notice kind="stop" className="mt-4">
          {error}
        </Notice>
      )}

      {compiled && (
        <div className="mt-6 flex flex-col gap-6">
          <section aria-labelledby="readback-heading" className="rounded-panel border border-dashed border-line-strong bg-panel/60 p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 id="readback-heading" className="font-medium text-text">
                What your agent may do
              </h3>
              <span className="text-meta text-muted">Draft, not signed yet</span>
            </div>
            {budgetPending ? (
              <p className="mt-2 text-body text-hold">
                Pending: you have not said how much your agent may spend. Answer the question below and Behest reads
                back your mandate.
              </p>
            ) : (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-text marker:text-muted">
                {compiled.result.readback.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>

          {compiled.result.assumptions.length > 0 && (
            <section aria-labelledby="assumptions-heading">
              <h3 id="assumptions-heading" className="font-medium text-text">
                What Behest assumed
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-muted">
                {compiled.result.assumptions.map((assumption, index) => (
                  // The model writes these, so two could read the same.
                  <li key={index}>{assumption}</li>
                ))}
              </ul>
            </section>
          )}

          {questions.length > 0 && (
            <section aria-labelledby="questions-heading">
              <h3 id="questions-heading" className="font-medium text-text">
                Before you confirm
              </h3>
              <ul className="mt-2 flex flex-col gap-4">
                {questions.map((question) => (
                  <li key={question.id}>
                    <p className="text-text">{question.question}</p>
                    {/* Only the buyer can answer a question that offers nothing but to decline, such as an amount. */}
                    {question.options.every(isDeclineAnswer) && (
                      <input
                        type="text"
                        aria-label={question.question}
                        value={answers[question.id] ?? ''}
                        onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
                        disabled={busy !== null}
                        maxLength={500}
                        className="mt-2 w-full rounded-control border border-line-strong bg-panel px-3 py-2 text-text disabled:opacity-60"
                      />
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {question.options.map((option) => {
                        const chosen = answers[question.id] === option;
                        return (
                          <button
                            key={option}
                            type="button"
                            aria-pressed={chosen}
                            disabled={busy !== null}
                            onClick={() => choose(question, option)}
                            className={`rounded-control border px-3 py-1.5 text-body transition-colors disabled:opacity-60 ${
                              chosen
                                ? 'border-action bg-action/14 text-text'
                                : 'border-line-strong bg-panel text-text hover:border-muted hover:bg-raised'
                            }`}
                          >
                            {option}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void compile(answers)}
                disabled={busy !== null || !allAnswered}
                className={`mt-4 ${secondaryButton}`}
              >
                {busy === 'compile' ? 'Reading it back...' : 'Read it back with my answers'}
              </button>
            </section>
          )}

          <MandateActions
            onConfirm={() => void confirm()}
            confirming={busy === 'confirm'}
            disabled={busy !== null || !confirmToken}
            questionsOpen={questions.length > 0}
            passkey={
              <SignWithPasskey
                mandate={confirmToken ? { text: compiled.text, policy: compiled.result.policy, confirmToken } : null}
                disabled={busy !== null}
                className={secondaryButton}
                onStart={() => {
                  setBusy('passkey');
                  setError(null);
                }}
                onSigned={(result) => {
                  setBusy(null);
                  setSigned(result);
                  router.refresh();
                }}
                onFailed={(message, status) => {
                  setBusy(null);
                  setError(message);
                  // A 502 means the mandate was signed, replacing the old one, before PayPal failed.
                  if (status === 502) router.refresh();
                }}
              />
            }
          />
        </div>
      )}
    </div>
  );
}
