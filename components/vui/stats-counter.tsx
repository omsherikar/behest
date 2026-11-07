'use client';

import { animate, useInView, useReducedMotion } from 'framer-motion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// A number that counts up from zero the first time it scrolls into view. Adapted from VengeanceUI's
// stats-counter (https://www.vengenceui.com/r/stats-counter.json). The server renders the final
// value, so it reads right without JavaScript; the count only plays for a number that starts below
// the fold, and never under reduced motion. A screen reader always gets the final value.

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function StatsCounter({
  value,
  format = (n) => Math.round(n).toLocaleString('en-US'),
  duration = 1.4,
  className,
}: {
  value: number;
  /** How a value is written, such as "$0.31". It is called for every frame of the count. */
  format?: (value: number) => string;
  /** Seconds the count takes. */
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState(value);
  const [armed, setArmed] = useState(false);

  // Before the first paint: a number still below the fold drops to zero, ready to count when it arrives.
  useBrowserLayoutEffect(() => {
    if (reduceMotion || !ref.current) return;
    if (ref.current.getBoundingClientRect().top > window.innerHeight) {
      setShown(0);
      setArmed(true);
    }
  }, [reduceMotion]);

  useEffect(() => {
    if (!armed || !inView) return;
    const controls = animate(0, value, { duration, ease: [0.22, 1, 0.36, 1], onUpdate: setShown });
    return () => controls.stop();
  }, [armed, inView, value, duration]);

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      <span className="sr-only">{format(value)}</span>
      <span aria-hidden>{format(shown)}</span>
    </span>
  );
}
