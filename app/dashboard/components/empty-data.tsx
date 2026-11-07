import type { Persona } from '@/lib/session';
import { InboxIcon } from './ui/icons';

// Shown in place of Studio when there is nothing to report on yet: no purchases, listings or mandates.
const NEXT_STEP: Record<Persona, { href: string; label: string }> = {
  buyer: { href: '/buyer', label: 'Write a mandate' },
  seller: { href: '/seller', label: 'List your products' },
  operator: { href: '/', label: 'Pick a persona' },
};

export function EmptyData({ persona }: { persona: Persona }) {
  const next = NEXT_STEP[persona];
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-pp-highlight text-pp-blue">
        <InboxIcon className="size-7" />
      </span>
      <h2 className="mt-4 text-xl font-semibold text-pp-navy">Nothing to report on yet</h2>
      <p className="mt-2 max-w-md text-[15px] text-pp-muted">
        Once a buyer signs a mandate or a seller lists products, every purchase the agent proposes shows up here with its
        verdict, its effect on the budget and its signed receipt.
      </p>
      <a
        href={next.href}
        className="mt-6 inline-flex h-10 items-center rounded-full bg-pp-blue px-5 font-semibold text-on-fill hover:bg-pp-blue-dark"
      >
        {next.label}
      </a>
    </div>
  );
}
