// The answer that turns a mandate down. The compiler offers one, in its own words, with each question
// about a limit Behest cannot enforce, such as "only on weekends". The compile route swaps that wording
// for this exact option on every question, so the buyer can always decline and the page recognises it.
// Choosing it ends the flow on the buyer's page and is never sent to the compiler, which could
// otherwise compile a policy without that limit.

export const DECLINE_ANSWER = "Don't set up this mandate";

/** The text with typographic apostrophes, runs of spaces, case and a closing full stop evened out. */
function normalized(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .toLowerCase();
}

/** Whether an answer is the decline answer, however its apostrophe, spacing, case or full stop are written. */
export function isDeclineAnswer(answer: string): boolean {
  return normalized(answer) === normalized(DECLINE_ANSWER);
}

/** How the compiler words a decline: "Don't create this mandate", "Do not set up the mandate" and so on. */
const DECLINE_WORDING = /^\s*(don['\u2019]?t|do not)\b.*\bmandate\b/i;

/** A question's options with any the compiler worded as a decline taken out, then DECLINE_ANSWER last. */
export function withDeclineOption(options: string[]): string[] {
  return [...options.filter((option) => !DECLINE_WORDING.test(option)), DECLINE_ANSWER];
}
