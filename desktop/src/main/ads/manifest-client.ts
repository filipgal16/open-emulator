import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { Manifest } from './manifest';
import { EMPTY_MANIFEST, parseManifest } from './manifest';

/** Beyond this, a cached manifest is treated as expired even if the endpoint is unreachable. */
const MAX_STALE_MS = 7 * 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 512 * 1024;

interface CacheFile {
  fetchedAt: number;
  raw: unknown;
}

export interface ManifestClientOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
}

/**
 * Keeps a campaign manifest available locally.
 *
 * Serving from cache is the normal path, not the fallback: an ad request must never wait on the
 * network, because the slot most likely to be on screen is the setup wizard's — on a machine
 * that is busy saturating its connection with a 4 GiB SDK download.
 *
 * A cached manifest also keeps serving through an outage, up to `MAX_STALE_MS`. That bound
 * matters: without it, a campaign could never be retracted from a client whose refresh is broken,
 * and an expired offer that still renders is a partner complaint at best.
 */
export class ManifestClient {
  private manifest: Manifest = { ...EMPTY_MANIFEST };
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;

  constructor(
    private readonly url: string | null,
    private readonly cacheFile: string,
    options: ManifestClientOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onLog = options.onLog ?? (() => undefined);
    this.readCache();
  }

  /**
   * Current campaigns, always returned synchronously. Kicks off a background refresh when the
   * cache has gone stale; the *next* request gets the fresher inventory.
   */
  campaigns(): Manifest['campaigns'] {
    if (!this.url) return [];
    const age = this.now() - this.fetchedAt;
    if (age > this.manifest.ttlSeconds * 1000) void this.refresh();
    return age > MAX_STALE_MS ? [] : this.manifest.campaigns;
  }

  /** Awaitable refresh, for startup prefetch and tests. Concurrent calls share one request. */
  refresh(): Promise<void> {
    if (!this.url) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.doFetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doFetch(): Promise<void> {
    const url = this.url;
    if (!url) return;

    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
        // The manifest is public inventory data; sending credentials would be both pointless
        // and a way to leak cookies to a CDN.
        credentials: 'omit',
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      if (text.length > MAX_BYTES) throw new Error(`manifest too large (${text.length} bytes)`);

      const raw = JSON.parse(text);
      const { manifest, dropped } = parseManifest(raw);
      if (dropped.length > 0) this.onLog(`manifest dropped ${dropped.length} campaign(s): ${dropped.join(', ')}`);

      this.manifest = manifest;
      this.fetchedAt = this.now();
      this.writeCache(raw);
      this.onLog(`manifest refreshed: ${manifest.campaigns.length} campaign(s)`);
    } catch (err) {
      // Keep serving whatever is cached. A refresh failure is not an ad failure.
      this.onLog(`manifest refresh failed (serving cache): ${(err as Error).message}`);
    }
  }

  private readCache(): void {
    try {
      const cache = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Partial<CacheFile>;
      if (typeof cache.fetchedAt !== 'number') return;
      this.manifest = parseManifest(cache.raw).manifest;
      this.fetchedAt = cache.fetchedAt;
    } catch {
      // No usable cache — `campaigns()` returns nothing until the first refresh lands, and the
      // house rung fills in the meantime.
    }
  }

  private writeCache(raw: unknown): void {
    try {
      mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, raw } satisfies CacheFile), 'utf8');
      renameSync(tmp, this.cacheFile);
    } catch {
      // In-memory only for this session.
    }
  }
}
