import { splitJws } from './jws';

// Two claims the pages show from Behest's signed artifacts: the passkey a signed mandate names and the
// decision record a signed receipt commits to. They are read from the payload for display only.
// Nothing here verifies a signature; that happens on the server against Behest's public keys.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The credential id of the passkey a signed mandate names, or null for one confirmed by session or one that does not decode. */
export function mandateCredentialId(jws: string): string | null {
  const payload = splitJws(jws)?.decodedPayload;
  if (!isRecord(payload) || payload.confirmation !== 'passkey' || !isRecord(payload.passkey)) return null;
  const { credentialId } = payload.passkey;
  return typeof credentialId === 'string' && credentialId !== '' ? credentialId : null;
}

/** The hash of the agent's decision record a signed receipt commits to, or null when it names none or does not decode. */
export function receiptDecisionHash(jws: string): string | null {
  const payload = splitJws(jws)?.decodedPayload;
  if (!isRecord(payload) || !isRecord(payload.agent)) return null;
  const { decisionHash } = payload.agent;
  return typeof decisionHash === 'string' && decisionHash !== '' ? decisionHash : null;
}
