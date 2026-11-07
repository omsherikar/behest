'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Persona } from '@/lib/session';

/**
 * Switches the demo session to another persona: asks /api/session for its cookie, then opens the
 * persona's home page. `pending` is the persona being opened; `failed` is set when the session
 * could not be started, so the caller can say so.
 */
export function useSwitchPersona() {
  const router = useRouter();
  const [pending, setPending] = useState<Persona | null>(null);
  const [failed, setFailed] = useState(false);

  async function switchTo(persona: Persona, home: string) {
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

  return { switchTo, pending, failed };
}
