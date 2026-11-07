'use client';

import { useEffect, useState } from 'react';
import { SpotlightNavbar } from '@/components/vui/spotlight-navbar';

// The home page's sections in the top bar. The glow sits under the section being read: the last one
// whose top has passed 40 percent of the window, and none while the hero is in view.

const SECTIONS = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#security', label: 'Security' },
  { href: '#receipt', label: 'Receipts' },
  { href: '#faq', label: 'FAQ' },
] as const;

function sectionInView(): number | null {
  const line = window.innerHeight * 0.4;
  let current: number | null = null;
  SECTIONS.forEach(({ href }, index) => {
    const section = document.getElementById(href.slice(1));
    if (section && section.getBoundingClientRect().top <= line) current = index;
  });
  return current;
}

export function SiteNav() {
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setActive(sectionInView()));
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return <SpotlightNavbar label="On this page" items={SECTIONS} activeIndex={active} />;
}
