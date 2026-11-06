// The answer that turns a mandate down. The compiler is told to offer exactly this option with each
// question about a limit Behest cannot enforce, such as "only on weekends", and the compile route
// puts it last on every open question, so the buyer can always decline and the page recognises it.
// Choosing it ends the flow on the buyer's page and is never sent to the compiler, which could
// otherwise compile a policy without that limit.

export const DECLINE_ANSWER = "Don't set up this mandate";

/** The text with apostrophes dropped, runs of spaces, case and a closing full stop evened out. */
function normalized(text: string): string {
  return text
    .replace(/['\u2018\u2019\u02bc]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .toLowerCase();
}

/** Whether an answer is the decline answer, however its apostrophe, spacing, case or full stop are written. */
export function isDeclineAnswer(answer: string): boolean {
  return normalized(answer) === normalized(DECLINE_ANSWER);
}

/**
 * A question's options with DECLINE_ANSWER last. An option that is the decline answer written
 * another way is replaced by it; every other option stays as the compiler wrote it.
 */
export function withDeclineOption(options: string[]): string[] {
  return [...options.filter((option) => !isDeclineAnswer(option)), DECLINE_ANSWER];
}
