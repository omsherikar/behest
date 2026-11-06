// Wrapping third-party text, such as what a buyer wrote in a PayPal dispute, before Claude reads it, so the
// model can tell data from instructions and the text cannot end the wrapper early. Every `<` becomes the
// six characters `<`: inside a JSON string that is the same character once parsed, and as plain text
// it still reads, but no tag can be opened or closed. Control characters other than newline and tab are
// dropped, as are invisible format characters that can hide or reorder text. Long text is cut on a code
// point boundary with `...` marking the cut.

/** A source name is lowercase letters and underscores, so it cannot break out of its attribute. */
const SOURCE_NAME = /^[a-z_]+$/;

/** Control characters except newline and tab. */
const CONTROL = /[^\P{Cc}\n\t]/gu;

/**
 * Invisible format characters that can hide or reorder text: bidirectional embeddings, overrides and
 * isolates, zero-width space and non-joiner, word joiner, zero-width no-break space, and Unicode tag
 * characters, which mirror ASCII invisibly. The zero-width joiner is kept because emoji sequences need it.
 */
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B\u200C\u2060\uFEFF\u{E0000}-\u{E007F}]/gu;

/** `text` made well-formed, without control characters other than newline and tab or invisible format characters. */
export function removeHiddenCharacters(text: string): string {
  return text.toWellFormed().replace(CONTROL, '').replace(INVISIBLE, '');
}

/**
 * `text` as `<untrusted source="<source>">...</untrusted>`, escaped as above and cut to `maxLen` UTF-16
 * code units (counted after escaping), plus `...` when cut.
 */
export function wrapUntrusted(source: string, text: string, maxLen: number): string {
  if (!SOURCE_NAME.test(source)) {
    throw new Error(`An untrusted source is named in lowercase letters and underscores, not ${JSON.stringify(source)}`);
  }
  const escaped = removeHiddenCharacters(text).replaceAll('<', '\\u003c');
  return `<untrusted source="${source}">${cut(escaped, maxLen)}</untrusted>`;
}

/** `text` cut to `maxLen` code units with `...` added, stepping back rather than splitting a surrogate pair. */
function cut(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let end = maxLen;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}...`;
}
