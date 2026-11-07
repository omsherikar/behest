import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// A card whose border glows with a slowly turning gradient. Adapted from VengeanceUI's
// glow-border-card (https://www.vengenceui.com/r/glow-border-card.json): it sizes to its content,
// sits on the surface colour, and turns the three JWS colours by default, so the receipt's frame
// echoes its own segments. The turn is CSS only (the `glow-conic` utility in app/globals.css) and
// stops under reduced motion. Use it on one or two primary panels per page at most.

const JWS_COLOURS = ['var(--jws-header)', 'var(--jws-payload)', 'var(--jws-signature)', 'var(--jws-payload)'];

export function GlowBorderCard({
  children,
  className,
  colours = JWS_COLOURS,
  duration = 10,
}: {
  children: ReactNode;
  className?: string;
  /** Four colours the gradient turns through. */
  colours?: readonly [string, string, string, string] | readonly string[];
  /** Seconds per turn. */
  duration?: number;
}) {
  const style = {
    '--glow-animation-duration': `${duration}s`,
    ...Object.fromEntries(colours.slice(0, 4).map((colour, index) => [`--glow-color-${index + 1}`, colour])),
  } as CSSProperties;

  return (
    <div className={cn('relative isolate rounded-frame', className)} style={style}>
      {/* A soft halo outside the edge, then the crisp 1 px ring on it. */}
      <div aria-hidden className="glow-conic pointer-events-none absolute -inset-1 -z-10 rounded-[inherit] border-[6px] opacity-45 blur-md" />
      <div aria-hidden className="glow-conic pointer-events-none absolute -inset-px -z-10 rounded-[inherit] border opacity-100" />
      <div className="relative h-full rounded-[inherit] bg-surface">{children}</div>
    </div>
  );
}
