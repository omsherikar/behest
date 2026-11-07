// The light Markdown a model writes in its prose (paragraphs, "- " and "1. " lists, **bold**,
// *emphasis* and `code`), read into blocks the page draws as its own elements. Nothing is ever
// rendered as HTML: every part is text, so a reply cannot inject markup. Anything that is not one
// of these forms, such as a lone asterisk or "5 * 3", stays as the text it was.

export type ProseInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string };

export type ProseBlock =
  /** Lines the model broke on its own, kept as line breaks inside one paragraph. */
  | { kind: 'paragraph'; lines: ProseInline[][] }
  | { kind: 'list'; ordered: boolean; items: ProseInline[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
// **strong**, `code` and *em*, each opening and closing on a non-space character.
const INLINE = /\*\*(?=\S)(.+?)(?<=\S)\*\*|`([^`\n]+)`|\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*/g;

/** The inline parts of one line. */
export function proseInline(line: string): ProseInline[] {
  const parts: ProseInline[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: 'text', text: line.slice(last, at) });
    if (match[1] !== undefined) parts.push({ kind: 'strong', text: match[1] });
    else if (match[2] !== undefined) parts.push({ kind: 'code', text: match[2] });
    else parts.push({ kind: 'em', text: match[3] });
    last = at + match[0].length;
  }
  if (last < line.length) parts.push({ kind: 'text', text: line.slice(last) });
  return parts;
}

/**
 * The blocks of a model's prose. A blank line ends a paragraph or a list; consecutive list lines of
 * one kind make one list; a line straight after a list item that is not an item continues it; a
 * heading reads as a bold paragraph of its own.
 */
export function proseBlocks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  // Whether the last block still takes lines: a blank line or a heading closes it.
  let lastOpen = false;

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      lastOpen = false;
      continue;
    }
    const last = lastOpen ? blocks[blocks.length - 1] : undefined;

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(proseInline(item[1]));
      else blocks.push({ kind: 'list', ordered, items: [proseInline(item[1])] });
      lastOpen = true;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'paragraph', lines: [[{ kind: 'strong', text: heading[1] }]] });
      lastOpen = false;
      continue;
    }

    if (last?.kind === 'list') {
      last.items[last.items.length - 1].push({ kind: 'text', text: ' ' }, ...proseInline(line.trim()));
    } else if (last?.kind === 'paragraph') {
      last.lines.push(proseInline(line));
    } else {
      blocks.push({ kind: 'paragraph', lines: [proseInline(line)] });
    }
    lastOpen = true;
  }
  return blocks;
}
