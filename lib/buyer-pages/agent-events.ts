import { STEP_STATES, TRACE_STEPS } from '@/lib/ui/trail';
import type { PurchaseDetail } from './detail';

// What a shopping agent run streams to the buyer's shop page, and a reader for its server-sent
// events. The run route sends one event per frame, its data an AgentEvent as JSON. These types copy
// the route's shapes rather than import them, so the page takes no server code, and a test checks
// that every outcome the purchase flow returns fits them. A proposal may come with its description
// (a PurchaseDetail); one that does not have that shape is left out and the outcome kept.

/** Where a proposed purchase stands, as the purchase flow reports it. */
export type RunOutcome = {
  purchaseId: string;
  verdict: 'ALLOW' | 'ASK' | 'BLOCK';
  /** A purchase status, such as `captured` or `awaiting_approval`. */
  status: string;
  /** Why the purchase was not simply allowed: failed gate rules, then the intent check's concerns. */
  reasons: string[];
  /** The PayPal link the buyer opens to approve an ASK purchase. */
  approveUrl: string | null;
  receiptId: string | null;
};

/** One step of a run, as the buyer's page shows it. */
export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'proposal'; outcome: RunOutcome; view?: PurchaseDetail }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string };

const VERDICTS: readonly unknown[] = ['ALLOW', 'ASK', 'BLOCK'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isStringOrNull = (value: unknown): value is string | null => value === null || isString(value);

/** The outcome in `value` with only the fields an outcome has, or null when one is missing or of the wrong kind. */
function toOutcome(value: unknown): RunOutcome | null {
  if (!isRecord(value)) return null;
  const { purchaseId, verdict, status, reasons, approveUrl, receiptId } = value;
  if (!isString(purchaseId) || !VERDICTS.includes(verdict) || !isString(status)) return null;
  if (!Array.isArray(reasons) || !reasons.every(isString)) return null;
  if (!isStringOrNull(approveUrl) || !isStringOrNull(receiptId)) return null;
  return { purchaseId, verdict: verdict as RunOutcome['verdict'], status, reasons, approveUrl, receiptId };
}

const isNumberOrNull = (value: unknown): value is number | null => value === null || typeof value === 'number';
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const oneOf = (value: unknown, options: readonly unknown[]) => options.includes(value);

/** Whether `value` has the shape of a PurchaseDetail, in every field the page reads. */
function isPurchaseDetail(value: unknown): value is PurchaseDetail {
  if (!isRecord(value)) return false;
  const { id, createdAt, seller, sellerSlug, totalCents, items, gateVerdict, finalVerdict, verdict, status, reasons } = value;
  const { trace, mandate, outcomes, intent, paypal, approveUrl, receipt, cart, change } = value;
  return (
    isString(id) &&
    isString(createdAt) &&
    isString(seller) &&
    isStringOrNull(sellerSlug) &&
    isNumberOrNull(totalCents) &&
    Array.isArray(items) &&
    items.every((i) => isRecord(i) && isString(i.sku) && isString(i.title) && typeof i.quantity === 'number' && typeof i.unitPriceCents === 'number') &&
    oneOf(gateVerdict, VERDICTS) &&
    (finalVerdict === null || oneOf(finalVerdict, VERDICTS)) &&
    oneOf(verdict, VERDICTS) &&
    isString(status) &&
    isStringList(reasons) &&
    isRecord(trace) &&
    TRACE_STEPS.every((step) => oneOf(trace[step], STEP_STATES)) &&
    isRecord(mandate) &&
    isString(mandate.id) &&
    isString(mandate.policyHash) &&
    isString(mandate.confirmedAt) &&
    oneOf(mandate.confirmation, ['session', 'passkey']) &&
    isStringOrNull(mandate.credentialId) &&
    Array.isArray(outcomes) &&
    outcomes.every((o) => isRecord(o) && isString(o.rule) && oneOf(o.result, ['pass', 'ask', 'block', 'skip']) && isString(o.detail)) &&
    (intent === null || (isRecord(intent) && oneOf(intent.verdict, ['consistent', 'needs_human', 'inconsistent', 'unavailable']) && isStringList(intent.reasons))) &&
    isRecord(paypal) &&
    isStringOrNull(paypal.orderId) &&
    isStringOrNull(paypal.captureId) &&
    isStringOrNull(paypal.capturedAt) &&
    isStringOrNull(approveUrl) &&
    (receipt === null ||
      (isRecord(receipt) && isString(receipt.id) && isString(receipt.keyId) && isString(receipt.jws) && isStringOrNull(receipt.decisionHash))) &&
    (cart === null || isRecord(cart)) &&
    (change === null || (isRecord(change) && oneOf(change.kind, ['allowed', 'changes', 'cannot'])))
  );
}

/** The event in parsed JSON with only the fields its type defines, or null when it is not an AgentEvent. */
export function toAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'status':
      return isString(value.text) ? { type: 'status', text: value.text } : null;
    case 'tool':
      return isString(value.name) ? { type: 'tool', name: value.name, input: value.input } : null;
    case 'proposal': {
      const outcome = toOutcome(value.outcome);
      if (!outcome) return null;
      return isPurchaseDetail(value.view) && value.view.id === outcome.purchaseId ? { type: 'proposal', outcome, view: value.view } : { type: 'proposal', outcome };
    }
    case 'done':
      return isString(value.summary) ? { type: 'done', summary: value.summary } : null;
    case 'error':
      return isString(value.message) ? { type: 'error', message: value.message } : null;
    default:
      return null;
  }
}

/**
 * A reader of server-sent event text that takes it a chunk at a time, however the chunks fall, and
 * returns the AgentEvents each chunk completes. It reads lines ending in LF, CRLF or CR, joins the
 * `data` lines of a frame, and ignores comments and other fields. A frame whose data is not JSON or
 * not an AgentEvent is skipped. A frame is read only once the blank line that ends it arrives, so a
 * stream cut off mid-frame loses that frame and nothing else.
 */
export function createAgentEventParser(): (chunk: string) => AgentEvent[] {
  let buffer = '';
  let data: string[] = [];
  /** Whether the last chunk ended in CR, so an LF opening the next one completes that line ending. */
  let afterCr = false;

  function endFrame(events: AgentEvent[]) {
    if (data.length === 0) return;
    const text = data.join('\n');
    data = [];
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const event = toAgentEvent(json);
    if (event) events.push(event);
  }

  function readLine(line: string, events: AgentEvent[]) {
    if (line === '') return endFrame(events);
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    if ((colon === -1 ? line : line.slice(0, colon)) !== 'data') return;
    const value = colon === -1 ? '' : line.slice(colon + 1);
    data.push(value.startsWith(' ') ? value.slice(1) : value);
  }

  return (chunk) => {
    const events: AgentEvent[] = [];
    buffer += afterCr && chunk.startsWith('\n') ? chunk.slice(1) : chunk;
    afterCr = false;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char !== '\n' && char !== '\r') continue;
      readLine(buffer.slice(start, i), events);
      if (char === '\r') {
        if (i + 1 === buffer.length) afterCr = true;
        else if (buffer[i + 1] === '\n') i++;
      }
      start = i + 1;
    }
    buffer = buffer.slice(start);
    return events;
  };
}

/** The AgentEvents of a run's response body as they arrive. A reader that stops early cancels the body. */
export async function* readAgentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const push = createAgentEventParser();
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      yield* push(done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
