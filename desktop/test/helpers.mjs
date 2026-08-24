import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Anchors, so a test never counts '..' to find the tree.
 *
 * Tests live at varying depths under test/, and a relative walk silently resolves somewhere else
 * the moment a file moves — which is exactly how a directory reshuffle turned a profile lookup
 * into an empty list rather than an error.
 */
export const DESKTOP_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(here, '..', '..');

/**
 * Tests run against the compiled `dist/main` output rather than the TypeScript sources, so they
 * need no transpiler and no extra dependencies — `npm test` builds, then runs `node --test`.
 * Everything under `store/` and `account/` deliberately imports no electron except the `index.ts`
 * that owns the IPC surface, which is what makes this possible.
 */
export function loadDist(relative) {
  return require(path.join(here, '..', 'dist', 'main', relative));
}

/**
 * Scratch directory for the on-disk stores, removed when `fn` finishes.
 *
 * Always await this. `fn` is awaited before cleanup — without that, an async body would still be
 * running against a directory that had already been deleted, and since the stores swallow write
 * errors by design, the tests would pass while testing nothing.
 */
export async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'oe-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
