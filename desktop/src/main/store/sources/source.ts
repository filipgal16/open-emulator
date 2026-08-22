import type { AppDetail, SourceId, StoreApp } from '../../../shared/store-types';

/**
 * What the installer needs to actually put an app in the guest.
 *
 * `sha256` is null only for a file the user handed us directly — there is nothing to compare a
 * local APK against, and demanding a digest the user cannot produce would break drag-and-drop.
 * For anything fetched over the network it is mandatory; see `installer.ts`.
 */
export interface DownloadSpec {
  packageName: string;
  label: string;
  source: SourceId;
  /** `url` is fetched over https; `file` is already on the host filesystem. */
  kind: 'url' | 'file';
  location: string;
  sha256: string | null;
  sizeBytes: number;
  versionName: string;
}

/**
 * One place apps come from.
 *
 * Deliberately narrow: everything a source must do is answer a query, describe one app, and hand
 * back something installable. The Play source is not one of these — the real Play client renders
 * inside the guest and does its own installing, so it has no catalogue for us to search.
 */
export interface AppSource {
  readonly id: SourceId;
  /** Ranked matches. An empty query means "browse". */
  search(query: string, guestSdk: number | null, limit: number): Promise<StoreApp[]>;
  detail(packageName: string, guestSdk: number | null): Promise<AppDetail | null>;
  resolve(packageName: string, versionCode: number | null, guestSdk: number | null): Promise<DownloadSpec | null>;
}
