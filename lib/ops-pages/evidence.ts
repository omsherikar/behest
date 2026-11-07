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
