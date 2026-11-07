import { AppShell } from '@/components/shell/app-shell';
import { buttonClass } from '@/components/ui/button';
import { Hero } from './_landing/hero';
import { BuiltOnPayPal, Footer, HowItWorks, InspectReceipt, Problem, SafetyModel, TryIt } from './_landing/sections';

// The home page: what Behest is and why, how a purchase is authorized, a real signed receipt to
// inspect, what it uses PayPal for, its safety model, and the persona choice that starts the demo.

function HeaderLinks() {
  return (
    <nav aria-label="On this page" className="flex items-center gap-1 sm:gap-2">
      <a href="#how-it-works" className="hidden rounded-control px-2 py-1 text-body text-muted hover:text-text sm:inline">
        How it works
      </a>
      <a href="#receipt" className="hidden rounded-control px-2 py-1 text-body text-muted hover:text-text md:inline">
        Inspect a receipt
      </a>
      <a href="#try" className={buttonClass('secondary', 'small', 'ml-1')}>
        Try the demo
      </a>
    </nav>
  );
}

export default function Home() {
  return (
    <AppShell bleed aside={<HeaderLinks />}>
      <div className="bg-schematic">
        <Hero />
        <Problem />
        <HowItWorks />
        <InspectReceipt />
        <BuiltOnPayPal />
        <SafetyModel />
        <TryIt />
        <Footer />
      </div>
    </AppShell>
  );
}
