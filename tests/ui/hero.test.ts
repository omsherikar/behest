import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Hero } from '@/app/_landing/hero';

// The home page hero offers the guided demo first, then trying it yourself, then the attack replay.

it('offers the guided demo, trying it yourself and the attack replay, in that order', () => {
  const html = renderToStaticMarkup(createElement(Hero));
  const tour = html.search(/<button[^>]*>Take the guided demo · 3 min<\/button>/);
  const yourself = html.search(/<a[^>]*href="#try"[^>]*>Try it yourself<\/a>/);
  const replay = html.search(/<a[^>]*href="\/security"[^>]*>See the attack replay<\/a>/);
  expect(tour).toBeGreaterThan(-1);
  expect(yourself).toBeGreaterThan(tour);
  expect(replay).toBeGreaterThan(yourself);
});
