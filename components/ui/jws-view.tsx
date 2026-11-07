'use client';

import type { ReactNode } from 'react';
import { jsonTokens, splitJws, type JsonToken } from '@/lib/ui/jws';
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

function Json({ value }: { value: unknown }) {
  if (value === undefined) return <p className={`${block} font-sans text-muted`}>This segment does not decode to JSON.</p>;
  return (
    <pre className={block}>
      <code>
        {jsonTokens(value).map((token, index) => (
          <span key={index} className={TOKEN_CLASS[token.kind]}>
            {token.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function JwsView({ jws, label = 'Signed receipt', actions }: { jws: string; /** What the token is. */ label?: string; actions?: ReactNode }) {
  const parts = splitJws(jws);

  return (
    <section aria-label={label} className="min-w-0 rounded-panel border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <p className="font-medium text-text">
          {label} <span className="font-normal text-muted">compact JWS</span>
        </p>
        <div className="flex items-center gap-2">
          {/* Wrapped: a node passed in from a server page must not share an array with siblings. */}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
          <CopyButton value={jws.trim()} label="JWS" />
        </div>
      </div>

      {parts ? (
        <div className="grid gap-4 p-4">
          <p className="font-mono text-meta leading-5 break-all">
            <span className={SEGMENTS.header.text}>{parts.header}</span>
            <span className="text-muted">.</span>
            <span className={SEGMENTS.payload.text}>{parts.payload}</span>
            <span className="text-muted">.</span>
            <span className={SEGMENTS.signature.text}>{parts.signature}</span>
          </p>

          <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:grid-rows-[auto_1fr]">
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
        <div className="grid gap-3 p-4">
          <p className="text-body text-muted">
            This is not a compact JWS. A compact JWS is three base64url parts joined by dots: header, payload and signature.
          </p>
          <p className={`${block} text-text`}>{jws}</p>
        </div>
      )}
    </section>
  );
}
