import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The buyer's client components are bundled for the browser, so nothing they import at run time may
// reach the database, the session secret, the QR drawing or any other server code. This follows
// every import from each 'use client' file under app/buyer, through the app's own modules, and
// lists the packages they reach. Type-only imports are left out: they are erased before bundling.

const ROOT = path.join(import.meta.dirname, '..', '..');
/** Packages a browser bundle of the buyer's pages may take. */
const BROWSER_PACKAGES = new Set([
  'react',
  'next/link',
  'next/navigation',
  'next/image',
  'ag-grid-community',
  'ag-grid-react',
  '@simplewebauthn/browser',
  // Class name joining (lib/utils.ts), pure string functions.
  'clsx',
  'tailwind-merge',
]);

/** Every file under `dir`, recursively. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}

/** The specifiers a module imports or re-exports at run time. */
function runtimeImports(source: string): string[] {
  const statements = source.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm);
  return [...statements].filter(([, typeOnly]) => !typeOnly).map(([, , specifier]) => specifier);
}

/** The app module a specifier names, or null for a package. */
function resolve(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else return null;
  const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find(existsSync);
  if (!found) throw new Error(`cannot resolve ${specifier} from ${from}`);
  return found;
}

/** The packages reached from `entry`, and the app modules on the way. */
function reach(entry: string): { packages: Set<string>; modules: Set<string> } {
  const packages = new Set<string>();
  const modules = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
      const local = resolve(specifier, file);
      if (local) pending.push(local);
      else packages.add(specifier);
    }
  }
  return { packages, modules };
}

const clientFiles = filesIn(path.join(ROOT, 'app', 'buyer')).filter(
  (file) => /\.tsx?$/.test(file) && /^['"]use client['"]/.test(readFileSync(file, 'utf8')),
);

describe("the buyer's client components", () => {
  it('include the shop run, the approvals board, the ledger grid, the mandate form and its passkey signing', () => {
    const names = clientFiles.map((file) => path.relative(ROOT, file)).sort();
    expect(names).toEqual([
      'app/buyer/approvals/approvals-board.tsx',
      'app/buyer/ledger/ledger-grid.tsx',
      'app/buyer/mandate-form.tsx',
      'app/buyer/passkey-sign.tsx',
      'app/buyer/shop/shop-run.tsx',
    ]);
  });

  it.each(clientFiles.map((file) => [path.relative(ROOT, file), file]))('%s reaches only browser packages', (_, file) => {
    const { packages, modules } = reach(file);
    expect([...packages].filter((name) => !BROWSER_PACKAGES.has(name))).toEqual([]);
    const local = [...modules].map((module) => path.relative(ROOT, module));
    expect(local.filter((module) => /^lib\/(db|session|app-deps)|^lib\/buyer-pages\/(purchases|qr)\./.test(module))).toEqual([]);
  });

  it('would notice a server module, a type-only import aside', () => {
    expect(runtimeImports("import { appDb } from '@/lib/app-deps';\nimport type { Db } from '@/lib/db/client';")).toEqual([
      '@/lib/app-deps',
    ]);
    expect(runtimeImports("export { qrDataUrl } from './qr';\nimport 'server-only';")).toEqual(['./qr', 'server-only']);
  });
});
