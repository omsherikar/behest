'use client';

import { useState } from 'react';
import type { Cart } from '@/lib/domain/cart';
import { checkReceipt, type ReceiptCheck } from '@/lib/ui/receipt-check';
import { buttonClass } from './button';
import { StateGlyph } from './state-glyph';

// "Verify receipt": asks Behest's public verifier about the receipt against its cart and seller, in
// audit mode, and says what it answered. The answer is announced to screen readers.

export function VerifyReceipt({ jws, cart, sellerSlug }: { jws: string; cart: Cart; sellerSlug: string }) {
  const [check, setCheck] = useState<ReceiptCheck | 'checking' | null>(null);

  async function verify() {
    setCheck('checking');
    setCheck(await checkReceipt({ jws, cart, sellerSlug }));
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <button type="button" onClick={() => void verify()} disabled={check === 'checking'} className={buttonClass('secondary', 'small')}>
        {check === 'checking' ? 'Verifying...' : 'Verify receipt'}
      </button>
      <p role="status" className="text-meta">
        {check !== null && check !== 'checking' && (
          <span className={`inline-flex items-center gap-1.5 ${check.state === 'verified' ? 'text-seal' : check.state === 'rejected' ? 'text-stop' : 'text-muted'}`}>
            <StateGlyph shape={check.state === 'verified' ? 'filled' : check.state === 'rejected' ? 'crossed' : 'info'} className="size-3" />
            {check.state === 'verified'
              ? 'Verified: the signature, the seller, the cart and the amount all check out.'
              : check.state === 'rejected'
                ? check.reason
                : check.message}
          </span>
        )}
      </p>
    </div>
  );
}
