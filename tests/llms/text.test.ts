import { describe, expect, it } from 'vitest';
import { llmsText, type RepoDoc, securityFigures } from '@/lib/llms/text';
import results from '@/lib/security/results.json';
import { type LiveResult, type ResultsFile } from '@/lib/security/results';
import { LIMITS, PAPER, PURPOSE, readResults } from '@/lib/security/view';

const APP = 'https://behest.example';
const FILE = readResults(results);
const DOCS: RepoDoc[] = [
  { label: 'Architecture', path: 'docs/architecture.md', url: null },
  { label: 'Read me', path: 'README.md', url: null },
];

const text = (overrides: Partial<Parameters<typeof llmsText>[0]> = {}) =>
  llmsText({ appUrl: APP, sourceUrl: null, docs: DOCS, security: FILE, ...overrides });

/** A live result in a given state, with the rest of it as small as the type allows. */
const liveResult = (state: LiveResult['state']): LiveResult => ({
  attack: FILE.deterministic[0].attack,
  state,
  proposals: [],
  summary: '',
  error: null,
  calls: 1,
  costUsd: 0.01,
});
const withLive = (states: LiveResult['state'][], skipped: ResultsFile['deterministic'][number]['attack'][] = []): ResultsFile => ({
  ...FILE,
  live: { ranAt: '2026-11-01T00:00:00.000Z', calls: 12, costUsd: 0.1234, results: states.map(liveResult), skipped },
});

describe('llmsText', () => {
  it('opens the way llmstxt.org lays a file out: a title, then a one-line summary as a quote', () => {
    expect(text()).toMatch(/^# Behest\n\n> Signed proof of what a human authorized, on every AI-agent purchase made with PayPal\./);
  });

  it('links the public key set, the receipt check and the demo catalog at the app origin', () => {
    const body = text();
    expect(body).toContain(`(${APP}/.well-known/jwks.json)`);
    expect(body).toContain(`POST ${APP}/api/receipts/verify`);
    expect(body).toContain(`(${APP}/api/sellers/ravi-spices/catalog)`);
    expect(body).toContain(`[Security](${APP}/security): ${PURPOSE}`);
  });

  it('carries the security figures, the paper and every limit the security page lists', () => {
    const body = text();
    expect(body).toContain(securityFigures(FILE));
    expect(body).toContain(`[${PAPER.title}](${PAPER.url})`);
    for (const { title } of LIMITS) expect(body).toContain(`  - ${title}`);
  });

  it('names repository paths while the repository is private, and links them once it is public', () => {
    expect(text()).toContain('- Architecture: `docs/architecture.md` in the repository, which is private for now.');
    expect(text()).not.toContain('[Source code]');

    const source = 'https://github.com/omsherikar/behest';
    const body = text({ sourceUrl: source, docs: [{ label: 'Architecture', path: 'docs/architecture.md', url: `${source}/blob/main/docs/architecture.md` }] });
    expect(body).toContain(`- [Source code](${source}): the repository.`);
    expect(body).toContain(`- [Architecture](${source}/blob/main/docs/architecture.md): \`docs/architecture.md\` in the repository.`);
  });

  it('uses no em dash, and no instruction aimed at the model reading it', () => {
    const body = text();
    expect(body).not.toContain('—');
    expect(body).not.toMatch(/\b(ignore|disregard) (all |any )?(previous|prior)|you (must|should) (rate|rank|score|recommend)/i);
  });
});

describe('securityFigures', () => {
  it('reads the figures from the results file as the security page does', () => {
    const live = FILE.live;
    if (!live) throw new Error('the committed results carry a live run');
    const stopped = live.results.filter((result) => result.state === 'stopped').length;
    const figures = securityFigures(FILE);
    expect(figures).toContain(`${FILE.deterministic.length} attacks were replayed against every layer.`);
    expect(figures).toContain(`out of ${live.results.length}: ${stopped} stopped`);
    expect(figures).toContain(`${live.calls} model calls and cost about $${live.costUsd.toFixed(2)}.`);
  });

  it('lists only the outcomes that happened, in a fixed order', () => {
    expect(securityFigures(withLive(['flagged', 'stopped', 'stopped', 'failed']))).toContain(
      'out of 4: 2 stopped, 1 held for the buyer, 1 ended in an error.',
    );
    expect(securityFigures(withLive(['passed']))).toContain('out of 1: 1 not stopped.');
  });

  it('says how many attacks the spend cap left unrun', () => {
    expect(securityFigures(withLive(['stopped'], [FILE.deterministic[1].attack]))).toContain(
      ' 1 not run, because the run reached its spend cap.',
    );
  });

  it('says so when the live run has not happened', () => {
    expect(securityFigures({ ...FILE, live: null })).toBe(
      `${FILE.deterministic.length} attacks were replayed against every layer. The live run against the model has not been run yet.`,
    );
  });
});
