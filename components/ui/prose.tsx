import { Fragment } from 'react';
import { type ProseInline, proseBlocks } from '@/lib/ui/prose';

// A model's prose as the reader sees it: paragraphs, bullet and numbered lists, bold, emphasis and
// inline code, from the light Markdown models write (lib/ui/prose.ts). Every part is drawn as text
// inside the page's own elements, never as HTML.

function Inline({ parts }: { parts: readonly ProseInline[] }) {
  return parts.map((part, index) => {
    switch (part.kind) {
      case 'strong':
        return (
          <strong key={index} className="font-semibold text-text">
            {part.text}
          </strong>
        );
      case 'em':
        return <em key={index}>{part.text}</em>;
      case 'code':
        return (
          <code key={index} className="font-mono text-[0.9em]">
            {part.text}
          </code>
        );
      default:
        return <Fragment key={index}>{part.text}</Fragment>;
    }
  });
}

export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={['grid gap-3', className].filter(Boolean).join(' ')}>
      {proseBlocks(text).map((block, index) => {
        if (block.kind === 'paragraph') {
          return (
            <p key={index}>
              {block.lines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex > 0 && <br />}
                  <Inline parts={line} />
                </Fragment>
              ))}
            </p>
          );
        }
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List key={index} className={`grid gap-1.5 pl-5 marker:text-faint ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="pl-1">
                <Inline parts={item} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
