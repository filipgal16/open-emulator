// Shared between main, preload, and renderer. Type-only content plus plain data constants —
// safe to import from both the tsc-compiled (CommonJS/Node) side and the esbuild-bundled
// (browser) renderer side. Nothing here may import electron or node builtins.

export type SourceId = 'fdroid' | 'local' | 'play';

export interface SourceSpec {
  id: SourceId;
  label: string;
  /** Shown when the source has nothing to offer, in place of an empty grid. */
  emptyHint: string;
}

export const SOURCES: Record<SourceId, SourceSpec> = {
  fdroid: {
    id: 'fdroid',
    label: 'F-Droid',
    emptyHint: 'Nothing matched. The catalogue is only free and open-source apps.',
  },
  local: {
    id: 'local',
    label: 'Local',
    emptyHint: 'Choose Install from file, drop an app file onto this window, or put one in android/apps/.',
  },
  play: {
    id: 'play',
    label: 'Play',
    emptyHint: 'The Play Store runs inside the guest.',
  },
};

export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

/**
 * The guest's API level. Everything the store offers is checked against this before the Install
 * button is enabled — an install that was never going to succeed is worse than an absent entry.
 */
export const DEFAULT_GUEST_SDK = 30;

/**
 * One app as shown in the grid.
 *
 * `iconUrl` is an `oe-app://` URL, never a remote one: the renderer's CSP forbids remote origins,
 * and the main process is the only thing that ever talks to a repository.
 */
export interface StoreApp {
  /** Stable across refreshes: `${source}:${packageName}`. */
  id: string;
  source: SourceId;
  packageName: string;
  name: string;
  summary: string;
  iconUrl: string | null;
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  license: string | null;
  /** Minimum API level this build installs on. */
  minSdk: number;
  /** ABIs the APK carries native code for. Empty means pure bytecode — runs on any guest. */
  abis: string[];
  categories: string[];
  lastUpdated: number;
  /** F-Droid anti-feature ids (`Ads`, `Tracking`, `NonFreeNet`…), surfaced rather than hidden. */
  antiFeatures: string[];
}

export interface AppVersion {
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  minSdk: number;
  added: number;
}

export interface AppDetail extends StoreApp {
  description: string;
  webSite: string | null;
  sourceCode: string | null;
  /** `oe-app://` URLs, already cached by the time the detail pane renders them. */
  screenshotUrls: string[];
  /** Newest first, excluding the one in `versionName`/`versionCode`. */
  otherVersions: AppVersion[];
}

export type InstallState =
  | 'queued'
  | 'downloading'
  | 'verifying'
  /** Taking the pieces this device needs out of an app bundle (.xapk, .apks). */
  | 'unpacking'
  | 'installing'
  | 'done'
  | 'failed';

export interface InstallJob {
  id: string;
  /** The id the job was started against. Stable for the job's whole life, so the UI can match it. */
  packageName: string;
  /**
   * The real package the guest ended up with.
   *
   * Only differs for a local APK, whose package name isn't knowable until it is installed — the
   * job is started against a filename. Kept separate rather than overwriting `packageName`, so a
   * card that started a job can still find it once the guest has answered.
   */
  resolvedPackage: string | null;
  label: string;
  source: SourceId;
  state: InstallState;
  bytesDone: number;
  /** 0 when the server sent no content-length; the UI shows an indeterminate bar. */
  bytesTotal: number;
  /**
   * Why the job failed. Also set on a `done` job when the app installed but something after it
   * did not — a game's data files that could not be copied — since the install itself stands.
   */
  error: string | null;
  startedAt: number;
}

export interface StoreState {
  /** Whether the F-Droid catalogue has been distilled and is searchable. */
  indexReady: boolean;
  indexUpdatedAt: number | null;
  indexAppCount: number;
  /** Null until the guest has been asked. Installs stay disabled while it is unknown. */
  guestSdk: number | null;
  /** True when the running guest profile actually carries the Play Store app. */
  playAvailable: boolean;
  /**
   * True when the guest's build fingerprint has been rewritten by customize_device.sh. Play
   * refuses to sign in on an uncertified fingerprint, so the Play tab warns instead of failing.
   */
  identitySpoofed: boolean;
}

export const INITIAL_STORE_STATE: StoreState = {
  indexReady: false,
  indexUpdatedAt: null,
  indexAppCount: 0,
  guestSdk: null,
  playAvailable: false,
  identitySpoofed: false,
};

/** Why an app can't be installed right now, or null when it can. */
export function installBlockedReason(app: StoreApp, guestSdk: number | null): string | null {
  if (guestSdk === null) return 'Waiting for the guest';
  if (app.minSdk > guestSdk) return `Needs API ${app.minSdk} (guest is ${guestSdk})`;
  return null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
