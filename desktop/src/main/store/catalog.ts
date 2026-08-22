import type { AppDetail, SourceId, StoreApp } from '../../shared/store-types';
import type { AppSource, DownloadSpec } from './sources/source';

export interface SearchRequest {
  query: string;
  /** Null searches every catalogue source at once. */
  source: SourceId | null;
  guestSdk: number | null;
  limit: number;
}

/**
 * The searchable sources behind one search box.
 *
 * Play is deliberately absent: it has no catalogue to query from here — the real client does its
 * own searching inside the guest — so mixing it in would mean inventing listings we cannot
 * actually produce.
 */
export class Catalog {
  private readonly bySource = new Map<SourceId, AppSource>();

  constructor(sources: AppSource[]) {
    for (const source of sources) this.bySource.set(source.id, source);
  }

  sources(): SourceId[] {
    return [...this.bySource.keys()];
  }

  async search(request: SearchRequest): Promise<StoreApp[]> {
    const { query, source, guestSdk, limit } = request;

    if (source !== null) {
      const only = this.bySource.get(source);
      return only ? this.safeSearch(only, query, guestSdk, limit) : [];
    }

    // Local first, and not by relevance: those files are the user's own, there are rarely more
    // than a handful, and burying them under 60 catalogue hits would make drag-and-drop feel
    // like it had failed.
    const local = this.bySource.get('local');
    const localHits = local ? await this.safeSearch(local, query, guestSdk, 12) : [];

    const others = [...this.bySource.values()].filter((candidate) => candidate.id !== 'local');
    const rest = await Promise.all(
      others.map((candidate) => this.safeSearch(candidate, query, guestSdk, limit - localHits.length)),
    );

    return [...localHits, ...rest.flat()].slice(0, limit);
  }

  detail(source: SourceId, packageName: string, guestSdk: number | null): Promise<AppDetail | null> {
    const found = this.bySource.get(source);
    return found ? found.detail(packageName, guestSdk) : Promise.resolve(null);
  }

  resolve(
    source: SourceId,
    packageName: string,
    versionCode: number | null,
    guestSdk: number | null,
  ): Promise<DownloadSpec | null> {
    const found = this.bySource.get(source);
    return found ? found.resolve(packageName, versionCode, guestSdk) : Promise.resolve(null);
  }

  /** One broken source returns nothing rather than emptying the whole result set. */
  private async safeSearch(
    source: AppSource,
    query: string,
    guestSdk: number | null,
    limit: number,
  ): Promise<StoreApp[]> {
    if (limit <= 0) return [];
    try {
      return await source.search(query, guestSdk, limit);
    } catch {
      return [];
    }
  }
}
