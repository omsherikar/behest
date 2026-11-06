// Wrapping third-party text, such as what a buyer wrote in a PayPal dispute, before Claude reads it, so the
// model can tell data from instructions and the text cannot end the wrapper early. Every `<` becomes the
// six characters `<`: inside a JSON string that is the same character once parsed, and as plain text
// it still reads, but no tag can be opened or closed. Control characters other than newline and tab are
// dropped, and long text is cut on a code point boundary with `...` marking the cut.

/** A source name is lowercase letters and underscores, so it cannot break out of its attribute. */
const SOURCE_NAME = /^[a-z_]+$/;

/** Control characters except newline and tab. */
const CONTROL = /[^\P{Cc}\n\t]/gu;

/**
 * `text` as `<untrusted source="<source>">...</untrusted>`, escaped as above and cut to `maxLen` UTF-16
 * code units (counted after escaping), plus `...` when cut.
 */
export function wrapUntrusted(source: string, text: string, maxLen: number): string {
  if (!SOURCE_NAME.test(source)) {
    throw new Error(`An untrusted source is named in lowercase letters and underscores, not ${JSON.stringify(source)}`);
  }
  const escaped = text.toWellFormed().replace(CONTROL, '').replaceAll('<', '\\u003c');
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
