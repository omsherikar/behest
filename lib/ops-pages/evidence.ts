// Reading a dispute's evidence items for the operator's page. Each item is the text Behest's
// evidence pack wrote (lib/disputes/pack.ts): the mandate and receipt items carry their signed
// compact JWS, a mandate a passkey signed ends with that signature's fields, the decision item ends
// with the decision record's hash, and the purchase log lists every recorded step, one numbered line
// each. The page shows the signed artifact decoded, the passkey and decision proof as fields, and the
// log as a timeline; everything stays plain text.

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The line the pack writes before a signed artifact, such as "The signed receipt, a compact JWS:". */
const JWS_LEAD = /a compact JWS:$/;

/**
 * The signed artifact an item carries, and its text without it, or null when it carries none. The
 * artifact is the last line that is a compact JWS; the line introducing it goes too.
 */
export function signedArtifact(body: string): { text: string; jws: string } | null {
  const lines = body.split('\n');
  const at = lines.findLastIndex((line) => COMPACT_JWS.test(line.trim()));
  if (at === -1) return null;
  const lead = at > 0 && JWS_LEAD.test(lines[at - 1].trim()) ? at - 1 : at;
  const text = [...lines.slice(0, lead), ...lines.slice(at + 1)].join('\n').trim();
  return { text, jws: lines[at].trim() };
}

export type LogStep = { n: number; at: string; kind: string; detail: string };

const STEP = /^(\d+)\. (\d{4}-\d{2}-\d{2}T[\d:.]+Z) (\S+)(?: (.*))?$/;

/**
 * The purchase log as its opening lines and its steps, or null when the body has no steps. A step is
 * "1. <ISO time> <kind> <detail>"; a line that does not start a step continues the one before it.
 */
export function logTimeline(body: string): { intro: string[]; steps: LogStep[] } | null {
  const intro: string[] = [];
  const steps: LogStep[] = [];
  for (const line of body.split('\n')) {
    const step = STEP.exec(line);
    if (step) {
      steps.push({ n: Number(step[1]), at: step[2], kind: step[3], detail: step[4] ?? '' });
    } else if (steps.length > 0) {
      const last = steps[steps.length - 1];
      last.detail = last.detail ? `${last.detail}\n${line}` : line;
    } else if (line.trim() !== '') {
      intro.push(line);
    }
  }
  return steps.length === 0 ? null : { intro, steps };
}

export type PasskeyField = { label: string; value: string };
export type PasskeyCheckResult = 'verified' | 'not made' | 'failed';

export type PasskeySignature = {
  /** Every line of the section as a label and its value, in the order the pack wrote them. */
  fields: PasskeyField[];
  /** The credential id, or null when it was not recorded. */
  credentialId: string | null;
  /** The COSE public key, base64url, or null when the signed mandate does not carry it. */
  publicKey: string | null;
  /** The result of checking the passkey's signature, and the rest of what the pack says of it. */
  check: { result: PasskeyCheckResult; reason: string } | null;
  /** Whether Behest's signature on the mandate, which binds the passkey to the buyer, verifies; null when the pack does not say. */
  behestSigned: boolean | null;
};

const PASSKEY_LEAD = 'The passkey signature:';
const NOT_RECORDED = /^not (recorded|in the signed mandate)$/;
const CHECK = /^(verified|not made|failed), (.+)$/;

/**
 * The passkey signature a mandate item ends with, and the item's text before it, or null when it has
 * none. The section starts at "The passkey signature:" and each of its lines is "<label>: <value>".
 * It counts only after the signed mandate's JWS, so the buyer's own words, which come before the
 * JWS, cannot pass for one.
 */
export function passkeySignature(body: string): { text: string; passkey: PasskeySignature } | null {
  const lines = body.split('\n');
  const jwsAt = lines.findLastIndex((line) => COMPACT_JWS.test(line.trim()));
  const at = lines.findLastIndex((line) => line.trim() === PASSKEY_LEAD);
  if (jwsAt === -1 || at < jwsAt) return null;

  const fields: PasskeyField[] = [];
  for (const line of lines.slice(at + 1)) {
    const split = line.indexOf(': ');
    if (split > 0) fields.push({ label: line.slice(0, split).trim(), value: line.slice(split + 2).trim() });
    else if (line.trim() !== '' && fields.length > 0) fields[fields.length - 1].value += `\n${line.trim()}`;
  }
  const valueOf = (label: string) => {
    const value = fields.find((field) => field.label === label)?.value;
    return value === undefined || NOT_RECORDED.test(value) ? null : value;
  };
  const check = CHECK.exec(fields.find((field) => field.label === 'Passkey signature check')?.value ?? '');
  const behest = fields.find((field) => field.label.startsWith("Behest's signature"))?.value;
  return {
    text: lines.slice(0, at).join('\n').trim(),
    passkey: {
      fields,
      credentialId: valueOf('Credential id'),
      publicKey: valueOf('Public key (COSE, base64url)'),
      check: check ? { result: check[1] as PasskeyCheckResult, reason: check[2] } : null,
      behestSigned: behest === undefined ? null : behest.startsWith('verified'),
    },
  };
}

const DECISION_HASH = /^Decision record hash: ([0-9a-f]{64})$/;

/**
 * The decision item as its text, the decision record's hash and what follows the hash (whether the
 * signed receipt commits to the record), or null when it names no hash. The hash is the last line
 * that names one, since the agent's words and seller titles quoted above it come first.
 */
