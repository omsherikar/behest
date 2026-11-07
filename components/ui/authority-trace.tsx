'use client';

import { type CSSProperties, type ReactNode, useId, useState } from 'react';
import { STATE_WORDS, STEP_NAMES, type StepState, type TraceStates, type TraceStep, TRACE_STEPS } from '@/lib/ui/trail';
import { STATE_SHAPES, STATE_TEXT, StateGlyph } from './state-glyph';

// The authority trace: the five steps that authorized a purchase, as one line of nodes joined by a
// rail, numbered because the order is the point. Each rail segment takes the colour of the step it
// leads into. A node with proof is a disclosure button that opens the proof under the trace (under
// the node itself when the trace is narrow and runs down the page); one node is open at a time.
//
// Motion: a node animates when its state changes after the first render, as when a streamed
// proposal moves on. `play` plays the five nodes and the rail in order once, for a demonstration.
// Both run only without reduced motion; with it, the trace is drawn still in its final state.

export type TraceProof = Partial<Record<TraceStep, ReactNode>>;

type Props = {
  states: TraceStates;
  /** What each step proves, such as the gate's rule results. A step without proof cannot be opened. */
  proof?: TraceProof;
  /** The trace's accessible name, such as "Authority trace of this purchase". */
  label?: string;
  /** The step whose proof is open at first. */
  defaultOpen?: TraceStep;
  /** Plays the nodes and the rail in order once when the trace first appears. */
  play?: boolean;
  className?: string;
};

/** How long the demonstration waits between one node and the next, in milliseconds. */
const PLAY_STEP_MS = 380;

const RAIL: Record<StepState, string> = {
  done: 'bg-seal',
  current: 'bg-text/70',
  held: 'bg-hold',
  stopped: 'bg-stop',
  // Not reached: a dashed line, drawn with a border instead of a fill.
  not_reached: 'border-dashed border-line-strong',
};

/** The steps whose state differs between two traces. */
function changedSteps(before: TraceStates, after: TraceStates): TraceStep[] {
  return TRACE_STEPS.filter((step) => before[step] !== after[step]);
}

export function AuthorityTrace({ states, proof = {}, label = 'Authority trace', defaultOpen, play = false, className = '' }: Props) {
  const id = useId();
  const [open, setOpen] = useState<TraceStep | null>(defaultOpen && proof[defaultOpen] !== undefined ? defaultOpen : null);

  // The states from the previous render, kept so a step animates only when its state changes.
  const [previous, setPrevious] = useState(states);
  const [changed, setChanged] = useState<readonly TraceStep[]>([]);
  if (changedSteps(previous, states).length > 0) {
    setChanged(changedSteps(previous, states));
    setPrevious(states);
  }

  return (
    // The trace runs across when it has room for five nodes side by side (42rem), and down the page
    // otherwise, whatever the window: in a narrow panel it reads down even on a wide screen.
    <div className={`@container ${className}`}>
      <ol aria-label={label} className="grid grid-cols-1 @2xl:grid-cols-5">
        {TRACE_STEPS.map((step, index) => {
          const state = states[step];
          const next = TRACE_STEPS[index + 1];
          const hasProof = proof[step] !== undefined;
          const isOpen = open === step;
          const buttonId = `${id}-${step}`;
          const panelId = `${id}-${step}-proof`;
          const delay = (offset: number): CSSProperties | undefined =>
            play ? { animationDelay: `${index * PLAY_STEP_MS + offset}ms` } : undefined;
  
          const node = (
            <>
              <span className="flex h-5 items-center @2xl:w-full">
                <span
                  // Changing the key restarts the arrival animation when this step's state changes.
                  key={state}
                  className={`${STATE_TEXT[state]} ${changed.includes(step) ? 'motion-safe:animate-trace-arrive' : ''} ${
                    play ? 'motion-safe:animate-trace-play' : ''
                  }`}
                  style={delay(0)}
                >
                  <StateGlyph shape={STATE_SHAPES[state]} pulse={state === 'current'} className="size-5" />
                </span>
                {next && (
                  <span aria-hidden className="relative mx-2 hidden h-0.5 flex-1 bg-line @2xl:block">
                    <span
                      className={`absolute inset-0 origin-left transition-colors duration-300 ${
                        states[next] === 'not_reached' ? `border-t-2 ${RAIL.not_reached}` : RAIL[states[next]]
                      } ${play ? 'motion-safe:animate-trace-rail-x' : ''}`}
                      style={delay(PLAY_STEP_MS * 0.55)}
                    />
                  </span>
                )}
              </span>
              <span className={`min-w-0 @2xl:pr-3 ${play ? 'motion-safe:animate-trace-play' : ''}`} style={delay(60)}>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-meta text-muted tabular-nums">{index + 1}</span>
                  <span
                    className={`font-medium ${state === 'not_reached' ? 'text-muted' : 'text-text'} ${
                      hasProof ? 'decoration-line-strong underline-offset-4 group-hover:underline' : ''
                    }`}
                  >
                    {STEP_NAMES[step]}
                  </span>
                  {hasProof && (
                    <svg viewBox="0 0 16 16" aria-hidden className={`size-3 self-center text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className={`block text-meta ${STATE_TEXT[state]}`}>{STATE_WORDS[state]}</span>
              </span>
            </>
          );
  
          const nodeClass = 'flex w-full items-start gap-3 py-2 text-left @2xl:row-start-1 @2xl:flex-col @2xl:gap-2';
  
          return (
            <li key={step} className="relative @2xl:contents">
              {hasProof ? (
                <button
                  id={buttonId}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpen(isOpen ? null : step)}
                  className={`group rounded-control ${nodeClass}`}
                >
                  {node}
                </button>
              ) : (
                <div className={nodeClass}>{node}</div>
              )}
  
              {next && (
                // The rail on a phone: from under this node down to the next one, beside any open proof.
                <span aria-hidden className="absolute top-8 bottom-0 left-[9px] w-0.5 bg-line @2xl:hidden">
                  <span
                    className={`absolute inset-0 origin-top transition-colors duration-300 ${
                      states[next] === 'not_reached' ? `border-l-2 ${RAIL.not_reached}` : RAIL[states[next]]
                    } ${play ? 'motion-safe:animate-trace-rail-y' : ''}`}
                    style={delay(PLAY_STEP_MS * 0.55)}
                  />
                </span>
              )}
  
              {hasProof && (
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  hidden={!isOpen}
                  className={`mb-2 ml-8 rounded-panel border border-line bg-raised p-3 text-body @2xl:col-span-5 @2xl:p-4 @2xl:row-start-2 @2xl:mt-2 @2xl:mb-0 @2xl:ml-0 ${
                    play && step === defaultOpen ? 'motion-safe:animate-trace-play' : ''
                  }`}
                  // When the trace plays, the proof open from the start arrives after the last node.
                  style={play && step === defaultOpen ? { animationDelay: `${TRACE_STEPS.length * PLAY_STEP_MS}ms` } : undefined}
                >
                  <p className="mb-3 flex items-center gap-2 text-meta text-muted">
                    <span className={STATE_TEXT[state]}>
                      <StateGlyph shape={STATE_SHAPES[state]} className="size-3" />
                    </span>
                    <span>
                      Step {index + 1}, {STEP_NAMES[step]}: {STATE_WORDS[state].toLowerCase()}
                    </span>
                  </p>
                  <div className="min-w-0">{proof[step]}</div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
