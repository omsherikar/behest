import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Import-boundary checks: which of the repo's modules a file reaches through its imports.

export const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Repo-relative paths of the modules `file` reaches through its imports, itself included. */
export function modulesReachedFrom(file: string, reached = new Set<string>()): Set<string> {
  const path = relative(REPO_ROOT, file);
  if (reached.has(path)) return reached;
  reached.add(path);
  if (!existsSync(file)) return reached;
  // Static, side-effect and dynamic imports, and re-exports.
  for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const base = specifier.startsWith('@/')
      ? join(REPO_ROOT, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(file), specifier)
        : null;
    if (base === null) continue;
    const target = [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate)) ?? base;
    modulesReachedFrom(target, reached);
  }
  return reached;
}
