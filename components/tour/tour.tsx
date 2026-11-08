'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Box, placeCard, type Size } from '@/lib/tour/place';
import { NO_PINS, type TourPins } from '@/lib/tour/pins';
import { LAST_INDEX, stepAt, targetFor } from '@/lib/tour/state';
import { TOUR_STEPS } from '@/lib/tour/steps';
import { TourCard } from './tour-card';
import { dispatchTour, useTourState } from './tour-store';

// The guided demo, mounted once in the root layout. For each step it switches the demo role if the
// step needs another one, opens the step's page, waits for the element to ring, and draws the dim,
// the ring and the card. It only shows: its only calls are GET /api/tour for the pinned ids and
// POST /api/session for the role, and it never presses a page's own buttons. When a grid's side
// panel is open, a native modal dialog that makes the rest of the page inert, it draws inside that
// dialog so the card stays usable. Anything it cannot find leaves the card up without a ring.

/** How long a step waits for its page and for the element to ring; the card shows meanwhile. */
const WAIT_MS = 30_000;
/** How long it waits for a pinned grid row before ringing the grid without scrolling to it. */
const ROW_WAIT_MS = 3_000;
const POLL_MS = 100;
/** The ring sits this far outside the element it rings. */
const RING_PAD = 6;

const here = () => `${location.pathname}${location.search}`;
const motion = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** Polls until `probe` gives a value, the time runs out, or the step is left. */
async function waitFor<T>(probe: () => T | null | false, ms: number, left: () => boolean): Promise<T | null> {
  const end = Date.now() + ms;
  while (!left()) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= end) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

/** The element carrying the anchor, preferring one inside an open side panel. */
function findAnchor(anchor: string): Element | null {
  const all = [...document.querySelectorAll(`[data-tour="${CSS.escape(anchor)}"]`)];
  const dialog = document.querySelector('dialog[open]');
  const shown = (element: Element) => {
    const { width, height } = element.getBoundingClientRect();
    return width > 0 && height > 0;
  };
  return (dialog && all.find((element) => dialog.contains(element) && shown(element))) || all.find(shown) || null;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

export function Tour() {
  const state = useTourState();
  const router = useRouter();
  const index = state?.index ?? null;
  const [pins, setPins] = useState<TourPins | null>(null);
  const [found, setFound] = useState<{ index: number; element: Element | null } | null>(null);
  const [ring, setRing] = useState<Box | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  const [card, setCard] = useState<Size>({ width: 416, height: 240 });
  const [view, setView] = useState<Size>({ width: 1440, height: 900 });
  const role = useRef<string | null>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const active = index !== null;
  const ringed = found !== null && found.index === index ? found.element : null;

  // The pinned ids, once per page load, while the tour is on.
  useEffect(() => {
    if (!active || pins !== null) return;
    let live = true;
    fetch('/api/tour', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (body: { pins?: TourPins } | null) => live && setPins(body?.pins ?? NO_PINS),
        () => live && setPins(NO_PINS),
      );
    return () => {
      live = false;
    };
  }, [active, pins]);

  // Each step: the role, the page, then the element to ring.
  useEffect(() => {
    if (index === null || pins === null) return;
    const step = stepAt(index);
    const target = targetFor(step, pins);
    let left = false;
    const gone = () => left;
    void (async () => {
      if (step.role !== null && role.current !== step.role) {
        try {
          const response = await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ persona: step.role }),
          });
          if (response.ok) role.current = step.role;
        } catch {
          // The page below then shows whatever the current role may see; the card still explains it.
        }
        if (left) return;
        if (here() === target.path) router.refresh();
      }
      if (here() !== target.path) router.push(target.path, { scroll: false });
      const arrived = await waitFor(() => here() === target.path, WAIT_MS, gone);
      if (target.rowId !== null && arrived) {
        const row = await waitFor(() => document.querySelector(`[row-id="${CSS.escape(target.rowId as string)}"]`), ROW_WAIT_MS, gone);
        row?.scrollIntoView({ block: 'center', behavior: motion() });
      }
      const element = target.anchor !== null && arrived ? await waitFor(() => findAnchor(target.anchor as string), WAIT_MS, gone) : null;
      if (left) return;
      if (element && target.rowId === null) {
        const tall = element.getBoundingClientRect().height > innerHeight * 0.6;
        element.scrollIntoView({ block: tall ? 'start' : 'center', behavior: motion() });
      }
      setFound({ index, element });
    })();
    return () => {
      left = true;
    };
  }, [index, pins, router]);

  // Follows the ringed element, the card's size, the window and any open side panel, every frame.
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = () => {
      const rect = ringed?.isConnected ? ringed.getBoundingClientRect() : null;
      const next = rect && { top: rect.top - RING_PAD, left: rect.left - RING_PAD, width: rect.width + 2 * RING_PAD, height: rect.height + 2 * RING_PAD };
      setRing((previous) => (sameBox(previous, next) ? previous : next));
      const dialog = document.querySelector('dialog[open]') ?? document.body;
      setHost((previous) => (previous === dialog ? previous : dialog));
      const box = cardBox.current?.getBoundingClientRect();
      if (box) setCard((previous) => (previous.width === box.width && previous.height === box.height ? previous : { width: box.width, height: box.height }));
      setView((previous) => (previous.width === innerWidth && previous.height === innerHeight ? previous : { width: innerWidth, height: innerHeight }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, ringed]);

  // The card's main button takes focus on each step, without scrolling the page.
  useEffect(() => {
    if (index !== null) primary.current?.focus({ preventScroll: true });
  }, [index, host]);

  // Escape closes the tour, unless a side panel is open: then Escape closes the panel.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) dispatchTour('close');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [active]);

  if (index === null || host === null) return null;
  const step = stepAt(index);
  const missing = pins !== null && targetFor(step, pins).missing;
  const placement = placeCard(ring, card, view);

  return createPortal(
    <>
      {ring && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[2147483000] rounded-[14px] outline-2 outline-text/90"
          style={{
            top: ring.top,
            left: ring.left,
            width: ring.width,
            height: ring.height,
            outlineStyle: 'solid',
            boxShadow: '0 0 0 9px rgb(237 237 239 / 0.08), 0 0 0 200vmax rgb(0 0 0 / 0.55)',
          }}
        />
      )}
      <div
        ref={cardBox}
        className="fixed z-[2147483001]"
        style={placement === 'docked' ? { left: 16, right: 16, bottom: 16 } : { top: placement.top, left: placement.left }}
      >
        <TourCard
          ref={primary}
          step={step}
          index={index}
          total={TOUR_STEPS.length}
          missing={missing}
          className={placement === 'docked' ? 'w-full' : ''}
          onBack={() => dispatchTour('back')}
          onNext={() => dispatchTour(index >= LAST_INDEX ? 'close' : 'next')}
          onClose={() => dispatchTour('close')}
        />
      </div>
    </>,
    host,
  );
}
