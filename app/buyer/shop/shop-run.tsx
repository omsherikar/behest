'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { type AgentEvent, type RunOutcome, readAgentEvents } from '@/lib/buyer-pages/agent-events';
import { aboutMandate, runRefusal, statusWords, toolStep } from '@/lib/buyer-pages/words';
import { VerdictBadge } from '@/components/ui/verdict-badge';

// The buyer asks the shopping agent for something and follows its run as a timeline: what it is
// doing, each purchase it proposed with Behest's verdict, the purchase's status and the reasons,
// and its closing summary. One run at a time; leaving the page stops the stream.
// Everything here is shown as text: tool inputs and the summary are the agent's, and reasons may
// quote what a seller wrote.

const PLACEHOLDER = 'Restock turmeric and cumin, one jar of each';

const UNREACHABLE = 'Could not reach Behest. Check your connection and try again.';
const CUT_OFF = 'The connection closed before your agent finished.';

const primaryButton =
  'inline-flex h-10 items-center justify-center rounded-full bg-pp-blue px-5 font-semibold text-on-fill transition-colors hover:bg-pp-blue-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:cursor-not-allowed disabled:opacity-50';
const textLink =
  'font-semibold text-pp-blue underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue';

/** Why a run did not end with the agent's own word: refused, unreachable or cut off. */
type Problem = { text: string; kind: 'refused' | 'session' | 'unreachable' | 'cut_off' };

export function ShopRun() {
  const [request, setRequest] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<AgentEvent[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  /** Aborts the run's request; held so that leaving the page stops the stream. */
  const run = useRef<AbortController | null>(null);

  useEffect(() => () => run.current?.abort(), []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (run.current || request.trim() === '') return;
    const controller = new AbortController();
    run.current = controller;
    setRunning(true);
    setSteps([]);
    setProblem(null);
    let answered = false;
    let ended = false;
    try {
      const response = await fetch('/api/agent/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request }),
        signal: controller.signal,
      });
      answered = true;
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => null);
        const session = response.status === 401 || response.status === 403;
        setProblem({ text: runRefusal(response.status, body), kind: session ? 'session' : 'refused' });
        return;
      }
      for await (const step of readAgentEvents(response.body)) {
        if (step.type === 'done' || step.type === 'error') ended = true;
        setSteps((current) => [...current, step]);
      }
      if (!ended) setProblem({ text: CUT_OFF, kind: 'cut_off' });
    } catch {
      // Leaving the page aborts the request on purpose: there is no one left to tell.
      if (controller.signal.aborted) return;
      if (!ended) setProblem(answered ? { text: CUT_OFF, kind: 'cut_off' } : { text: UNREACHABLE, kind: 'unreachable' });
    } finally {
      if (run.current === controller) run.current = null;
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  return (
    <div className="mt-6">
      <form onSubmit={start}>
        <label htmlFor="shop-request" className="block text-sm font-semibold text-pp-navy">
          What should your agent buy?
        </label>
        <textarea
          id="shop-request"
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          disabled={running}
          rows={3}
          maxLength={2000}
          placeholder={PLACEHOLDER}
          className="mt-2 w-full rounded-xl border border-line-strong bg-pp-surface p-3 text-pp-ink placeholder:text-pp-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60"
        />
        <button type="submit" disabled={running || request.trim() === ''} className={`mt-3 ${primaryButton}`}>
          {running ? 'Your agent is shopping...' : 'Send your agent'}
        </button>
      </form>

      {problem && (
        <div role="alert" className="mt-4 text-sm text-pp-danger">
          <p>{problem.text}</p>
          {problem.kind === 'session' && (
            <Link href="/" className={`mt-1 inline-block ${textLink}`}>
              Go to the home page
            </Link>
          )}
          {problem.kind === 'cut_off' && (
            <p className="mt-1 text-pp-ink">
              Any purchase it made is in{' '}
              <Link href="/buyer/ledger" className={textLink}>
                your ledger
              </Link>
              .
            </p>
          )}
        </div>
      )}

      {steps.length > 0 && (
        <section aria-labelledby="timeline-heading" className="mt-8">
          <h2 id="timeline-heading" className="text-lg font-semibold text-pp-navy">
            What your agent did
          </h2>
          <ol aria-live="polite" className="mt-3 flex flex-col gap-3">
            {steps.map((step, index) => (
              // The timeline only grows, so a step's place in it never changes.
              <TimelineStep key={index} step={step} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function TimelineStep({ step }: { step: AgentEvent }) {
  switch (step.type) {
    case 'status':
      return <li className="text-sm text-pp-muted">{step.text}</li>;
    case 'tool':
      return <li className="text-sm break-words text-pp-muted">{toolStep(step.name, step.input)}</li>;
    case 'proposal':
      return <Proposal outcome={step.outcome} />;
    case 'done':
      return (
        <li className="rounded-xl border border-pp-border bg-pp-surface p-4">
          <p className="text-sm font-semibold text-pp-navy">Your agent says</p>
          <p className="mt-1 break-words whitespace-pre-line">{step.summary}</p>
        </li>
      );
    case 'error':
      return (
        <li role="alert" className="text-sm text-pp-danger">
          <p>{step.message}</p>
          {aboutMandate(step.message) && (
            <Link href="/buyer" className={`mt-1 inline-block ${textLink}`}>
              Go to your mandate
            </Link>
          )}
        </li>
      );
  }
}

function Proposal({ outcome }: { outcome: RunOutcome }) {
  const waiting = outcome.verdict === 'ASK' && outcome.status === 'awaiting_approval';
  return (
    <li className="rounded-xl border border-pp-border bg-pp-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={outcome.verdict} />
        <span className="font-semibold text-pp-navy">{statusWords(outcome.status)}</span>
      </div>
      {outcome.reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm break-words">
          {outcome.reasons.map((reason, index) => (
            // Two reasons can read the same.
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      {waiting && (
        <Link href="/buyer/approvals" className={`mt-3 inline-block text-sm ${textLink}`}>
          Approve it on your approvals page
        </Link>
      )}
      {outcome.receiptId && (
        <p className="mt-2 text-xs break-all text-pp-muted">
          Receipt <span className="font-mono">{outcome.receiptId}</span>
        </p>
      )}
    </li>
  );
}
