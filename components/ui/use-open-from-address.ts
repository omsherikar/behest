'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { OPEN_PARAM, rowToOpen, withoutOpen } from '@/lib/ui/open-from-address';

/**
 * The record whose side panel is open in a grid: one a click opened, or the one `?open=<id>` names.
 * Whenever the address changes what it names, the panel follows it, opening that record or closing
 * when it names none, so moving back and forth through links (as the guided demo does) shows the
 * right panel. Closing the panel drops `open` from the address, so a reload shows the plain page.
 */
export function useOpenFromAddress<Row extends { id: string }>(rows: readonly Row[]) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requested = params.get(OPEN_PARAM);
  const [open, setOpen] = useState<Row | null>(() => rowToOpen(rows, requested));
  const [lastRequested, setLastRequested] = useState(requested);

  // Adjusting state while rendering, as React recommends for following a changed input, so the
  // panel never shows the old record for a frame.
  if (requested !== lastRequested) {
    setLastRequested(requested);
    setOpen(rowToOpen(rows, requested));
  }

  function close() {
    setOpen(null);
    if (requested !== null) router.replace(`${pathname}${withoutOpen(params.toString())}`, { scroll: false });
  }

  return { open, setOpen, close };
}
