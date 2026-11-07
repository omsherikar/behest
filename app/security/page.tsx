import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { TopBar } from '@/components/shell/top-bar';
import { buttonClass } from '@/components/ui/button';
import { Figure, Figures } from '@/components/ui/figures';
import { textLink } from '@/components/ui/link';
import { PageHeader } from '@/components/ui/page-header';
import type { GlyphShape } from '@/components/ui/state-glyph';
import { StatusBadge } from '@/components/ui/status-badge';
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
} from '@/lib/security/view';

export const metadata: Metadata = {
  title: 'Security',
  description: PURPOSE,
};

// The public security page, in the app's frame: the replay's numbers, the threat, one row per attack
// with each layer's outcome as the app's own badges, the limits and how to reproduce it. Every word
// comes from lib/security/view.ts and every result from lib/security/results.json, which
// `npm run attack:replay` writes; this file only lays them out.

/** The replay's shapes as the app's glyphs: a plain circle for what went through, a dashed one for what did not run. */
const SHAPES: Record<Shape, GlyphShape> = { crossed: 'crossed', half: 'half', open: 'open', dashed: 'outlined' };

function LayerCell({ cell }: { cell: Cell }) {
  const layer = LAYERS.find((l) => l.key === cell.layer);
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-meta text-muted lg:sr-only">{layer?.name}</p>
      <StatusBadge tone={cell.tone} shape={SHAPES[cell.shape]} label={layer?.name}>
        {cell.state}
      </StatusBadge>
      <p className="mt-2 text-meta text-muted">{cell.detail}</p>
    </div>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-12 lg:mt-16">
      <h2 id={id} className="text-heading font-medium text-text">
        {title}
      </h2>
      {lead && <div className="mt-2 max-w-[68ch] text-body text-muted">{lead}</div>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-[0.92em] whitespace-nowrap text-text">{children}</code>;

export default function SecurityPage() {
  const file = readResults(results);
  const rows = attackRows(file);
  const live = file.live;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        end={
          <>
            <span className="hidden rounded-full border border-line px-3 py-1 text-meta text-muted sm:inline">PayPal sandbox</span>
            <Link href="/#try" className={buttonClass('primary', 'small')}>
              Try the demo
            </Link>
          </>
        }
      />
      <main id="content" className="flex-1">
        <div className="container-page py-8 lg:py-10">
          <PageHeader
            title="Security"
            purpose={PURPOSE}
            actions={
              <Link href="/" className={buttonClass('secondary')}>
                Back to the home page
              </Link>
            }
          />

          <Figures>
            <Figure label="Attacks replayed against every layer">{file.deterministic.length}</Figure>
            {live ? (
              <>
                <Figure label={`Stopped in the live run, out of ${live.results.length}`} tone="text-seal">
                  {live.results.filter((result) => result.state === 'stopped').length}
                </Figure>
                <Figure label="Model calls in the live run">{live.calls}</Figure>
                <Figure label="What the live run cost, estimated">${live.costUsd.toFixed(2)}</Figure>
              </>
            ) : (
              <Figure label="Live run against the model">Not run</Figure>
            )}
          </Figures>

          <Section id="threat" title="The threat">
            <div className="grid gap-6 lg:grid-cols-12">
              <p className="max-w-[68ch] text-lead text-pretty text-text lg:col-span-8">{THREAT}</p>
              <p className="text-body text-muted lg:col-span-4">
                Source:{' '}
                <a href={PAPER.url} className={textLink} rel="noreferrer">
                  {PAPER.title}
                </a>
                , {PAPER.authors}, <span className="font-mono text-meta">{PAPER.id}</span>.
              </p>
            </div>
          </Section>

          <Section
            id="results"
            title="The attacks, layer by layer"
            lead={
              <>
                <p>{liveNote(file)}</p>
                <p className="mt-3">Every attack ran under the demo mandate:</p>
                <ul className="mt-1 grid gap-0.5">
                  {file.mandate.map((line) => (
                    <li key={line} className="flex gap-2.5">
                      <span aria-hidden className="mt-2.5 size-1 shrink-0 rounded-full bg-muted" />
                      {line}
                    </li>
                  ))}
                </ul>
              </>
            }
          >
            <div className="panel overflow-hidden rounded-frame">
              <div
                aria-hidden
                className="hidden gap-6 border-b border-line bg-white/[0.02] px-6 py-3 text-meta text-muted lg:grid lg:grid-cols-[minmax(0,15rem)_repeat(4,minmax(0,1fr))]"
              >
                <p>Attack</p>
                {LAYERS.map((layer) => (
                  <p key={layer.key} title={layer.question}>
                    {layer.name}
                  </p>
                ))}
              </div>
              <ol className="divide-y divide-line">
                {rows.map((row) => (
                  <li key={row.id} className="grid gap-5 px-5 py-6 sm:grid-cols-2 sm:px-6 lg:grid-cols-[minmax(0,15rem)_repeat(4,minmax(0,1fr))] lg:gap-6">
                    <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                      <h3 className="font-medium text-text">{row.name}</h3>
                      <p className="mt-1 text-meta text-muted">{row.summary}</p>
                      <p className="mt-2 text-body text-text">{row.outcome}.</p>
                    </div>
                    {row.cells.map((cell) => (
                      <LayerCell key={cell.layer} cell={cell} />
                    ))}
                  </li>
                ))}
              </ol>
            </div>

            <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
              {LAYERS.map((layer) => (
                <div key={layer.key}>
                  <dt className="text-body font-medium text-text">{layer.name}</dt>
                  <dd className="mt-0.5 text-meta text-muted">{layer.question}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="limits" title="Limits">
            <ul className="grid gap-x-8 gap-y-6 md:grid-cols-2">
              {LIMITS.map((limit) => (
                <li key={limit.title} className="border-t border-line pt-4">
                  <p className="text-body font-medium text-text">{limit.title}</p>
                  <p className="mt-1 text-body text-muted">{limit.detail}</p>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="reproduce" title="Reproduce it">
            <p className="max-w-[68ch] text-body text-muted">
              <Code>npm run attack:replay</Code> replays the first three layers offline, with no model and no network, and the
              tests in <Code>tests/security</Code> pin every result. The live column needs <Code>ATTACK_LIVE=1</Code> and makes
              paid model calls. The method and the full results are in <Code>docs/security.md</Code>.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}
