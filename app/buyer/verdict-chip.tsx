// Behest's verdict on a purchase as a coloured chip: ALLOW green, ASK amber, BLOCK red. It renders
// the same on the server and in the browser, so the shop timeline and the ledger grid share it.

type Verdict = 'ALLOW' | 'ASK' | 'BLOCK';

const COLOURS: Record<Verdict, string> = {
  ALLOW: 'bg-pp-success',
  ASK: 'bg-pp-warning',
  BLOCK: 'bg-pp-danger',
};

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs leading-5 font-semibold text-on-fill ${COLOURS[verdict]}`}>
      <span className="sr-only">Verdict: </span>
      {verdict}
    </span>
  );
}
