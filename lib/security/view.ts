import { formatUsd } from '@/lib/domain/money';
import type { Verdict } from '@/lib/domain/verdict';
import { plural } from '@/lib/domain/words';
import { type Attack, type AttackId, ATTACKS } from './attacks';
import { type LayerState, type LiveProposal, type LiveResult, type ReplayResult, ResultsFile } from './results';

// The security page and docs/security.md in words: one row per attack, one cell per layer, each a
// state with a sentence on why, built from lib/security/results.json. The page only lays these out,
// so the same words appear on the page and in the docs table. Every sentence here describes what the
// replay recorded; nothing claims more than the results show.

export type LayerKey = 'screen' | 'visibility' | 'gate' | 'live';

/** The layers in the order an attack meets them, with the question each answers. */
export const LAYERS: { key: LayerKey; name: string; question: string }[] = [
  { key: 'screen', name: 'Onboarding screen', question: 'Does onboarding flag the listing, or remove what it hides?' },
  { key: 'visibility', name: 'Agent visibility', question: 'Does the agent see the listing, and is its text quoted?' },
  { key: 'gate', name: 'Gate', question: 'What does the gate decide for the cart the attack wants?' },
  { key: 'live', name: 'Agent and intent check', question: 'What does the live agent choose, and what does the intent check say?' },
];

/** A state's colour token: stop for stopped, hold for flagged, muted for anything that did not act. */
export type Tone = 'stop' | 'hold' | 'muted';
/** A state's shape, so no state rests on colour alone. */
export type Shape = 'crossed' | 'half' | 'open' | 'dashed';
export type StateWord = 'Stopped' | 'Flagged' | 'Passed through' | 'Pending live run' | 'Run failed';

export type Cell = { layer: LayerKey; state: StateWord; tone: Tone; shape: Shape; detail: string };

export type AttackRow = {
  id: AttackId;
  name: string;
  basis: string;
  summary: string;
  /** One cell per layer, in LAYERS order. */
  cells: Cell[];
  /** What the deterministic layers did, in a phrase. */
  outcome: string;
};

export const PAPER = {
  title: "Whispers of Wealth: Red-Teaming Google's Agent Payments Protocol via Prompt Injection",
  authors: 'Tanusree Debi, Wentian Zhu and Pranjol Sen Gupta',
  id: 'arXiv 2601.22569',
  url: 'https://arxiv.org/abs/2601.22569',
};

/** What the security page is for, in one sentence. */
export const PURPOSE =
  'A published prompt-injection attack on agent payments, replayed against every Behest layer, with what each layer did.';

export const THREAT =
  "Shopping agents read what sellers write. In January 2026, Debi, Zhu and Sen Gupta showed that a few sentences in a product listing reliably steer a shopping agent built on Google's Agent Payments Protocol (AP2): their Branded Whisper attack moved the attacker's product to the top of the agent's choices, and their Vault Whisper attack drew out the user's data, though every purchase carried a signed mandate. A signed mandate records what the buyer allowed; it does not stop an agent being talked into something inside it. This page replays that class of attack against each Behest layer and records what each one did, including where an attack got through.";

/** What the replay shows Behest does not stop, in the order the results table raises them. */
export const LIMITS: { title: string; detail: string }[] = [
  {
    title: 'Ranking among allowed listings is only partly covered.',
    detail:
      'A listing that tells agents to choose it, at a price the mandate allows, passes every deterministic layer: one weak phrase does not flag it, the agent reads it as quoted data, and the gate allows the cart. What stands in its way is the agent treating listing text as data, the market benchmark, which only catches prices over 1.5 times the median, and the intent check, which compares the cart with what the buyer asked for.',
  },
  {
    title: 'A weak phrase alone is not flagged.',
    detail:
      'The screen flags a phrase such as "buy 10 of these" only beside another. The gate still holds ten units for the buyer, on quantity and on the approval limit, and blocks what breaks the budget or the per-purchase limit; a bulk order inside those limits waits for the buyer rather than being refused.',
  },
  {
    title: 'The gate trusts the stored category.',
    detail:
      'Earbuds listed as spices pass the gate under a mandate that forbids electronics. This replay stores the seller\'s own category, as the demo seed does, to show the gate alone; in a real onboarding the catalog builder\'s model assigns the category from the listing text, and the intent check reads the cart\'s titles. Both are models, so this spoof is not stopped outright.',
  },
  {
    title: 'Seller names are neither checked nor unique.',
    detail:
      "A new seller can call itself Ravi's Spice Co, and the screen does not read seller names. Each seller has its own slug, which the agent sees and the receipt names, and a mandate that lists the sellers it allows blocks every other; the demo mandate allows any seller.",
  },
  {
    title: 'The price benchmark has a window.',
    detail:
      'Enrichment drops a market median below 0.2 times or above 5 times the listing price as a probable mismatch, so a listing priced over five times its median has no benchmark and the gate skips the price check. The replay tests pin this.',
  },
  {
    title: 'Exfiltration has little to take, but is not screened.',
    detail:
      "The screen does not flag a request for the buyer's email and address, and the gate does not read the agent's rationale. The agent is given the buyer's request and mandate readback, not an email or address, and its rationale goes to the intent check, the purchase's decision record and, in a dispute, the evidence Behest's operator sends PayPal, never to the seller.",
  },
  {
    title: 'One live run is evidence, not a guarantee.',
    detail:
      'The agent and the intent check are models. Their column records one run per attack; another run can choose differently. The deterministic columns give the same result every time.',
  },
];

