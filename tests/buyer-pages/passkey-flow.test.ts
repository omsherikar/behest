import { describe, expect, it } from 'vitest';
import { nextPasskeyStep } from '@/lib/buyer-pages/passkey-flow';

const fresh = { onThisDevice: false, registeredHere: false };

describe('nextPasskeyStep', () => {
  it('signs straight away with a passkey the account already has', () => {
    expect(nextPasskeyStep('start', fresh)).toBe('sign');
  });

  it('registers a passkey on this device first when the buyer asks to use one here', () => {
    expect(nextPasskeyStep('start', { ...fresh, onThisDevice: true })).toBe('register');
  });

  it('registers a passkey on this device when the account has none', () => {
    expect(nextPasskeyStep('no_passkey', fresh)).toBe('register');
  });

  it("registers a passkey on this device when it could not sign, as when the account's passkeys are on another device", () => {
    expect(nextPasskeyStep('not_signed', fresh)).toBe('register');
    expect(nextPasskeyStep('not_signed', { ...fresh, onThisDevice: true })).toBe('register');
  });

  it('gives up rather than register twice, so signing is retried once after registering', () => {
    const registered = { onThisDevice: false, registeredHere: true };
    expect(nextPasskeyStep('not_signed', registered)).toBe('give_up');
    expect(nextPasskeyStep('no_passkey', registered)).toBe('give_up');
    expect(nextPasskeyStep('not_signed', { ...registered, onThisDevice: true })).toBe('give_up');
  });
});
