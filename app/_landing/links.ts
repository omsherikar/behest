// Where the landing page sends readers for the code and the docs: the public repository on GitHub.
// Set SOURCE_URL to null to name the in-repo paths instead of linking to them.

export const SOURCE_URL: string | null = 'https://github.com/omsherikar/behest';

export const DOCS = [
  { label: 'Architecture', path: 'docs/architecture.md' },
  { label: 'Deployment', path: 'docs/deploy.md' },
  { label: 'Read me', path: 'README.md' },
] as const;

/** A path in the repository as a link to it on GitHub, or null when SOURCE_URL is not set. */
export function sourceLink(path: string): string | null {
  return SOURCE_URL ? `${SOURCE_URL}/blob/main/${path}` : null;
}
