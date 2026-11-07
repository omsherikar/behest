'use client';

import { type ReactNode, useId, useState } from 'react';
import { jsonLines, splitJws, type JsonToken } from '@/lib/ui/jws';
import { CopyButton } from './copy-button';

// A compact JWS, such as a signed receipt, laid open: the token in its three coloured segments
// (header, payload, signature), the header and payload decoded from base64url as indented JSON,
// and the signature. It only decodes. The signature is never checked in the browser, and the view
// says so; `actions` can hold a button that asks the server to verify it.

const SEGMENTS = {
  header: { name: 'Header', text: 'text-jws-header', swatch: 'bg-jws-header' },
  payload: { name: 'Payload', text: 'text-jws-payload', swatch: 'bg-jws-payload' },
  signature: { name: 'Signature', text: 'text-jws-signature', swatch: 'bg-jws-signature' },
} as const;
type Segment = keyof typeof SEGMENTS;

const TOKEN_CLASS: Record<JsonToken['kind'], string> = {
  key: 'text-muted',
  string: 'text-text',
  number: 'text-text',
  literal: 'text-text',
  punctuation: 'text-muted',
};

/** How many characters of the payload a short token shows, split between its start and its end. */
const SHORT_PAYLOAD = 72;

const block = 'rounded-control border border-line bg-bg p-3 font-mono text-meta whitespace-pre-wrap [overflow-wrap:anywhere]';

function Caption({ segment, children }: { segment: Segment; children?: ReactNode }) {
  const { name, text, swatch } = SEGMENTS[segment];
  return (
    <figcaption className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
      <span aria-hidden className={`size-2 rounded-[2px] ${swatch}`} />
      <span className={`font-medium ${text}`}>{name}</span>
      {children}
    </figcaption>
  );
}

/**
 * How a token may wrap: a long string, such as a hash or an id, breaks anywhere so it fills its
 * line; a short one stays whole, and the line wraps at its spaces instead.
 */
const wrapClass = (token: JsonToken) =>
  token.kind === 'string' || token.kind === 'key' ? (token.text.length > 24 ? 'break-all' : 'whitespace-nowrap') : '';

/**
 * Indented JSON, one block per line. Each line is indented with padding and a hanging indent, and
 * strings may break anywhere, so a long hash fills its line and wraps under its own key rather than
 * at the left edge of the block.
 */
function Json({ value }: { value: unknown }) {
  if (value === undefined) return <p className={`${block} font-sans text-muted`}>This segment does not decode to JSON.</p>;
  return (
    <pre className={block}>
      <code>
        {jsonLines(value).map((line, index) => (
          <span key={index} className="block" style={{ paddingLeft: `${line.indent + 2}ch`, textIndent: '-2ch' }}>
            {line.tokens.map((token, at) => (
              <span key={at} className={`${TOKEN_CLASS[token.kind]} ${wrapClass(token)}`}>
                {token.text}
              </span>
            ))}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function JwsView({
  jws,
  label = 'Signed receipt',
  actions,
  decoded = 'open',
  token = 'full',
}: {
  jws: string;
  /** What the token is. */
  label?: string;
  actions?: ReactNode;
  /** Whether the decoded header, payload and signature show at first, or wait behind a button. */
  decoded?: 'open' | 'folded';
  /**
   * The whole token, the payload cut to its start and end where space is short, or `auto`: cut on
   * a phone and whole from 768 px. Copy always takes all of it.
   */
  token?: 'full' | 'short' | 'auto';
}) {
  const parts = splitJws(jws);
  const [showDecoded, setShowDecoded] = useState(decoded === 'open');
  const decodedId = useId();

  return (
    <section aria-label={label} className="min-w-0 rounded-panel border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <p className="font-medium text-text">
          {label} <span className="hidden font-normal text-muted sm:inline">compact JWS</span>
        </p>
        <div className="flex items-center gap-2">
          {/* Wrapped: a node passed in from a server page must not share an array with siblings. */}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
          <CopyButton value={jws.trim()} label="JWS" />
        </div>
      </div>

      {parts ? (
        <div className="grid gap-4 p-3 sm:p-4">
          <p className="font-mono text-meta leading-5 break-all">
            <span className={SEGMENTS.header.text}>{parts.header}</span>
            <span className="text-muted">.</span>
            {token !== 'full' && parts.payload.length > SHORT_PAYLOAD + 3 && (
              <span className={token === 'auto' ? 'md:hidden' : undefined}>
                <span className={SEGMENTS.payload.text}>{parts.payload.slice(0, SHORT_PAYLOAD - 16)}</span>
                <span className="text-muted">...</span>
                <span className={SEGMENTS.payload.text}>{parts.payload.slice(-16)}</span>
              </span>
            )}
            {(token === 'full' || parts.payload.length <= SHORT_PAYLOAD + 3) && (
              <span className={SEGMENTS.payload.text}>{parts.payload}</span>
            )}
            {token === 'auto' && parts.payload.length > SHORT_PAYLOAD + 3 && (
              <span className={`hidden md:inline ${SEGMENTS.payload.text}`}>{parts.payload}</span>
            )}
            <span className="text-muted">.</span>
            <span className={SEGMENTS.signature.text}>{parts.signature}</span>
          </p>

          {decoded === 'folded' && (
            <button
              type="button"
              aria-expanded={showDecoded}
              aria-controls={decodedId}
              onClick={() => setShowDecoded((shown) => !shown)}
              className="flex items-center gap-1.5 justify-self-start rounded-control text-meta font-medium text-action hover:text-action-strong"
            >
              {showDecoded ? 'Hide the decoded header and payload' : 'Show the decoded header and payload'}
              <svg viewBox="0 0 16 16" aria-hidden className={`size-3 transition-transform ${showDecoded ? 'rotate-180' : ''}`}>
                <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <div
            id={decodedId}
            hidden={!showDecoded}
            className="grid min-w-0 gap-4 md:grid-cols-[minmax(15.5rem,1fr)_minmax(0,2fr)] md:grid-rows-[auto_1fr]"
          >
            <figure className="min-w-0 md:col-start-1 md:row-start-1">
              <Caption segment="header">
                <span className="text-muted">decoded</span>
              </Caption>
              <Json value={parts.decodedHeader} />
            </figure>
            <figure className="min-w-0 md:col-start-2 md:row-span-2 md:row-start-1">
              <Caption segment="payload">
                <span className="text-muted">decoded</span>
              </Caption>
              <Json value={parts.decodedPayload} />
            </figure>
            <figure className="min-w-0 md:col-start-1 md:row-start-2">
              <Caption segment="signature">
                {typeof (parts.decodedHeader as { alg?: unknown } | undefined)?.alg === 'string' && (
                  <span className="font-mono text-muted">{(parts.decodedHeader as { alg: string }).alg}</span>
                )}
              </Caption>
              <p className={`${block} ${SEGMENTS.signature.text}`}>{parts.signature}</p>
              <p className="mt-1.5 text-meta text-muted">
                Shown as signed. This view decodes the token but does not check the signature.
              </p>
            </figure>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 p-3 sm:p-4">
          <p className="text-body text-muted">
            This is not a compact JWS. A compact JWS is three base64url parts joined by dots: header, payload and signature.
          </p>
          <p className={`${block} text-text`}>{jws}</p>
        </div>
      )}
    </section>
  );
}
