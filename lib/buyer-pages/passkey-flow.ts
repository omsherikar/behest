// When the buyer's page should register a passkey on this device while signing a mandate. Every
// visitor shares the demo buyer, so the account may hold passkeys that live on other devices; signing
// then fails here until this device registers its own. Registering is offered once per attempt, so a
// device that still cannot sign after registering gives up instead of looping.

/** What the signing flow does next. */
export type PasskeyStep = 'register' | 'sign' | 'give_up';

/**
 * Where the flow stands:
 * - `start`: it is about to begin;
 * - `no_passkey`: the account has no passkey to sign with;
 * - `not_signed`: this device did not sign, as when none of the account's passkeys is on it or the
 *   buyer cancelled the prompt.
 */
export type PasskeyEvent = 'start' | 'no_passkey' | 'not_signed';

/**
 * The next step after `event`. `onThisDevice` is the buyer asking to use a passkey on this device,
 * which registers one before signing; `registeredHere` is whether this attempt has registered one.
 */
export function nextPasskeyStep(event: PasskeyEvent, state: { onThisDevice: boolean; registeredHere: boolean }): PasskeyStep {
  if (event === 'start') return state.onThisDevice && !state.registeredHere ? 'register' : 'sign';
  return state.registeredHere ? 'give_up' : 'register';
}
