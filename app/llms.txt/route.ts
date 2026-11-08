import { connection } from 'next/server';
import { DOCS, SOURCE_URL, sourceLink } from '@/app/_landing/links';
import { appUrl } from '@/lib/app-deps';
import { llmsText } from '@/lib/llms/text';
import results from '@/lib/security/results.json';
import { readResults } from '@/lib/security/view';

// /llms.txt: what Behest is and does, written for AI agents and the assistants people use to read a
// site. The links point at the origin Behest is served from, and the repository's documents become
// links once SOURCE_URL is set, as on the home page.

/** How long a client may keep the text before fetching it again, in seconds. */
const MAX_AGE_SECONDS = 300;

/** `GET`: the text, as Markdown served as plain text. */
export async function GET() {
  // Reads APP_URL from the environment on each request, never at build time.
  await connection();

  const text = llmsText({
    appUrl: appUrl(),
    sourceUrl: SOURCE_URL,
    docs: DOCS.map(({ label, path }) => ({ label, path, url: sourceLink(path) })),
    security: readResults(results),
  });
  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `public, max-age=${MAX_AGE_SECONDS}` },
  });
}
