// The one button style, as classes for a <button>, a <Link> or an <a>: primary for the action a page
// is for, secondary beside it, quiet for small actions in a row or a panel. Each has a visible focus
// ring in the action colour.

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'default' | 'small';

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:opacity-50';

const SIZES: Record<ButtonSize, string> = {
  default: 'h-9 px-4 text-body',
  small: 'h-7 px-2.5 text-meta',
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-action text-on-fill hover:bg-action-strong',
  secondary: 'border border-line-strong text-text hover:border-muted hover:bg-raised',
  quiet: 'text-action hover:bg-raised hover:text-action-strong',
};

/** The classes of a button in `variant` and `size`, followed by any `extra` classes. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'default', extra = ''): string {
  return [BASE, SIZES[size], VARIANTS[variant], extra].filter(Boolean).join(' ');
}
