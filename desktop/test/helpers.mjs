import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Tests run against the compiled `dist/main` output rather than the TypeScript sources, so they
 * need no transpiler and no extra dependencies — `npm test` builds, then runs `node --test`.
 * The ad core deliberately imports no electron, which is what makes this possible.
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
  const dir = mkdtempSync(path.join(tmpdir(), 'oe-ads-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const ENABLED_CONFIG = {
  enabled: true,
  manifestUrl: null,
  affiliates: {},
  network: { provider: null, publisherId: null },
};

/** Minimal provider stub. `fills` is consumed one entry per call. */
export function stubProvider(source, ...fills) {
  const queue = [...fills];
  const calls = [];
  return {
    source,
    calls,
    async fill(slot, ctx) {
      calls.push({ slot, excluded: [...ctx.excluded] });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
}

export function fill(overrides = {}) {
  return {
    campaignId: 'c1',
    headline: 'Headline',
    body: 'Body copy',
    cta: 'Click',
    advertiser: 'Advertiser',
    imageUrl: null,
    clickUrl: 'https://example.com/offer',
    ...overrides,
  };
}
