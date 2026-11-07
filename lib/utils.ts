import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge knows Tailwind's own scales, not ours. Without these, it reads `text-section` (a
// size) and `text-text` (a colour) as two colours and drops the first, and lets `rounded-frame` and
// `rounded-panel` both stand.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['meta', 'body', 'lead', 'heading', 'title', 'section', 'display'] }],
      rounded: [{ rounded: ['control', 'panel', 'frame'] }],
    },
  },
});

/** Joins class names and lets a later Tailwind class override an earlier one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
