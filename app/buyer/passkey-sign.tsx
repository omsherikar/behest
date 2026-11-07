'use client';

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useState } from 'react';
import { nextPasskeyStep } from '@/lib/buyer-pages/passkey-flow';
import type { MandatePolicy } from '@/lib/domain/policy';
import { post, RequestFailed, type Signed } from './requests';

// Confirming a mandate with a passkey registered to the buyer's account, which signs the exact
// mandate they confirm, something a session confirmation cannot show. Every visitor shares the demo
// buyer, so the account's passkeys may live on other devices: when this device cannot sign, or the
// buyer asks to use a passkey here, it registers one of its own and signs once more. Self-contained,
// so any page that confirms a mandate can place it beside its confirm button.

/** What the confirm route signs: the compiled mandate and its confirm token. */
export type Confirmable = { text: string; policy: MandatePolicy; confirmToken: string };

type Ceremony<T> = { options: T; ticket: string };
type SigningOptions = Ceremony<Parameters<typeof startAuthentication>[0]['optionsJSON']>;

const NOT_CREATED = 'Your passkey was not created. Try again, or confirm without it.';
const NOT_SIGNED = 'Your passkey did not sign the mandate. Try again, or confirm without it.';

/** Runs the browser's passkey prompt, turning a cancel or an authenticator error into a RequestFailed. */
async function onDevice<T>(prompt: () => Promise<T>, message: string): Promise<T> {
  try {
    return await prompt();
  } catch {
    throw new RequestFailed(message, null);
  }
}

/** Registers a passkey on this device. The options exclude the account's passkeys, so a device registers once. */
async function registerHere(): Promise<void> {
  const { options, ticket } = await post<Ceremony<Parameters<typeof startRegistration>[0]['optionsJSON']>>(
    '/api/passkeys/register/options',
    {},
  );
  const response = await onDevice(() => startRegistration({ optionsJSON: options }), NOT_CREATED);
  await post('/api/passkeys/register/verify', { response, ticket });
}

/** The options for signing this mandate, or null when the account has no passkey yet. */
async function signingOptions(mandate: Confirmable): Promise<SigningOptions | null> {
  try {
    return await post<SigningOptions>('/api/mandates/sign/options', mandate);
  } catch (failure) {
    if (failure instanceof RequestFailed && failure.code === 'no_passkey') return null;
    throw failure;
  }
}

/**
 * Signs `mandate` with a passkey and confirms it. Registers a passkey on this device first when
 * `onThisDevice`, and otherwise when the account has none or this device could not sign; after
 * registering it signs once more, then gives up.
 */
async function signMandate(mandate: Confirmable, onThisDevice: boolean): Promise<Signed> {
  let registeredHere = false;
  let step = nextPasskeyStep('start', { onThisDevice, registeredHere });
  for (;;) {
    if (step === 'register') {
      await registerHere();
      registeredHere = true;
    }
    const signing = await signingOptions(mandate);
    if (signing === null) {
      step = nextPasskeyStep('no_passkey', { onThisDevice, registeredHere });
      if (step === 'give_up') throw new RequestFailed(NOT_SIGNED, null);
      continue;
    }
    let assertion;
    try {
      assertion = await startAuthentication({ optionsJSON: signing.options });
    } catch {
      step = nextPasskeyStep('not_signed', { onThisDevice, registeredHere });
      if (step === 'give_up') throw new RequestFailed(NOT_SIGNED, null);
      continue;
    }
    return post<Signed>('/api/mandates/confirm', { ...mandate, assertion, ticket: signing.ticket });
  }
}

/**
 * A "Sign with passkey" button, and a "Use a passkey on this device" one that registers a passkey
 * here before signing. Either signs `mandate` and confirms it, calling `onStart` when it begins, then
 * `onSigned` or `onFailed`, so the page can show progress and the outcome as it does for its confirm.
 */
export function SignWithPasskey({
  mandate,
  disabled,
  className,
  onStart,
  onSigned,
  onFailed,
}: {
  mandate: Confirmable | null;
  disabled: boolean;
  className?: string;
  onStart: () => void;
  onSigned: (signed: Signed) => void;
  onFailed: (message: string, status: number | null) => void;
}) {
  const [signing, setSigning] = useState(false);

  async function sign(onThisDevice: boolean) {
    if (!mandate) return;
    setSigning(true);
    onStart();
    try {
      if (!browserSupportsWebAuthn()) {
        throw new RequestFailed('This browser cannot use passkeys. Confirm without one instead.', null);
      }
      onSigned(await signMandate(mandate, onThisDevice));
    } catch (failure) {
      const known = failure instanceof RequestFailed;
      onFailed(known ? failure.message : 'Something went wrong. Try again.', known ? failure.status : null);
    } finally {
      setSigning(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => void sign(false)} disabled={disabled || !mandate} className={className}>
        {signing ? 'Waiting for your passkey...' : 'Sign with passkey'}
      </button>
      <button
        type="button"
        onClick={() => void sign(true)}
        disabled={disabled || !mandate}
        className="text-body font-medium text-action hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        Use a passkey on this device
      </button>
    </>
  );
}
