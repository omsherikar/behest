// The one style of a text field: an input, a textarea or a search box. Its border is the `control`
// token, about 3:1 on black, so the field's edge is visible to everyone; the global focus ring marks
// the field being typed in.

export const fieldClass =
  'w-full rounded-control border border-control bg-surface px-3.5 py-2.5 text-body text-text placeholder:text-muted transition-colors hover:border-muted disabled:opacity-60';
