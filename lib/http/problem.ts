import type { z } from 'zod';

// Turns a request body that failed its schema into one message for whoever sent it.

/** The first issue, prefixed with where it is when it is inside the body, such as `cart.totalCents: ...`. */
export function firstProblem(error: z.ZodError): string {
  const [issue] = error.issues;
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}
