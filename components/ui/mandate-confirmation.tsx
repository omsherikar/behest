import type { ProofField } from './proof-fields';
import { ProofId } from './proof-id';

// How the buyer confirmed a mandate, in the same words on the mandate page, in a purchase's trace and
// on the home page: signed with their passkey, which the signed mandate then names, or confirmed by
// their signed-in session alone.

/** The proof fields that say how a mandate was confirmed, with the passkey's credential id when one signed it. */
export function confirmationFields(confirmation: 'session' | 'passkey', credentialId: string | null): ProofField[] {
  if (confirmation === 'session') return [{ label: 'Confirmation', value: 'Confirmed by your signed-in session' }];
  const fields: ProofField[] = [{ label: 'Confirmation', value: 'Signed with your passkey' }];
  if (credentialId) fields.push({ label: 'Credential id', value: <ProofId value={credentialId} label="Passkey credential id" /> });
  return fields;
}
