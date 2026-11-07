import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import results from '@/lib/security/results.json';
import {
  attackRows,
  type Cell,
  LAYERS,
  LIMITS,
  liveNote,
  PAPER,
  PURPOSE,
  readResults,
  type Shape,
  THREAT,
  type Tone,
} from '@/lib/security/view';

export const metadata: Metadata = {
  title: 'Security',
  description: PURPOSE,
};

// The public security page: the threat, one row per attack with each layer's outcome, and the
// limits. Every word comes from lib/security/view.ts and every result from lib/security/results.json,
// which `npm run attack:replay` writes; this file only lays them out. The page reads the design
// tokens as CSS variables (bg, panel, line, text, muted, stop, hold).

/**
 * The design tokens this page reads, at their values in docs/design.md. The shared shell defines
 * them for every page; until it is on this branch the page carries them itself. Remove at merge.
 */
const TOKENS = {
  '--bg': '#0a1220',
  '--panel': '#0f192c',
  '--line': '#22314c',
  '--text': '#e4ebf5',
  '--muted': '#8e9db8',
  '--action': '#5b9bff',
  '--seal': '#3fd0a1',
  '--hold': '#f4b95a',
  '--stop': '#ff7a7a',
} as CSSProperties;

const TONE_CLASSES: Record<Tone, string> = {
  stop: 'border-(--stop)/35 bg-(--stop)/12 text-(--stop)',
  hold: 'border-(--hold)/35 bg-(--hold)/12 text-(--hold)',
  muted: 'border-(--line) bg-(--panel) text-(--muted)',
};

/** A state's shape, drawn in the current text colour, so no state rests on colour alone. */
function Glyph({ shape }: { shape: Shape }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false" className="size-3 shrink-0">
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={shape === 'dashed' ? '2.6 2.3' : undefined}
      />
      {shape === 'half' && <path d="M8 1.75a6.25 6.25 0 0 0 0 12.5Z" fill="currentColor" />}
      {shape === 'crossed' && (
        <path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  );
}

function LayerCell({ cell }: { cell: Cell }) {
  const layer = LAYERS.find((l) => l.key === cell.layer);
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs text-(--muted) lg:sr-only">{layer?.name}</p>
      <span
        className={`inline-flex h-6 items-center gap-1.5 rounded border px-2 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[cell.tone]}`}
      >
        <Glyph shape={cell.shape} />
        {cell.state}
      </span>
      <p className="mt-1.5 text-sm text-(--muted)">{cell.detail}</p>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10 border-t border-(--line) pt-8">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function SecurityPage() {
  const file = readResults(results);
  const rows = attackRows(file);
  return (
    <main style={TOKENS} className="min-h-screen w-full bg-(--bg) text-(--text)">
      <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6 lg:py-14">
        <Link href="/" className="font-mono text-sm text-(--muted) hover:text-(--text)">
          behest
        </Link>
        <header className="mt-6 max-w-[75ch]">
          <h1 className="text-[1.375rem] font-semibold">Security</h1>
          <p className="mt-1 text-sm text-(--muted)">{PURPOSE}</p>
        </header>

        <Section id="threat" title="The threat">
          <p className="mt-3 max-w-[75ch] text-sm leading-6">{THREAT}</p>
          <p className="mt-3 max-w-[75ch] text-sm text-(--muted)">
            Source:{' '}
            <a href={PAPER.url} className="text-(--action) underline-offset-2 hover:underline" rel="noreferrer">
              {PAPER.title}
            </a>
            , {PAPER.authors}, {PAPER.id}.
          </p>
        </Section>

        <Section id="results" title="The attacks, layer by layer">
          <p className="mt-3 max-w-[75ch] text-sm text-(--muted)">{liveNote(file)}</p>
          <div className="mt-3 max-w-[75ch] text-sm text-(--muted)">
            <p>Every attack ran under the demo mandate:</p>
            <ul className="mt-1 list-disc pl-5">
              {file.mandate.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <div
            aria-hidden
            className="mt-8 hidden gap-6 border-b border-(--line) pb-3 text-xs text-(--muted) lg:grid lg:grid-cols-[minmax(0,15rem)_repeat(4,minmax(0,1fr))]"
          >
            <p>Attack</p>
            {LAYERS.map((layer) => (
              <p key={layer.key} title={layer.question}>
                {layer.name}
              </p>
            ))}
          </div>
          <ol className="mt-4 lg:mt-0">
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid gap-5 border-b border-(--line) py-6 sm:grid-cols-2 lg:grid-cols-[minmax(0,15rem)_repeat(4,minmax(0,1fr))] lg:gap-6"
              >
                <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                  <h3 className="font-medium">{row.name}</h3>
                  <p className="mt-1 text-sm text-(--muted)">{row.summary}</p>
                  <p className="mt-2 text-sm">{row.outcome}.</p>
                </div>
                {row.cells.map((cell) => (
                  <LayerCell key={cell.layer} cell={cell} />
                ))}
              </li>
            ))}
          </ol>

          <dl className="mt-6 grid max-w-[75ch] gap-3 text-sm sm:grid-cols-2">
            {LAYERS.map((layer) => (
              <div key={layer.key}>
                <dt className="font-medium">{layer.name}</dt>
                <dd className="text-(--muted)">{layer.question}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="limits" title="Limits">
          <ul className="mt-4 grid max-w-[75ch] gap-4">
            {LIMITS.map((limit) => (
              <li key={limit.title} className="text-sm">
                <p className="font-medium">{limit.title}</p>
                <p className="mt-1 text-(--muted)">{limit.detail}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="reproduce" title="Reproduce it">
          <p className="mt-3 max-w-[75ch] text-sm text-(--muted)">
            <code className="font-mono text-(--text)">npm run attack:replay</code> replays the first three layers offline,
            with no model and no network, and the tests in{' '}
            <code className="font-mono text-(--text)">tests/security</code> pin every result. The live column needs{' '}
            <code className="font-mono text-(--text)">ATTACK_LIVE=1</code> and makes paid model calls. The method and the
            full results are in <code className="font-mono text-(--text)">docs/security.md</code>.
          </p>
        </Section>
      </div>
    </main>
  );
}
