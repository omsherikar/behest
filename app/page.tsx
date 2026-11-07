import { TopBar } from '@/components/shell/top-bar';
import { buttonClass } from '@/components/ui/button';
import { BuiltOnPayPal } from './_landing/built-on-paypal';
import { Faq } from './_landing/faq';
import { Footer, TryIt } from './_landing/footer';
import { Hero, HeroBackdrop } from './_landing/hero';
import { HowItWorks } from './_landing/how-it-works';
import { InspectReceipt } from './_landing/inspect-receipt';
import { ProductFrame } from './_landing/product-frame';
import { Security } from './_landing/security';
import { SiteNav } from './_landing/site-nav';

// The home page: what Behest is, the product itself in a frame, how a purchase is authorized, the
// attack replay, what it uses PayPal for, a real signed receipt to inspect, straight answers, and
// the persona choice that starts the demo.

function BarEnd() {
  return (
    <>
      <span className="hidden rounded-full border border-line px-3 py-1 text-meta text-muted sm:inline">PayPal sandbox</span>
      <a href="#try" className={buttonClass('primary', 'small')}>
        Try the demo
      </a>
    </>
  );
}

export default function Home() {
  return (
    <>
      <a
        href="#content"
        className="sr-only rounded-full bg-text px-4 py-2 font-medium text-on-fill focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50"
      >
        Skip to content
      </a>
      <TopBar fixed wideNavOnly nav={<SiteNav />} end={<BarEnd />} />
      <main id="content" tabIndex={-1} className="relative isolate focus:outline-none">
        <HeroBackdrop />
        <Hero />
        <ProductFrame />
        <div className="pt-10 lg:pt-12">
          <HowItWorks />
          <Security />
          <BuiltOnPayPal />
          <InspectReceipt />
          <Faq />
          <TryIt />
        </div>
      </main>
      <Footer />
    </>
  );
}
