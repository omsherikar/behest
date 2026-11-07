// The one button style, as classes for a <button>, a <Link> or an <a>. Every button is a pill:
// primary is white with black text, for the action a page is for; secondary is dark glass with a
// hairline, beside it; quiet is text on no fill, for small actions in a row or a panel. Each has the
// global focus ring.

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'default' | 'small' | 'large';

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed';

const SIZES: Record<ButtonSize, string> = {
  default: 'h-10 px-5 text-body',
  small: 'h-8 px-3.5 text-meta',
  large: 'h-12 px-6 text-body',
};

const VARIANTS: Record<ButtonVariant, string> = {
  // Disabled, a primary button turns to the raised grey and keeps its label legible.
  primary: 'bg-text text-on-fill hover:bg-white disabled:bg-raised disabled:text-muted',
  secondary:
    'border border-line-strong bg-overlay text-text backdrop-blur-md hover:border-white/25 hover:bg-raised disabled:opacity-50 disabled:hover:bg-overlay',
  quiet: 'text-text hover:bg-white/[0.06] disabled:opacity-50 disabled:hover:bg-transparent',
};

/** The classes of a button in `variant` and `size`, followed by any `extra` classes. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'default', extra = ''): string {
  return [BASE, SIZES[size], VARIANTS[variant], extra].filter(Boolean).join(' ');
}
