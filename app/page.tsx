import { PersonaPicker } from './persona-picker';

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-12 font-paypal text-pp-ink sm:py-20">
      <h1 className="text-3xl font-semibold text-pp-navy">Behest</h1>
      <p className="mt-3 text-pp-muted">
        An AI agent shops for a buyer, but only inside a mandate the buyer signed. Pick who you are for this demo.
      </p>
      <PersonaPicker />
    </main>
  );
}
