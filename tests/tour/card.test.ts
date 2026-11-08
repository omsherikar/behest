import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TourCard } from '@/components/tour/tour-card';
import { LAST_INDEX, stepAt } from '@/lib/tour/state';
import { NOT_LOADED, TOUR_STEPS } from '@/lib/tour/steps';

// The guided demo's card as the server renders it: what a screen reader reads, and which buttons
// it offers on the first step, a middle step and the end card.

const noop = () => {};
const render = (index: number, missing = false) =>
  renderToStaticMarkup(
    createElement(TourCard, { step: stepAt(index), index, total: TOUR_STEPS.length, missing, onBack: noop, onNext: noop, onClose: noop }),
  );
const text = (html: string) =>
  html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
const button = (html: string, name: string) => new RegExp(`<button[^>]*>(?:\\s|<svg[\\s\\S]*?</svg>)*${name}(?:\\s|<svg[\\s\\S]*?</svg>)*</button>`).exec(html)?.[0] ?? null;

describe('TourCard', () => {
  it('names the role, the step and what it shows', () => {
    const html = render(4);
    expect(text(html)).toContain('Guided demo · Buyer');
    expect(text(html)).toContain('Step 5 of 14');
    expect(text(html)).toContain(TOUR_STEPS[4].title);
    expect(text(html)).toContain(TOUR_STEPS[4].body);
  });

  it('is a labelled dialog whose heading is the step title', () => {
    const html = render(4);
    const labelledBy = /role="dialog"[^>]*aria-labelledby="([^"]+)"|aria-labelledby="([^"]+)"[^>]*role="dialog"/.exec(html);
    const id = labelledBy?.[1] ?? labelledBy?.[2];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(new RegExp(`<h2[^>]*id="${id}"[^>]*>${TOUR_STEPS[4].title}</h2>`).test(html)).toBe(true);
  });

  it('offers Back, Next and a named close button', () => {
    const html = render(4);
    expect(button(html, 'Back')).not.toBeNull();
    expect(button(html, 'Next')).not.toBeNull();
    expect(html).toMatch(/<button[^>]*aria-label="Close the guided demo"/);
  });

  it('says just Guided demo on a step with no role, and cannot go back from the first step', () => {
    const html = render(0);
    expect(text(html)).toContain('Guided demo');
    expect(text(html)).not.toContain('Guided demo ·');
    expect(button(html, 'Back')).toMatch(/disabled=""/);
  });

  it('says when the record a step needs is not loaded', () => {
    expect(text(render(4, true))).toContain(NOT_LOADED);
    expect(text(render(4))).not.toContain(NOT_LOADED);
  });

  it('ends by handing over: no step count, a way to pick a role, and Finish', () => {
    const html = render(LAST_INDEX);
    expect(text(html)).toContain('Try it yourself');
    expect(text(html)).not.toMatch(/Step \d+ of/);
    expect(button(html, 'Back')).not.toBeNull();
    expect(button(html, 'Finish')).not.toBeNull();
    expect(button(html, 'Next')).toBeNull();
    expect(html).toMatch(/<a[^>]*href="\/#try"[^>]*>Pick a role<\/a>/);
  });
});
