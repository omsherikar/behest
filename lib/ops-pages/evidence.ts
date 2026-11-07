// Reading a dispute's evidence items for the operator's page. Each item is the text Behest's
// evidence pack wrote (lib/disputes/pack.ts): the mandate and receipt items end with their signed
// compact JWS, and the purchase log lists every recorded step, one numbered line each. The page
// shows the signed artifact decoded and the log as a timeline; everything stays plain text.

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
