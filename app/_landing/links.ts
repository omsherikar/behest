// Where the landing page sends readers for the code and the docs. The repository is private for
// now, so the page names the in-repo paths instead of linking to them. Once it is public, set
// SOURCE_URL to https://github.com/omsherikar/behest and the paths become links.

export const SOURCE_URL: string | null = null;

export const DOCS = [
  { label: 'Architecture', path: 'docs/architecture.md' },
  { label: 'Deployment', path: 'docs/deploy.md' },
  { label: 'Read me', path: 'README.md' },
] as const;

/** A path in the repository as a link to it on GitHub, or null while the repository is private. */
export function sourceLink(path: string): string | null {
  return SOURCE_URL ? `${SOURCE_URL}/blob/main/${path}` : null;
}
