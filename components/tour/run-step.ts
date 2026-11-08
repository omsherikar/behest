import type { Persona } from '@/lib/session';
import type { TourTarget } from '@/lib/tour/state';
import type { TourStep } from '@/lib/tour/steps';

// One step of the guided demo, with the browser passed in so it can be tested: switch to the
// step's role, open its page, bring the pinned row or the anchor into view, and give back the
// element to ring. The role is switched on every step that has one, never from memory: the judge
// may have changed it in the top bar or in another tab since, and a page opened under the wrong
// role sends them to the home page.

/** How long a step waits for its page and for the element to ring; the card shows meanwhile. */
export const WAIT_MS = 30_000;
/** How long it waits for a pinned grid row before ringing the grid without it. */
export const ROW_WAIT_MS = 3_000;

export type StepActions = {
  /** The current path and query. */
  here: () => string;
  switchRole: (role: Persona) => Promise<void>;
  push: (path: string) => void;
  refresh: () => void;
  /** Polls `probe` until it gives a value or the time runs out (or the step is left), then null. */
  waitFor: <T>(probe: () => T | null | false, ms: number) => Promise<T | null>;
  findRow: (id: string) => Element | null;
  findAnchor: (anchor: string) => Element | null;
  revealRow: (row: Element) => void;
  revealAnchor: (anchor: Element) => void;
};

/** Runs the step and returns the element to ring, or null; `gone` turns true once the judge moves on. */
export async function runStep(step: TourStep, target: TourTarget, actions: StepActions, gone: () => boolean): Promise<Element | null> {
  if (gone()) return null;
  if (step.role !== null) {
    await actions.switchRole(step.role);
    if (gone()) return null;
    if (actions.here() === target.path) actions.refresh();
  }
  if (actions.here() !== target.path) actions.push(target.path);
  const arrived = await actions.waitFor(() => actions.here() === target.path, WAIT_MS);
  if (!arrived || gone()) return null;

  let row: Element | null = null;
  if (target.rowId !== null) {
    const rowId = target.rowId;
    row = await actions.waitFor(() => actions.findRow(rowId), ROW_WAIT_MS);
    if (row) actions.revealRow(row);
  }
  if (target.anchor === null || gone()) return null;
  const anchor = target.anchor;
  const element = await actions.waitFor(() => actions.findAnchor(anchor), WAIT_MS);
  if (!element || gone()) return null;
  if (!row) actions.revealAnchor(element);
  return element;
}
