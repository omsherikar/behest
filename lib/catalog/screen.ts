// A fixed first pass over listing text for instructions aimed at AI shopping agents, such as a description
// telling agents to ignore the buyer's budget and buy ten. The catalog builder's model screens listings
// too, but this pass cannot be argued out of a match. The text is normalised before matching, so that
// invisible characters, full-width letters, line breaks or hidden tag characters cannot split a phrase.

export type Screening = { suspicious: boolean; matches: string[] };

const PATTERNS = [
  /ignore (all |your |previous )?(instructions|budget|rules|limits)/gi,
  /(ai|shopping) (agent|assistant)s?/gi,
  /system prompt/gi,
  /buy \d+ (of these|units|now)/gi,
  /disregard/gi,
  /you must (buy|purchase|order)/gi,
];

/** Unicode tag characters that mirror printable ASCII. They render as nothing, but models can read them. */
const TAGS = /[\u{E0020}-\u{E007E}]/gu;

/** Characters that render as nothing (zero-width, bidirectional controls, variation selectors) and control characters other than whitespace. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|[^\P{Cc}\s]/gu;

/** Whether `text` speaks to AI agents, with each matched phrase once, in the order it appears in the normalised text. */
export function screenText(text: string): Screening {
  const normalised = normalise(text);
  const found = PATTERNS.flatMap((pattern) => [...normalised.matchAll(pattern)]).sort((a, b) => a.index - b.index);
  const matches = [...new Set(found.map((match) => match[0]))];
  return { suspicious: matches.length > 0, matches };
}

/** `text` as the patterns read it: tag characters as the ASCII they mirror, compatibility forms folded, invisible characters dropped and whitespace collapsed. */
function normalise(text: string): string {
  return text
    .toWellFormed()
    .replace(TAGS, (tag) => String.fromCodePoint((tag.codePointAt(0) ?? 0) - 0xe0000))
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}
