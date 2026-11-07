'use client';

import { animate, useReducedMotion } from 'framer-motion';
import { type ElementType, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// A pill of links lit from below: a soft light follows the pointer across it, and a short glow sits
// under the current item and glides to the next one when the current item changes. Adapted from
// VengeanceUI's spotlight-navbar (https://www.vengenceui.com/r/spotlight-navbar.json): dark only,
// real links instead of click handlers, the current item set by the caller, a sideways scroll when
// the items do not fit, and no glide under reduced motion.

export type SpotlightItem = {
  href: string;
  label: string;
  /** aria-current for the item: `page` for the page itself, `true` for a page inside its section. */
  current?: 'page' | 'true';
};

type Props = {
  items: readonly SpotlightItem[];
  /** The index of the current item, or null when none is current. */
  activeIndex: number | null;
  /** The nav's accessible name, such as "Buyer pages". */
  label: string;
  /** What renders each link: `a` by default, or a router link such as next/link. */
  link?: ElementType;
  className?: string;
};

/** The centre of item `index` inside the list, in pixels from its left edge. */
function centreOf(list: HTMLElement, index: number): number | null {
  const item = list.querySelector<HTMLElement>(`[data-index="${index}"]`);
  if (!item) return null;
  const box = item.getBoundingClientRect();
  return box.left - list.getBoundingClientRect().left + box.width / 2;
}

// Runs before paint in the browser, and is skipped on the server, where there is nothing to measure.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function SpotlightNavbar({ items, activeIndex, label, link: Link = 'a', className }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const reduceMotion = useReducedMotion();
  // Where the glow under the current item is, kept outside React so it can be animated directly.
  const glowX = useRef<number | null>(null);

  // The glow: placed at once the first time and when the layout changes, glided when the current item changes.
  useBrowserLayoutEffect(() => {
    const element = list.current;
    if (!element || activeIndex === null) return;
    const target = centreOf(element, activeIndex);
    if (target === null) return;
    const place = (x: number) => {
      glowX.current = x;
      element.style.setProperty('--ambience-x', `${x}px`);
    };
    if (glowX.current === null || reduceMotion) {
      place(target);
      return;
    }
    const controls = animate(glowX.current, target, { type: 'spring', stiffness: 200, damping: 20, onUpdate: place });
    return () => controls.stop();
  }, [activeIndex, reduceMotion]);

  // Fonts and window sizes move the items, so the glow follows the current item's new centre.
  useEffect(() => {
    const element = list.current;
    if (!element || activeIndex === null) return;
    const observer = new ResizeObserver(() => {
      const target = centreOf(element, activeIndex);
      if (target === null) return;
      glowX.current = target;
      element.style.setProperty('--ambience-x', `${target}px`);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeIndex]);

  return (
    <nav
      aria-label={label}
      className={cn(
        'relative h-11 max-w-full overflow-x-auto rounded-full border border-line bg-black/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] [scrollbar-width:none]',
        className,
      )}
    >
      <div
        ref={list}
        className="relative h-full w-max px-1.5"
        onPointerMove={(event) => {
          if (event.pointerType !== 'mouse') return;
          const box = event.currentTarget.getBoundingClientRect();
          event.currentTarget.style.setProperty('--spotlight-x', `${event.clientX - box.left}px`);
          setHovering(true);
        }}
        onPointerLeave={() => setHovering(false)}
      >
        {/* The light that follows the pointer. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 transition-opacity duration-300"
          style={{
            opacity: hovering ? 1 : 0,
            background: 'radial-gradient(120px circle at var(--spotlight-x) 100%, rgba(255,255,255,0.12) 0%, transparent 50%)',
          }}
        />
        {/* A faint wash under the current item, so it reads as lit. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 transition-opacity duration-300"
          style={{
            opacity: activeIndex === null ? 0 : 1,
            background: 'radial-gradient(48px 28px at var(--ambience-x) 100%, rgba(255,255,255,0.10) 0%, transparent 100%)',
          }}
        />
        {/* The glow under the current item. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 transition-opacity duration-300"
          style={{
            opacity: activeIndex === null ? 0 : 1,
            background: 'radial-gradient(60px circle at var(--ambience-x) 0%, rgba(255,255,255,1) 0%, transparent 100%)',
          }}
        />
        <ul className="relative flex h-full items-center">
          {items.map((item, index) => (
            <li key={item.href} className="flex h-full items-center">
              <Link
                href={item.href}
                data-index={index}
                aria-current={item.current}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-[0.875rem] font-medium whitespace-nowrap transition-colors duration-200 focus-visible:outline-offset-0',
                  index === activeIndex ? 'text-text' : 'text-muted hover:text-text',
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
