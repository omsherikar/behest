import { buttonClass } from '@/components/ui/button';
import { LightLines } from '@/components/vui/light-lines';

// The top of the home page, centred over the light lines: what Behest is for in two lines, one
// paragraph on how, the two ways in, and the one fact a visitor should know before trying it.

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative pt-36 pb-14 sm:pt-44 lg:pb-16">
      <div className="container-page flex flex-col items-center text-center">
        <p className="glass rounded-full px-3.5 py-1.5 text-meta font-medium text-muted">Built on PayPal</p>
        <h1 id="hero-title" className="mt-8 text-display font-medium text-balance text-text">
          <span className="block">Your AI agent pays.</span>
          <span className="block text-muted">You keep signed proof.</span>
        </h1>
        <p className="mt-7 max-w-[46rem] text-lead text-pretty text-muted sm:text-[1.1875rem] sm:leading-8">
          Behest checks each purchase against a mandate you signed, pays through PayPal only inside it, and signs a receipt
          any seller can verify.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a href="#try" className={buttonClass('primary', 'large')}>
            Try the live demo
          </a>
          <a href="/security" className={buttonClass('secondary', 'large')}>
            See the attack replay
          </a>
        </div>
        <p className="mt-5 flex items-center gap-1.5 text-meta text-muted">
          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 text-seal">
            <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          PayPal sandbox only. No real money moves.
        </p>
      </div>
    </section>
  );
}

/**
 * The hero's background: the light lines, fading out toward the product frame, with a dark pool
 * behind the headline so the lines never cross the words at full strength.
 */
export function HeroBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[min(100dvh,60rem)] min-h-[44rem] overflow-hidden">
      <LightLines className="text-white [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" />
      <div className="absolute inset-x-0 top-24 mx-auto h-[34rem] max-w-5xl bg-[radial-gradient(closest-side,rgba(0,0,0,0.88),transparent)]" />
    </div>
  );
}