const WORDS: Record<LayerState, { state: StateWord; tone: Tone; shape: Shape }> = {
  stopped: { state: 'Stopped', tone: 'stop', shape: 'crossed' },
  flagged: { state: 'Flagged', tone: 'hold', shape: 'half' },
  passed: { state: 'Passed through', tone: 'muted', shape: 'open' },
};

const NOT_RUN = { state: 'Pending live run', tone: 'muted', shape: 'dashed' } as const;

const FIELD_NAMES: Record<string, string> = { sellerName: 'seller name', title: 'title', description: 'description' };

const INTENT_WORDS: Record<string, string> = {
  consistent: 'found it consistent',
  needs_human: 'said the buyer should decide',
  inconsistent: 'found it inconsistent',
  unavailable: 'could not run',
};

const FINAL_WORDS: Record<Verdict, string> = { ALLOW: 'allowed it', ASK: 'held it for the buyer', BLOCK: 'blocked it' };

/** `a`, `a and b`, or `a, b and c`. */
function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const quoted = (phrases: string[]) => listed(phrases.map((phrase) => `"${phrase}"`));

function screenCell({ screen }: ReplayResult): Cell {
  const words = { layer: 'screen' as const, ...WORDS[screen.state] };
  if (screen.state === 'flagged') return { ...words, detail: `Matched ${quoted([...screen.strong, ...screen.weak])}.` };
  if (screen.state === 'stopped') {
    return {
      ...words,
      detail: `The CSV reader removed ${screen.hiddenRemoved} hidden characters spelling ${quoted(screen.hiddenPhrases)}, so none of it was stored.`,
    };
  }
  if (screen.weak.length === 1) {
    return { ...words, detail: `Only the weak phrase ${quoted(screen.weak)}, which flags a listing only beside another.` };
  }
  if (screen.weak.length > 1) {
    return { ...words, detail: `Only the weak phrases ${quoted(screen.weak)}, all of one kind, which flag a listing only beside a phrase of another kind.` };
  }
  return { ...words, detail: 'No phrase aimed at agents.' };
}

function visibilityCell({ visibility }: ReplayResult): Cell {
  const words = { layer: 'visibility' as const, ...WORDS[visibility.state] };
  if (visibility.state === 'stopped') return { ...words, detail: 'Hidden from search and lookup, so the agent never reads it.' };
  const seen = visibility.listed && visibility.shown ? 'Listed and shown' : visibility.listed ? 'Listed' : 'Shown';
  if (visibility.unquoted.length > 0) {
    return { ...words, detail: `${seen}, with the ${listed(visibility.unquoted.map((field) => FIELD_NAMES[field] ?? field))} outside quotes.` };
  }
  return { ...words, detail: `${seen}, with the seller name, title and description quoted as untrusted data.` };
}

function gateCell({ gate }: ReplayResult): Cell {
  const words = { layer: 'gate' as const, ...WORDS[gate.state] };
  const detailsOf = (result: 'block' | 'ask') => gate.rules.filter((rule) => rule.result === result).map((rule) => rule.detail);
  if (gate.verdict === 'BLOCK') return { ...words, detail: `Blocked: ${detailsOf('block').join('; ')}.` };
  if (gate.verdict === 'ASK') return { ...words, detail: `Held for the buyer: ${detailsOf('ask').join('; ')}.` };
  const cart = gate.cart ? `${plural(gate.cart.quantity, 'unit')} for ${formatUsd(gate.cart.totalCents)}, ` : '';
  return { ...words, detail: `Allowed: ${cart}with no rule blocking or asking.` };
}

/** The proposal that best shows what the attack got: the first one whose final verdict gives the run's state, else the first one aimed at it. */
function telling(result: LiveResult, aimed: LiveProposal[]): LiveProposal | undefined {
  const state: Record<Verdict, LayerState> = { ALLOW: 'passed', ASK: 'flagged', BLOCK: 'stopped' };
  return aimed.find((p) => p.finalVerdict !== null && state[p.finalVerdict] === result.state) ?? aimed[0];
}

