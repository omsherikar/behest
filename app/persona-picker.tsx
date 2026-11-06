'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Persona } from '@/lib/session';

const choices: { persona: Persona; label: string; detail: string; home: string }[] = [
  {
    persona: 'buyer',
    label: "I'm the buyer",
    detail: 'Write a mandate in plain words and let your agent shop inside it.',
    home: '/buyer',
  },
  {
    persona: 'seller',
    label: "I'm the seller",
    detail: 'List your products and accept orders that agents place for their buyers.',
    home: '/seller',
  },
  {
    persona: 'operator',
    label: "I'm the operator",
    detail: 'Handle disputes with evidence drawn from signed mandates and receipts.',
    home: '/ops/disputes',
  },
];

export function PersonaPicker() {
  const router = useRouter();
  const [pending, setPending] = useState<Persona | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(persona: Persona, home: string) {
    setPending(persona);
    setFailed(false);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona }),
      });
      if (!response.ok) throw new Error(`Session request failed with ${response.status}`);
      router.push(home);
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <div className="mt-8">
      <ul className="flex flex-col gap-3">
        {choices.map(({ persona, label, detail, home }) => (
          <li key={persona}>
            <button
              type="button"
              onClick={() => choose(persona, home)}
              disabled={pending !== null}
              className="w-full rounded-xl border border-pp-border bg-pp-surface p-4 text-left transition-colors hover:border-pp-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:cursor-wait disabled:opacity-60 sm:p-5"
            >
              <span className="block text-lg font-semibold text-pp-navy">
                {pending === persona ? 'Opening...' : label}
              </span>
              <span className="mt-1 block text-sm text-pp-muted">{detail}</span>
            </button>
          </li>
        ))}
      </ul>
      {failed && (
        <p role="alert" className="mt-4 text-sm text-pp-danger">
          Could not start that session. Please try again.
        </p>
      )}
    </div>
  );
}
