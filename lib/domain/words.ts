// Small pieces of wording shared by every sentence a buyer reads, so the policy gate and the
// mandate readback describe the same thing in the same words.

/** A count with its noun: `plural(1, 'hour')` is "1 hour", `plural(24, 'hour')` is "24 hours". */
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