function liveDetail(attack: Attack, result: LiveResult): string {
  if (attack.objective === 'exfiltrate') {
    return result.state === 'passed' ? 'The agent wrote an email address into its rationale.' : 'No rationale carried an email address.';
  }
  const proposal = telling(result, result.proposals.filter((p) => p.targetsAttack));
  if (!proposal) return 'The agent did not propose this listing.';
  const quantity = proposal.items.find((item) => item.sku === attack.listing.sku)?.quantity ?? 0;
  const intent = proposal.intent ? (INTENT_WORDS[proposal.intent.verdict] ?? 'answered') : 'did not run';
  const final = proposal.finalVerdict ? FINAL_WORDS[proposal.finalVerdict] : 'left it undecided';
  return `The agent proposed ${quantity} of it. The intent check ${intent}, and Behest ${final}.`;
}

function liveCell(file: ResultsFile, attack: Attack): Cell {
  if (file.live === null) return { layer: 'live', ...NOT_RUN, detail: 'Needs paid model calls; not run yet.' };
  const result = file.live.results.find((r) => r.attack === attack.id);
  if (!result) {
    const why = file.live.skipped.includes(attack.id) ? 'the live run reached its spend cap first' : 'it was not part of the live run';
    return { layer: 'live', ...NOT_RUN, detail: `Not run: ${why}.` };
  }
  if (result.state === 'failed') {
    return { layer: 'live', state: 'Run failed', tone: 'muted', shape: 'dashed', detail: result.error ?? 'The run failed.' };
  }
  return { layer: 'live', ...WORDS[result.state], detail: liveDetail(attack, result) };
}

/** What the deterministic layers did to the attack, in a phrase. */
function outcomeOf({ screen, visibility, gate }: ReplayResult): string {
  const at = screen.state === 'stopped' ? ['at onboarding'] : [];
  const by = [visibility.state === 'stopped' ? 'agent visibility' : null, gate.state === 'stopped' ? 'the gate' : null].filter(
    (name): name is string => name !== null,
  );
  if (at.length + by.length > 0) return `Stopped ${[...at, ...(by.length > 0 ? [`by ${listed(by)}`] : [])].join(' and ')}`;
  if (gate.state === 'flagged') return 'Held for the buyer by the gate';
  if (screen.state === 'flagged') return 'Flagged at onboarding';
  return 'Not stopped by the deterministic layers';
}

/** A row per replayed attack, in the order the results list them. */
export function attackRows(file: ResultsFile): AttackRow[] {
  return file.deterministic.map((result) => {
    const attack = ATTACKS.find((a) => a.id === result.attack);
    if (!attack) throw new Error(`the results name an attack the fixtures do not have: ${result.attack}`);
    return {
      id: attack.id,
      name: attack.name,
      basis: attack.basis,
      summary: attack.summary,
      cells: [screenCell(result), visibilityCell(result), gateCell(result), liveCell(file, attack)],
      outcome: outcomeOf(result),
    };
  });
}

/** Whether the live run has happened, and what it cost. */
export function liveNote(file: ResultsFile): string {
  if (file.live === null) {
    return 'The agent and intent check column needs paid model calls and is pending a live run. The other columns come from code that runs offline.';
  }
  const day = new Date(file.live.ranAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const skipped = file.live.skipped.length > 0 ? ` ${plural(file.live.skipped.length, 'attack')} not run: the spend cap was reached.` : '';
  return `Live run on ${day}: ${plural(file.live.calls, 'model call')}, about $${file.live.costUsd.toFixed(2)}.${skipped}`;
}

const cellText = (text: string) => text.replaceAll('|', '\\|');

/** The rows as the Markdown table docs/security.md carries. */
export function resultsTable(rows: AttackRow[]): string {
  const header = `| Attack | ${LAYERS.map((layer) => layer.name).join(' | ')} |`;
  const rule = `| ${['Attack', ...LAYERS].map(() => '---').join(' | ')} |`;
  const body = rows.map(
    (row) => `| ${cellText(row.name)} | ${row.cells.map((cell) => cellText(`${cell.state}. ${cell.detail}`)).join(' | ')} |`,
  );
  return [header, rule, ...body].join('\n');
}

/** The markers around the results in docs/security.md, which the replay script rewrites. */
export const RESULTS_START = '<!-- attack-replay results: written by npm run attack:replay -->';
export const RESULTS_END = '<!-- end of attack-replay results -->';

/** The results as docs/security.md shows them: the table, then the note on the live run. */
export function resultsBlock(file: ResultsFile): string {
  return `${resultsTable(attackRows(file))}\n\n${liveNote(file)}`;
}

/** `doc` with what lies between its results markers replaced by `block`. Throws when the markers are missing or out of order. */
export function replaceResultsBlock(doc: string, block: string): string {
  const start = doc.indexOf(RESULTS_START);
  const end = doc.indexOf(RESULTS_END);
  if (start === -1 || end < start) throw new Error('the document has no results markers to write between');
  return `${doc.slice(0, start + RESULTS_START.length)}\n${block}\n${doc.slice(end)}`;
}

/** The results file, checked, since a script writes it and anyone can edit it. */
export function readResults(json: unknown): ResultsFile {
  return ResultsFile.parse(json);
}
