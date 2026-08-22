import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { AppDetail, StoreApp } from '../../../shared/store-types';
import type { AppSource, DownloadSpec } from './source';

/**
 * APK files already on the host: whatever sits in `android/apps/`, plus anything dropped onto the
 * window.
 *
 * No APK parsing happens here. Reading a package name out of an APK means unzipping it and
 * decoding Android's binary XML, and getting that subtly wrong would mislabel apps — while the
 * guest can answer the same question exactly, for free: `installer.ts` diffs `pm list packages -3`
 * across the install and learns the real package name from the guest itself. So a local entry is
 * honest about what it is (a file) until it has been installed.
 */
export class LocalSource implements AppSource {
  readonly id = 'local' as const;

  constructor(
    private readonly dirs: string[],
    /** Where dropped files are copied so they survive the drag they arrived on. */
    private readonly importDir: string,
  ) {}

  /** Copies a dropped APK into the managed directory. Returns its new path. */
  import(sourcePath: string): string {
    if (path.extname(sourcePath).toLowerCase() !== '.apk') {
      throw new Error('not an .apk file');
    }
    mkdirSync(this.importDir, { recursive: true });
    const dest = path.join(this.importDir, path.basename(sourcePath));
    // Same file dropped twice is a no-op rather than an error.
    if (path.resolve(sourcePath) !== path.resolve(dest)) copyFileSync(sourcePath, dest);
    return dest;
  }

  async search(query: string, _guestSdk: number | null, limit: number): Promise<StoreApp[]> {
    const needle = query.trim().toLowerCase();
    return this.files()
      .filter((file) => needle === '' || path.basename(file.path).toLowerCase().includes(needle))
      .slice(0, limit)
      .map((file) => this.toStoreApp(file));
  }

  async detail(id: string): Promise<AppDetail | null> {
    const file = this.files().find((candidate) => this.idFor(candidate.path) === id);
    if (!file) return null;
    return {
      ...this.toStoreApp(file),
      description:
        'A local APK file. Its real package name and version are read from the guest once it is ' +
        'installed.',
      webSite: null,
      sourceCode: null,
      screenshotUrls: [],
      otherVersions: [],
    };
  }

  async resolve(id: string): Promise<DownloadSpec | null> {
    const file = this.files().find((candidate) => this.idFor(candidate.path) === id);
    if (!file) return null;
    return {
      packageName: this.idFor(file.path),
      label: path.basename(file.path, '.apk'),
      source: this.id,
      kind: 'file',
      location: file.path,
      // Nothing to verify against: the user supplied this file, so there is no upstream digest
      // it is supposed to match.
      sha256: null,
      sizeBytes: file.size,
      versionName: '',
    };
  }

  /** Local entries are keyed by filename, since the package name isn't known before install. */
  private idFor(filePath: string): string {
    return path.basename(filePath);
  }

  private toStoreApp(file: { path: string; size: number; mtime: number }): StoreApp {
    const base = path.basename(file.path, '.apk');
    return {
      id: `local:${this.idFor(file.path)}`,
      source: this.id,
      packageName: this.idFor(file.path),
      name: base.replace(/[_-]+/g, ' ').trim() || base,
      summary: file.path,
      iconUrl: null,
      versionName: '',
      versionCode: 0,
      sizeBytes: file.size,
      license: null,
      // A file the user chose is never blocked on our guess about compatibility — the guest's
      // package manager is the authority, and it will say so if the APK doesn't fit.
      minSdk: 0,
      abis: [],
      categories: [],
      lastUpdated: file.mtime,
      antiFeatures: [],
    };
  }

  private files(): Array<{ path: string; size: number; mtime: number }> {
    const seen = new Set<string>();
    const found: Array<{ path: string; size: number; mtime: number }> = [];

    for (const dir of [this.importDir, ...this.dirs]) {
      if (!existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (path.extname(entry).toLowerCase() !== '.apk') continue;
        if (seen.has(entry)) continue;
        const full = path.join(dir, entry);
        try {
          const stat = statSync(full);
          if (!stat.isFile()) continue;
          seen.add(entry);
          found.push({ path: full, size: stat.size, mtime: stat.mtimeMs });
        } catch {
          // Vanished between readdir and stat — skip it.
        }
      }
    }

    return found.sort((a, b) => b.mtime - a.mtime);
  }
}
