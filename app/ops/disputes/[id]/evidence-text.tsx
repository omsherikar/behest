import { Fragment } from 'react';
import { type EvidenceInline, evidenceBlocks } from '@/lib/ops-pages/evidence';

// Evidence text as the operator reads it: what someone else wrote, which the pack quotes as
// `<untrusted source="...">`, shown as a quoted chip that says whose words they are, and lines that
// start with "- " shown as a list. Display only: the text PayPal is sent is the pack's own, unchanged
// (lib/ops-pages/evidence.ts gives the exact text back, and a test holds it to that).

const SOURCES: Record<string, string> = {
  seller_listing: "from the seller's listing",
  shopping_agent: 'from the agent',
  agent: 'from the agent',
  paypal_error: 'from PayPal',
};

function Parts({ parts }: { parts: readonly EvidenceInline[] }) {
  return parts.map((part, index) =>
    part.kind === 'text' ? (
      <Fragment key={index}>{part.text}</Fragment>
    ) : (
      <span
        key={index}
        className="mx-0.5 inline rounded-md border border-line-strong bg-raised px-1.5 py-px font-mono text-[0.8125rem] whitespace-pre-wrap text-text"
      >
        <span className="mr-1.5 font-sans text-[0.6875rem] text-muted">{SOURCES[part.source] ?? 'quoted'}</span>
        &ldquo;{part.text}&rdquo;
      </span>
    ),
  );
}

export function EvidenceText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`grid gap-1 wrap-anywhere ${className}`}>
      {evidenceBlocks(text).map((block, index) =>
        block.kind === 'lines' ? (
          <div key={index}>
            {block.lines.map((line, at) => (
              // An empty line keeps its height, as a blank line between paragraphs.
              <p key={at} className="min-h-[1lh]">
                <Parts parts={line} />
              </p>
            ))}
          </div>
        ) : (
          <ul key={index} className="grid list-disc gap-1 pl-5 marker:text-muted">
            {block.items.map((item, at) => (
              <li key={at} className={item.prefix.length > 2 ? 'ml-5' : undefined}>
                <Parts parts={item.parts} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
