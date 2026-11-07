'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui/button';
import { Console, type ConsoleRow } from '@/components/ui/console';
import { textLink } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { ProposalCard } from '@/components/purchase/proposal-card';
import { type AgentEvent, readAgentEvents, type RunOutcome } from '@/lib/buyer-pages/agent-events';
import type { PurchaseDetail } from '@/lib/buyer-pages/detail';
import { aboutMandate, runRefusal, toolArgs, toolStep } from '@/lib/buyer-pages/words';

// The buyer asks the shopping agent for something and follows its run in a console: each tool call
// the agent makes, as the call and in plain words; each purchase it proposes, as a card whose
// authority trace fills in once Behest has decided it; and its closing summary. A proposal's card
// appears as soon as the agent proposes it and fills in when the decision arrives. One run at a
// time; leaving the page stops the stream. Tool inputs and the summary are the agent's, and reasons
// may quote what a seller wrote, so everything here is shown as text.

const PLACEHOLDER = 'Restock turmeric and cumin, one jar of each';

/**
 * Requests the demo seller's catalog (lib/demo/ravi-spices.csv) can answer under the demo mandate:
 * two the agent may pay for alone, and a $40 gift box that waits for the buyer's approval.
 */
const EXAMPLES = [PLACEHOLDER, 'A 1 kg bag of basmati rice', 'A spice gift box for a friend who cooks'];

const UNREACHABLE = 'Could not reach Behest. Check your connection and try again.';
const CUT_OFF = 'The connection closed before your agent finished.';


/** Why a run did not end with the agent's own word: refused, unreachable or cut off. */
type Problem = { text: string; kind: 'refused' | 'session' | 'unreachable' | 'cut_off' };

/** One line of the console: an event as it arrived, or a proposal waiting for its decision. */
type Line =
  | { id: number; at: Date; event: Exclude<AgentEvent, { type: 'proposal' }> }
  | { id: number; at: Date; event: { type: 'proposal'; outcome: RunOutcome | null; view: PurchaseDetail | null } };

/** The console's lines with `event` added: a proposal fills the card its tool call opened. */
function withEvent(lines: Line[], event: AgentEvent, nextId: () => number): Line[] {
  const at = new Date();
  if (event.type === 'proposal') {
    const index = lines.findLastIndex((line) => line.event.type === 'proposal' && line.event.outcome === null);
    const filled: Line = {
      id: index === -1 ? nextId() : lines[index].id,
      at: index === -1 ? at : lines[index].at,
      event: { type: 'proposal', outcome: event.outcome, view: event.view ?? null },
    };
    return index === -1 ? [...lines, filled] : lines.map((line, i) => (i === index ? filled : line));
  }
  const added: Line[] = [{ id: nextId(), at, event }];
  if (event.type === 'tool' && event.name === 'propose_purchase') {
    added.push({ id: nextId(), at, event: { type: 'proposal', outcome: null, view: null } });
  }
  return [...lines, ...added];
}

function consoleRow({ id, at, event }: Line): ConsoleRow {
  const key = String(id);
  switch (event.type) {
    case 'status':
      return { id: key, at, kind: 'status', body: event.text };
    case 'tool': {
      const args = toolArgs(event.input);
      return {
        id: key,
        at,
        kind: 'tool',
        label: event.name,
        body: args || 'no arguments',
        detail: <p className="font-sans text-meta break-words text-muted">{toolStep(event.name, event.input)}</p>,
      };
    }
    case 'proposal':
      return { id: key, at, kind: 'proposal', label: 'Proposal', wide: true, body: <ProposalCard outcome={event.outcome} view={event.view} /> };
    case 'done':
      return { id: key, at, kind: 'summary', label: 'Summary', body: <p className="whitespace-pre-line">{event.summary}</p> };
    case 'error':
      return {
        id: key,
        at,
        kind: 'error',
        label: 'Error',
        body: (
          <p>
            {event.message}{' '}
            {aboutMandate(event.message) && (
              <Link href="/buyer" className={textLink}>
                Go to your mandate
              </Link>
            )}
          </p>
        ),
      };
  }
}

export function ShopRun() {
  const [request, setRequest] = useState('');
  const [asked, setAsked] = useState('');
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  /** Aborts the run's request; held so that leaving the page stops the stream. */
  const run = useRef<AbortController | null>(null);
  const requestBox = useRef<HTMLTextAreaElement>(null);
  const lastId = useRef(0);
  const nextId = () => ++lastId.current;

  useEffect(() => () => run.current?.abort(), []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (run.current || request.trim() === '') return;
    const controller = new AbortController();
    run.current = controller;
    setRunning(true);
    setLines([]);
    setAsked(request.trim());
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
        setLines((current) => withEvent(current, step, nextId));
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
    <div className="grid gap-6">
      {/* A command bar: the request, a line on what happens to it, and the button that sends the agent. */}
      <form onSubmit={start} className="grid gap-2.5">
        <label htmlFor="shop-request" className="text-body font-medium text-text">
          What should your agent buy?
        </label>
        <div className="rounded-frame border border-control bg-surface transition-colors focus-within:border-text hover:border-muted has-[textarea:disabled]:opacity-70">
          <textarea
            ref={requestBox}
            id="shop-request"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            disabled={running}
            rows={2}
            maxLength={2000}
            placeholder={PLACEHOLDER}
            className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-body text-text placeholder:text-muted focus-visible:outline-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-1 pb-3 sm:pr-3">
            <p className="text-meta text-muted">Each purchase it proposes is checked against your mandate before anything is paid.</p>
            <button type="submit" disabled={running || request.trim() === ''} className={buttonClass('primary', 'small')}>
              {running ? 'Your agent is shopping...' : 'Send your agent'}
            </button>
          </div>
        </div>
      </form>

      {problem && (
        <Notice kind="stop">
          {problem.text}
          {problem.kind === 'session' && (
            <>
              {' '}
              <Link href="/" className={textLink}>
                Go to the home page
              </Link>
            </>
          )}
          {problem.kind === 'cut_off' && (
            <>
              {' '}
              Any purchase it made is in{' '}
              <Link href="/buyer/ledger" className={textLink}>
                your ledger
              </Link>
              .
            </>
          )}
        </Notice>
      )}

      <Console
        label="Your agent's run"
        // Only as tall as its rows once a run starts; idle, as tall as its one line and examples.
        className={lines.length > 0 || running ? 'min-h-64' : undefined}
        live
        header={
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-meta">
            <p className="min-w-0 text-muted">
              {asked ? (
                <>
                  Request <span className="break-words text-text">{asked}</span>
                </>
              ) : (
                'Agent run'
              )}
            </p>
            <p className="flex items-center gap-1.5 text-muted">
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${running ? 'bg-seal motion-safe:animate-trace-pulse' : lines.length > 0 ? 'bg-muted' : 'bg-faint'}`}
              />
              {running ? 'Running' : lines.length > 0 ? 'Finished' : 'Idle'}
            </p>
          </div>
        }
        empty={
          <div className="grid justify-items-center gap-4">
            <p>Your agent&apos;s searches and proposals appear here, each with its trace. Try one:</p>
            <ul aria-label="Example requests" className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => {
                      setRequest(example);
                      requestBox.current?.focus();
                    }}
                    className="rounded-full border border-control px-3.5 py-1.5 text-meta text-text transition-colors hover:border-muted hover:bg-raised disabled:opacity-50"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        }
        rows={lines.map(consoleRow)}
      />
    </div>
  );
}
