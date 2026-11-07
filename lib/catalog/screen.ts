// A fixed first pass over listing text for instructions aimed at AI shopping agents, such as a description
// telling agents to ignore the buyer's budget and buy ten. The catalog builder's model screens listings
// too, but this pass cannot be argued out of a match. The text is normalised before matching, so that
// invisible characters, full-width letters, line breaks or hidden tag characters cannot split a phrase.
//
// Phrases come in two strengths. A strong phrase, such as `ignore your budget` or `include the
// buyer's email`, has no honest use in a listing and flags it alone. A weak phrase, such as `buy 2
// now` or `AI assistant`, also appears in ordinary copy, so it flags a listing only next to a
// different weak phrase or a strong one.

export type Screening = {
  suspicious: boolean;
  /** Every matched phrase, strong and weak, once each in the order it appears. */
  matches: string[];
  strong: string[];
  weak: string[];
};

/** Whose data a listing has no business asking for: the person the agent shops for, as `buyer`, `buyer's` or `buyers'`. */
const PERSON = String.raw`(?:buyer|user|customer|shopper|purchaser)s?(?:['\u2019]s?)?`;

/** Personal data: an email, a postal address, a phone number, contact details or personal information. */
const PERSONAL_DATA = String.raw`(?:full\s+)?(?:e-?mail(?:\s+address(?:es)?)?|(?:home|shipping|billing|mailing|delivery|postal|street)?\s*address(?:es)?|(?:phone|telephone|mobile|cell)(?:\s+numbers?)?|contact\s+(?:details|info(?:rmation)?)|personal\s+(?:data|details|info(?:rmation)?))`;

/**
 * Asking someone to hand over or include that person's data: `include the buyer's email`, `send us
 * the user's address`. Not after a negation, so `we never share the customer's email` or `we don't
 * sell or share the buyer's address` passes. `your email` is the reader's own, so it passes too.
 */
const HAND_OVER_PERSONAL_DATA = new RegExp(
  String.raw`(?<!(?:\bnever|\bnot|\bno|n['\u2019]t)\s+(?:ever\s+)?(?:\w+\s+or\s+)?)\b(?:include|reveal|share|disclose|leak|expose|attach|put|pass\s+on|(?:send|give|tell|forward|email|text)\s+(?:us|me))\s+(?:(?:all|both|also)\s+)?(?:(?:the|your|their|this)\s+)?${PERSON}\s+${PERSONAL_DATA}\b`,
  'gi',
);

/** That person's data in what an agent writes, whatever the verb: `the buyer's email in your rationale`. */
const PERSONAL_DATA_IN_AGENT_OUTPUT = new RegExp(
  String.raw`\b${PERSON}\s+${PERSONAL_DATA}\b(?:\s+\S+){0,6}?\s+in\s+your\s+(?:rationale|reasoning|response|reply|answer|message|output|notes?|summary|proposal)\b`,
  'gi',
);

// Whole words only, so `Thai assistant` or `budgeting` is not a match.
const STRONG = [
  /\bignore\s+(?:(?:all|your|previous|prior|the|any|earlier)\s+)*(?:instructions?|budgets?|rules?|limits?)\b/gi,
  /\bsystem\s+prompt\b/gi,
  /\bdisregard\s+(?:(?:all|your|previous|prior|the|any)\s+)+(?:instructions?|rules?|budgets?|limits?)\b/gi,
  HAND_OVER_PERSONAL_DATA,
  PERSONAL_DATA_IN_AGENT_OUTPUT,
];

const WEAK = [
  /\b(?:ai|shopping)\s+(?:agent|assistant)s?\b/gi,
  /\bbuy\s+\d+\s+(?:of\s+these|units|now)\b/gi,
  /\byou\s+must\s+(?:buy|purchase|order)\b/gi,
];

/** Unicode tag characters that mirror printable ASCII. They render as nothing, but models can read them. */
const TAGS = /[\u{E0020}-\u{E007E}]/gu;

/** Characters that render as nothing (zero-width, bidirectional controls, variation selectors) and control characters other than whitespace. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|[^\P{Cc}\s]/gu;

/** Whether `text` speaks to AI agents: any strong phrase, or weak phrases from at least two different patterns. */
export function screenText(text: string): Screening {
  const normalised = normalise(text);
  const strong = findAll(normalised, STRONG);
  const weak = findAll(normalised, WEAK);
  return {
    suspicious: strong.patterns > 0 || weak.patterns >= 2,
    matches: phrases([...strong.matches, ...weak.matches]),
    strong: phrases(strong.matches),
    weak: phrases(weak.matches),
  };
}

/** Every match of `patterns` in `text`, and how many of the patterns matched at all. */
function findAll(text: string, patterns: RegExp[]): { matches: RegExpExecArray[]; patterns: number } {
  const perPattern = patterns.map((pattern) => [...text.matchAll(pattern)]);
  return { matches: perPattern.flat(), patterns: perPattern.filter((found) => found.length > 0).length };
}

/** The matched text of each match once, in the order the matches appear. */
function phrases(matches: RegExpExecArray[]): string[] {
  return [...new Set([...matches].sort((a, b) => a.index - b.index).map((match) => match[0]))];
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
