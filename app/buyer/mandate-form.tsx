'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import type { MandatePolicy } from '@/lib/domain/policy';
import { isDeclineAnswer } from '@/lib/mandate/decline';
import { SignWithPasskey } from './passkey-sign';
import { post, type RequestFailed, type Signed } from './requests';

// The buyer writes a mandate, Behest reads back the policy compiled from it, the buyer answers any
// open questions until none is left, then confirms, which signs the mandate, and links PayPal unless
// a wallet is already linked. The buyer can also confirm with a passkey registered to their account
// signing the mandate.
// Answers from every round are sent again with each compile, which keeps no state between calls.

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

const primaryButton =
  'inline-flex h-10 items-center justify-center rounded-full bg-pp-blue px-5 font-semibold text-white transition-colors hover:bg-pp-blue-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'inline-flex h-10 items-center justify-center rounded-full border border-pp-blue px-5 font-semibold text-pp-blue transition-colors hover:bg-pp-highlight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:cursor-not-allowed disabled:opacity-50';

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
      <div className="mt-4 rounded-xl border border-pp-border bg-pp-surface p-5">
        <p className="font-semibold text-pp-navy">You chose not to set up this mandate.</p>
        <p className="mt-1 text-sm text-pp-muted">Nothing was signed. You can reword it and try again.</p>
        <button type="button" onClick={startOver} className={`mt-4 ${secondaryButton}`}>
          Edit your mandate
        </button>
      </div>
    );
  }

  if (signed) {
    return (
      <div className="mt-4 rounded-xl border border-pp-border bg-pp-surface p-5">
        <p className="font-semibold text-pp-navy">Your mandate is signed.</p>
        {signed.approveUrl === null ? (
          <p className="mt-1 text-sm text-pp-muted">Your linked PayPal wallet pays within it, as shown above.</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-pp-muted">
              Link your PayPal wallet so your agent can pay within it. You approve this at PayPal, then come back here.
            </p>
            <a href={signed.approveUrl} className={`mt-4 ${primaryButton}`}>
              Link PayPal
            </a>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <form onSubmit={onSubmit}>
        <label htmlFor="mandate-text" className="block text-sm font-semibold text-pp-navy">
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
          className="mt-2 w-full rounded-xl border border-pp-border bg-pp-surface p-3 text-pp-ink placeholder:text-pp-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60"
        />
        <button type="submit" disabled={busy !== null || text.trim() === ''} className={`mt-3 ${primaryButton}`}>
          {busy === 'compile' && !compiled ? 'Reading it back...' : 'Read it back'}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-pp-danger">
          {error}
        </p>
      )}

      {compiled && (
        <div className="mt-6 flex flex-col gap-6">
          <section aria-labelledby="readback-heading" className="rounded-xl border border-pp-border bg-pp-surface p-5">
            <h3 id="readback-heading" className="font-semibold text-pp-navy">
              What your agent may do
            </h3>
            {budgetPending ? (
              <p className="mt-2 text-sm text-pp-warning">
                Pending: you have not said how much your agent may spend. Answer the question below and Behest reads
                back your mandate.
              </p>
            ) : (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-pp-ink">
                {compiled.result.readback.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>

          {compiled.result.assumptions.length > 0 && (
            <section aria-labelledby="assumptions-heading">
              <h3 id="assumptions-heading" className="font-semibold text-pp-navy">
                What Behest assumed
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-pp-muted">
                {compiled.result.assumptions.map((assumption, index) => (
                  // The model writes these, so two could read the same.
                  <li key={index}>{assumption}</li>
                ))}
              </ul>
            </section>
          )}

          {questions.length > 0 && (
            <section aria-labelledby="questions-heading">
              <h3 id="questions-heading" className="font-semibold text-pp-navy">
                Before you confirm
              </h3>
              <ul className="mt-2 flex flex-col gap-4">
                {questions.map((question) => (
                  <li key={question.id}>
                    <p className="text-pp-ink">{question.question}</p>
                    {/* Only the buyer can answer a question that offers nothing but to decline, such as an amount. */}
                    {question.options.every(isDeclineAnswer) && (
                      <input
                        type="text"
                        aria-label={question.question}
                        value={answers[question.id] ?? ''}
                        onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
                        disabled={busy !== null}
                        maxLength={500}
                        className="mt-2 w-full rounded-xl border border-pp-border bg-pp-surface px-3 py-2 text-pp-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60"
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
                            className={`rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60 ${
                              chosen
                                ? 'border-pp-blue bg-pp-highlight text-pp-blue-dark'
                                : 'border-pp-border bg-pp-surface text-pp-ink hover:border-pp-blue'
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

          <div>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => void confirm()} disabled={busy !== null || !confirmToken} className={primaryButton}>
                {busy === 'confirm' ? 'Signing...' : 'Confirm and sign'}
              </button>
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
            </div>
            {questions.length > 0 && (
              <p className="mt-2 text-sm text-pp-muted">Answer the questions above before you confirm.</p>
            )}
            <p className="mt-2 text-sm text-pp-muted">
              Signing with a passkey adds your passkey&apos;s signature over this exact mandate. Confirming without one rests
              on your signed-in session alone.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
