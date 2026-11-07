'use client';

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useState } from 'react';
import type { MandatePolicy } from '@/lib/domain/policy';

// Confirming a mandate with the buyer's passkey: their own device signs the exact mandate they
// confirm, which a session confirmation cannot show. A buyer with no passkey yet registers one
// first. Self-contained, so any page that confirms a mandate can place it beside its confirm button.

/** What the confirm route signs: the compiled mandate and its confirm token. */
export type Confirmable = { text: string; policy: MandatePolicy; confirmToken: string };
/** What a confirm returns. `approveUrl` is null when the buyer's wallet is already linked. */
export type Signed = { mandateId: string; approveUrl: string | null };

type Ceremony<T> = { options: T; ticket: string };

/** A failed step, with a message the buyer can read, the HTTP status and the route's error code, if any. */
class StepFailed extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** An error message from a route, as a sentence: capitalized, with a full stop. */
function sentence(message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** POSTs JSON to a route and returns its JSON body, or throws StepFailed. */
async function post<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new StepFailed('Could not reach Behest. Check your connection and try again.', null);
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
    const message = typeof error?.message === 'string' ? sentence(error.message) : 'Something went wrong. Try again.';
    throw new StepFailed(message, response.status, typeof error?.code === 'string' ? error.code : undefined);
  }
  return json as T;
}

/** Runs the browser's passkey prompt, turning a cancel or an authenticator error into a StepFailed. */
async function onDevice<T>(prompt: () => Promise<T>, message: string): Promise<T> {
  try {
    return await prompt();
  } catch {
    throw new StepFailed(message, null);
  }
}

/** Registers a passkey for the buyer on this device. */
async function registerPasskey(): Promise<void> {
  const { options, ticket } = await post<Ceremony<Parameters<typeof startRegistration>[0]['optionsJSON']>>(
    '/api/passkeys/register/options',
    {},
  );
  const response = await onDevice(
    () => startRegistration({ optionsJSON: options }),
    'Your passkey was not created. Try again, or confirm without it.',
  );
  await post('/api/passkeys/register/verify', { response, ticket });
}

type SigningOptions = Ceremony<Parameters<typeof startAuthentication>[0]['optionsJSON']>;

/** The options for signing this mandate, registering a passkey first when the buyer has none. */
async function signingOptions(mandate: Confirmable): Promise<SigningOptions> {
  try {
    return await post<SigningOptions>('/api/mandates/sign/options', mandate);
  } catch (failure) {
    if (!(failure instanceof StepFailed) || failure.code !== 'no_passkey') throw failure;
  }
  await registerPasskey();
  return post<SigningOptions>('/api/mandates/sign/options', mandate);
}

/**
 * A "Sign with passkey" button that signs `mandate` with the buyer's passkey and confirms it. It
 * calls `onStart` when it begins, then `onSigned` or `onFailed`, so the page can show progress and
 * the outcome as it does for its own confirm.
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

  async function sign() {
    if (!mandate) return;
    setSigning(true);
    onStart();
    try {
      if (!browserSupportsWebAuthn()) {
        throw new StepFailed('This browser cannot use passkeys. Confirm without one instead.', null);
      }
      const { options, ticket } = await signingOptions(mandate);
      const assertion = await onDevice(
        () => startAuthentication({ optionsJSON: options }),
        'Your passkey did not sign the mandate. Try again, or confirm without it.',
      );
      onSigned(await post<Signed>('/api/mandates/confirm', { ...mandate, assertion, ticket }));
    } catch (failure) {
      const known = failure instanceof StepFailed;
      onFailed(known ? failure.message : 'Something went wrong. Try again.', known ? failure.status : null);
    } finally {
      setSigning(false);
    }
  }

  return (
    <button type="button" onClick={() => void sign()} disabled={disabled || !mandate} className={className}>
      {signing ? 'Waiting for your passkey...' : 'Sign with passkey'}
    </button>
  );
}
