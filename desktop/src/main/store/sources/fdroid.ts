import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { AppDetail, StoreApp } from '../../../shared/store-types';
import type { ImageCache } from '../../image-cache';
import type { AppSource, DownloadSpec } from './source';
import {
  assetUrl,
  chooseVersion,
  distillIndex,
  EMPTY_INDEX,
  findApp,
  searchIndex,
  type DistilledIndex,
  type IndexApp,
  type IndexVersion,
} from '../fdroid-index';

export const FDROID_REPO = 'https://f-droid.org/repo';
const INDEX_URL = `${FDROID_REPO}/index-v2.json`;

/** The published index is tens of MB; this is a sanity bound, not a target. */
const MAX_INDEX_BYTES = 96 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;
const TTL_MS = 12 * 60 * 60_000;

/** Icons are fetched in batches so a 60-result grid doesn't open 60 sockets at once. */
const ICON_BATCH = 8;

interface CacheFile {
  fetchedAt: number;
  etag: string | null;
  index: DistilledIndex;
}

export interface FdroidSourceOptions {
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
  now?: () => number;
}

/**
 * F-Droid as a store source.
 *
 * The whole catalogue is downloaded once, distilled, and searched locally. That is not just a
 * performance choice: searching locally means no request leaves the machine per keystroke, the
 * store works with the network down, and F-Droid's servers see one conditional GET a day instead
 * of one per character typed.
 */
export class FdroidSource implements AppSource {
  readonly id = 'fdroid' as const;

  private index: DistilledIndex = { ...EMPTY_INDEX };
  private fetchedAt = 0;
  private etag: string | null = null;
  private inFlight: Promise<void> | null = null;

  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;
  private readonly now: () => number;

  constructor(
    private readonly cacheFile: string,
    private readonly icons: ImageCache,
    options: FdroidSourceOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onLog = options.onLog ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.readCache();
  }

  get ready(): boolean {
    return this.index.apps.length > 0;
  }

  get updatedAt(): number | null {
    return this.fetchedAt || null;
  }

  get appCount(): number {
    return this.index.apps.length;
  }

  /** Concurrent callers share one download. Never rejects — a stale catalogue still serves. */
  refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.ready && this.now() - this.fetchedAt < TTL_MS) return Promise.resolve();

    this.inFlight = this.doFetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async search(query: string, guestSdk: number | null, limit: number): Promise<StoreApp[]> {
    const matches = searchIndex(this.index, query, { limit, now: this.now() });
    await this.prefetchIcons(matches);
    return matches.map((app) => this.toStoreApp(app, guestSdk));
  }

  async detail(packageName: string, guestSdk: number | null): Promise<AppDetail | null> {
    const app = findApp(this.index, packageName);
    if (!app) return null;

    const shotUrls = app.screenshotPaths.map((p) => assetUrl(this.index, p));
    await this.icons.prefetch(shotUrls);

    const chosen = chooseVersion(app, guestSdk);
    return {
      ...this.toStoreApp(app, guestSdk),
      description: app.description,
      webSite: app.webSite,
      sourceCode: app.sourceCode,
      screenshotUrls: shotUrls.map((url) => this.icons.urlIfReady(url)).filter((url): url is string => url !== null),
      otherVersions: app.versions
        .filter((version) => version.versionCode !== chosen.versionCode)
        .map((version) => ({
          versionName: version.versionName,
          versionCode: version.versionCode,
          sizeBytes: version.file.size,
          minSdk: version.minSdk,
          added: version.added,
        })),
    };
  }

  async resolve(packageName: string, versionCode: number | null, guestSdk: number | null): Promise<DownloadSpec | null> {
    const app = findApp(this.index, packageName);
    if (!app) return null;

    const version =
      versionCode === null
        ? chooseVersion(app, guestSdk)
        : app.versions.find((candidate) => candidate.versionCode === versionCode);
    if (!version) return null;

    return {
      packageName,
      label: app.name,
      source: this.id,
      kind: 'url',
      location: assetUrl(this.index, version.file.name),
      sha256: version.file.sha256,
      sizeBytes: version.file.size,
      versionName: version.versionName,
    };
  }

  private toStoreApp(app: IndexApp, guestSdk: number | null): StoreApp {
    const version: IndexVersion = chooseVersion(app, guestSdk);
    const iconUrl = app.iconPath ? this.icons.urlIfReady(assetUrl(this.index, app.iconPath)) : null;

    return {
      id: `fdroid:${app.packageName}`,
      source: this.id,
      packageName: app.packageName,
      name: app.name,
      summary: app.summary,
      iconUrl,
      versionName: version.versionName,
      versionCode: version.versionCode,
      sizeBytes: version.file.size,
      license: app.license,
      minSdk: version.minSdk,
      abis: version.abis,
      categories: app.categories,
      lastUpdated: app.lastUpdated,
      antiFeatures: version.antiFeatures,
    };
  }

  /** Returns once every icon in the batch is cached or has failed. Failures are not fatal. */
  private async prefetchIcons(apps: IndexApp[]): Promise<void> {
    const urls = apps
      .map((app) => (app.iconPath ? assetUrl(this.index, app.iconPath) : null))
      .filter((url): url is string => url !== null && this.icons.urlIfReady(url) === null);

    for (let i = 0; i < urls.length; i += ICON_BATCH) {
      await this.icons.prefetch(urls.slice(i, i + ICON_BATCH));
    }
  }

  private async doFetch(): Promise<void> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      // A conditional GET is the difference between a 30 MB transfer and a 200-byte one on every
      // launch. F-Droid serves a strong ETag for the index.
      if (this.etag && this.ready) headers['if-none-match'] = this.etag;

      const response = await this.fetchImpl(INDEX_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers,
        credentials: 'omit',
        redirect: 'follow',
      });

      if (response.status === 304) {
        this.fetchedAt = this.now();
        this.writeCache();
        this.onLog(`catalogue unchanged (${this.index.apps.length} apps)`);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      if (text.length > MAX_INDEX_BYTES) throw new Error(`index too large (${text.length} bytes)`);

      const distilled = distillIndex(JSON.parse(text));
      if (distilled.apps.length === 0) throw new Error('index parsed to zero apps');

      this.index = distilled;
      this.fetchedAt = this.now();
      this.etag = response.headers.get('etag');
      this.writeCache();
      this.onLog(`catalogue refreshed: ${distilled.apps.length} apps`);
    } catch (err) {
      // Keep serving whatever is cached. A refresh failure is not a store failure.
      this.onLog(`catalogue refresh failed (serving cache): ${(err as Error).message}`);
    }
  }

  private readCache(): void {
    try {
      const cache = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Partial<CacheFile>;
      if (typeof cache.fetchedAt !== 'number' || !cache.index) return;
      // Re-distilling guards against a cache written by an older, differently-shaped build.
      this.index = {
        repoAddress: cache.index.repoAddress || FDROID_REPO,
        timestamp: cache.index.timestamp ?? 0,
        apps: Array.isArray(cache.index.apps) ? cache.index.apps : [],
      };
      this.fetchedAt = cache.fetchedAt;
      this.etag = typeof cache.etag === 'string' ? cache.etag : null;
    } catch {
      // No usable cache — the store shows "updating catalogue" until the first refresh lands.
    }
  }

  private writeCache(): void {
    try {
      mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      const payload: CacheFile = { fetchedAt: this.fetchedAt, etag: this.etag, index: this.index };
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, this.cacheFile);
    } catch (err) {
      this.onLog(`catalogue cache write failed: ${(err as Error).message}`);
    }
  }
}