export function decisionRecord(body: string): { text: string; hash: string; commitment: string } | null {
  const lines = body.split('\n');
  const at = lines.findLastIndex((line) => DECISION_HASH.test(line.trim()));
  if (at === -1) return null;
  const [, hash] = DECISION_HASH.exec(lines[at].trim()) ?? [];
  return { text: lines.slice(0, at).join('\n').trim(), hash, commitment: lines.slice(at + 1).join('\n').trim() };
}

/** The purchase events Behest logs (appendEvent in lib/purchases), in words for the dispute timeline. */
const EVENT_WORDS: Record<string, string> = {
  gate: 'Checked by the gate',
  intent: 'Intent check',
  status: 'Status changed',
  mandate_changed: 'Mandate changed while deciding',
  proposal_abandoned: 'Proposal abandoned',
  charge: 'Charged to the saved wallet',
  charge_declined: 'Charge declined at PayPal',
  charge_failed: 'Charge failed',
  charge_refused: 'Charge refused',
  charge_unknown: "PayPal's answer to the charge was lost",
  approval_order: 'Approval order created at PayPal',
  approval_order_failed: 'Approval order failed',
  approval_pending: 'Waiting for the buyer at PayPal',
  approval_expired: 'Approval window expired',
  capture: 'Captured at PayPal',
  capture_pending: 'Capture pending at PayPal',
  capture_denied: 'Capture denied at PayPal',
  capture_unmatched: 'Capture not matched to the order',
  receipt: 'Receipt signed',
  seller_accepted: 'Seller accepted the order',
  seller_rejected: 'Seller rejected the order',
  seller_ambiguous: "Seller's answer unclear",
  seller_unknown: "Seller's answer lost",
  refund_skipped: 'Refund skipped',
  refund_unknown: "PayPal's answer to the refund was lost",
  payout_failed: 'Payout failed',
  payout_unknown: "PayPal's answer to the payout was lost",
  payout_after_refund: 'Payout reported after a refund',
  dispute_opened: 'Dispute opened at PayPal',
  dispute_resolved: 'Dispute resolved at PayPal',
};

/** A purchase event's kind in words, such as "Receipt signed"; a kind not listed reads as its code in words. */
export function eventWords(kind: string): string {
  if (Object.hasOwn(EVENT_WORDS, kind)) return EVENT_WORDS[kind];
  const text = kind.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** When the purchase was created and captured, as the purchase log's opening lines record them. */
export function logMoments(intro: readonly string[]): { createdAt: string | null; capturedAt: string | null } {
  const text = intro.join('\n');
  const created = /^Purchase \S+, created at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.$/m.exec(text);
  const captured = /, captured at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.$/m.exec(text);
  return { createdAt: created?.[1] ?? null, capturedAt: captured?.[1] ?? null };
}

/** A piece of a line of evidence: plain text, or a span the pack quoted as written by someone else. */
export type EvidenceInline = { kind: 'text'; text: string } | { kind: 'quote'; source: string; text: string };
/** A run of lines, or a list of the lines that start with "- ", keeping each item's exact prefix. */
export type EvidenceBlock =
  | { kind: 'lines'; lines: EvidenceInline[][] }
  | { kind: 'list'; items: { prefix: string; parts: EvidenceInline[] }[] };

const QUOTED = /<untrusted source="([a-z_]+)">([\s\S]*?)<\/untrusted>/g;
const LIST_ITEM = /^(\s*- )/;

/**
 * Evidence text as blocks to display: the pack's quoted spans as quotes with their source, and lines
 * starting with "- " as list items. Only for display: `blocksText` gives back the exact text, and the
 * text sent to PayPal is the pack's own, never rebuilt from these.
 */
export function evidenceBlocks(text: string): EvidenceBlock[] {
  // The text as pieces, then as lines: a quote stays whole on its line even when it holds a line break.
  const pieces: EvidenceInline[] = [];
  let at = 0;
  for (const match of text.matchAll(QUOTED)) {
    if (match.index > at) pieces.push({ kind: 'text', text: text.slice(at, match.index) });
    pieces.push({ kind: 'quote', source: match[1], text: match[2] });
    at = match.index + match[0].length;
  }
  if (at < text.length) pieces.push({ kind: 'text', text: text.slice(at) });

  const lines: EvidenceInline[][] = [[]];
  for (const piece of pieces) {
    if (piece.kind === 'quote') {
      lines[lines.length - 1].push(piece);
      continue;
    }
    piece.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1].push({ kind: 'text', text: part });
    });
  }

  const blocks: EvidenceBlock[] = [];
  for (const line of lines) {
    const first = line[0];
    const prefix = first?.kind === 'text' ? LIST_ITEM.exec(first.text)?.[1] : undefined;
    if (prefix !== undefined) {
      const rest = first.text.slice(prefix.length);
      const parts: EvidenceInline[] = [...(rest ? [{ kind: 'text' as const, text: rest }] : []), ...line.slice(1)];
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list') last.items.push({ prefix, parts });
      else blocks.push({ kind: 'list', items: [{ prefix, parts }] });
    } else {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'lines') last.lines.push(line);
      else blocks.push({ kind: 'lines', lines: [line] });
    }
  }
  return blocks;
}

const inlineText = (parts: readonly EvidenceInline[]) =>
  parts.map((part) => (part.kind === 'text' ? part.text : `<untrusted source="${part.source}">${part.text}</untrusted>`)).join('');

/** The exact text `evidenceBlocks` was given. */
export function blocksText(blocks: readonly EvidenceBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === 'lines' ? block.lines.map(inlineText) : block.items.map((item) => `${item.prefix}${inlineText(item.parts)}`)))
    .join('\n');
}
