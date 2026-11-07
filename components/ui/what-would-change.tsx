import type { ChangeView } from '@/lib/buyer-pages/what-would-change';

// What would have let a held or blocked purchase through, in the buyer's words: approving it at
// PayPal, the smallest mandate changes, or why no change to the mandate can allow it.

/** The sentence before the list of changes. */
function lead(approve: boolean, together: boolean, count: number): string {
  const what = together
    ? 'these changes to your mandate together'
    : count === 1
      ? 'this change to your mandate'
      : 'one of these changes to your mandate';
  const sentence = `${approve ? 'or ' : ''}${what} would have let it through:`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const box = 'rounded-control border border-line bg-bg/40 px-3 py-2.5 text-body';

export function WhatWouldChange({ change }: { change: ChangeView | null }) {
  if (!change || change.kind === 'allowed') return null;

  if (change.kind === 'cannot') {
    return (
      <div className={box}>
        <p className="text-meta text-muted">What would change</p>
        <p className="mt-1 text-text">This one cannot be allowed by changing your mandate.</p>
        <p className="mt-0.5 text-muted">{change.reason}</p>
      </div>
    );
  }

  const { approve, together, changes } = change;
  const stillAsks = changes.some((c) => c.outcome === 'ASK');
  return (
    <div className={box}>
      <p className="text-meta text-muted">What would change</p>
      {approve && <p className="mt-1 text-text">Approve this one at PayPal.</p>}
      {changes.length > 0 && (
        <>
          <p className={`${approve ? 'mt-1.5' : 'mt-1'} text-muted`}>{lead(approve, together, changes.length)}</p>
          <ul className="mt-1 grid list-disc gap-0.5 pl-4 text-text marker:text-muted">
            {changes.map((c) => (
              <li key={c.text}>{c.text}</li>
            ))}
          </ul>
          {stillAsks && <p className="mt-1 text-muted">It would then still need your approval.</p>}
        </>
      )}
      {!approve && changes.length === 0 && <p className="mt-1 text-muted">No change to your mandate alone would allow it.</p>}
    </div>
  );
}
