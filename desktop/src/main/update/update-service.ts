import type { UpdateState } from '../../shared/update-types';

/**
 * The slice of electron-updater's `AppUpdater` this module drives.
 *
 * Declared here rather than imported so this file loads under plain `node --test` with no electron
 * present — the same rule `store/` and `account/` follow. `index.ts` hands in the real one.
 */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (arg: never) => void): unknown;
}

export interface UpdateServiceOptions {
  /** Null in a development run: electron-updater only works from an installed build. */
  updater: Updater | null;
  currentVersion: string;
  onChange?: (state: UpdateState) => void;
  now?: () => number;
}

const DEV_BUILD_MESSAGE = 'Updates are checked by the installed app, not a development run.';

/**
 * Checks for, downloads, and installs new versions — each only when asked.
 *
 * The rules this enforces, whatever the caller does:
 *   - **Nothing downloads on its own.** A check may happen on a timer; a download only ever starts
 *     from `download()`, which someone has to click.
 *   - **Never backwards.** A feed carrying an older version is not an update. The build this
 *     replaces compared version strings with `!==`, which offered a downgrade as one.
 *   - **A finished download is not thrown away.** A timed check while one is downloading or
 *     waiting to install would otherwise reset the state and lose it.
 */
export class UpdateService {
  private state: UpdateState;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? Date.now;
    const { updater } = options;
    this.state = {
      phase: updater ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      latestVersion: null,
      percent: null,
      message: updater ? null : DEV_BUILD_MESSAGE,
      checkedAt: null,
    };
    if (!updater) return;

    updater.autoDownload = false;
    // Only reachable after a download someone chose: if they close the app instead of pressing
    // "Restart to update", it installs then rather than being fetched again next time.
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;

    updater.on('checking-for-update', () => this.set({ phase: 'checking', message: null }));
    updater.on('update-available', (info: UpdateInfoLike) =>
      this.set({ phase: 'available', latestVersion: versionOf(info), checkedAt: this.now(), message: null }),
    );
    updater.on('update-not-available', () =>
      this.set({ phase: 'up-to-date', latestVersion: null, checkedAt: this.now(), message: null }),
    );
    updater.on('download-progress', (progress: { percent?: number }) =>
      this.set({ phase: 'downloading', percent: clampPercent(progress?.percent) }),
    );
    updater.on('update-downloaded', (info: UpdateInfoLike) =>
      this.set({ phase: 'ready', percent: 100, latestVersion: versionOf(info) ?? this.state.latestVersion }),
    );
    updater.on('error', (err: unknown) => this.fail(err));
  }

  get(): UpdateState {
    return { ...this.state };
  }

  /** Asks whether a newer version exists. Never downloads it. */
  async check(): Promise<UpdateState> {
    const { updater } = this.options;
    if (!updater) return this.get();
    if (this.state.phase === 'downloading' || this.state.phase === 'ready') return this.get();

    if (!this.inFlight) {
      this.set({ phase: 'checking', message: null });
      this.inFlight = updater
        .checkForUpdates()
        .then(
          (result) => {
            // electron-updater answers null, and emits nothing, when it decides it isn't active.
            // Without this the state would sit on "checking" forever.
            if (result == null && this.state.phase === 'checking') {
              this.set({ phase: 'unsupported', message: DEV_BUILD_MESSAGE });
            }
          },
          (err: unknown) => this.fail(err),
        )
        .finally(() => {
          this.inFlight = null;
        });
    }
    await this.inFlight;
    return this.get();
  }

  /** Downloads the version a check found. Refused unless one is on offer. */
  async download(): Promise<UpdateState> {
    const { updater } = this.options;
    if (!updater || this.state.phase !== 'available') return this.get();
    this.set({ phase: 'downloading', percent: 0, message: null });
    try {
      await updater.downloadUpdate();
    } catch (err) {
      this.fail(err);
    }
    return this.get();
  }

  /**
   * Quits, installs, and reopens. Refused unless a download has finished.
   *
   * Silent, because the installer is per-user and already knows where the app lives — its pages
   * would only ask questions that were answered at first install.
   */
  install(): boolean {
    const { updater } = this.options;
    if (!updater || this.state.phase !== 'ready') return false;
    updater.quitAndInstall(true, true);
    return true;
  }

  private fail(err: unknown): void {
    this.set({ phase: 'error', percent: null, message: describeUpdateError(err) });
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange?.(this.get());
  }
}

interface UpdateInfoLike {
  version?: unknown;
}

function versionOf(info: UpdateInfoLike | undefined): string | null {
  return typeof info?.version === 'string' && info.version ? info.version : null;
}

function clampPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * electron-updater's errors are written for developers ("Unable to find latest version on GitHub
 * (https://…releases.atom), please ensure a production release exists: HttpError: 404 …"). These
 * are the few a person can act on, said plainly.
 */
export function describeUpdateError(err: unknown): string {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  const text = err instanceof Error ? err.message : String(err ?? '');

  if (
    // What the GitHub provider actually throws for a private repository: its releases feed answers
    // 404 to anyone signed out, which is every installed copy. Observed, not assumed — the
    // ERR_UPDATER_* codes below are what the library's own wrappers use for the other cases.
    code === 'HTTP_ERROR_404' ||
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
  ) {
    return "No published release could be read. If the repository is private, installed copies can't see its releases.";
  }
  if (code === 'HTTP_ERROR_403' || code === 'HTTP_ERROR_429') {
    return 'GitHub is limiting requests right now. Try again later.';
  }
  if (code === 'ERR_CHECKSUM_MISMATCH') {
    return "The download didn't match its published checksum, so it was discarded. Try again.";
  }
  if (/net::ERR_CERT_/.test(text)) {
    // Seen behind a proxy or security software that re-signs HTTPS with its own certificate.
    return "Couldn't make a secure connection to GitHub: its certificate wasn't trusted. A proxy or security software may be intercepting the connection.";
  }
  if (
    /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)$/.test(code) ||
    /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION|NETWORK|TIMED_OUT)/.test(text)
  ) {
    return "Couldn't reach GitHub to check for updates. Check your connection and try again.";
  }
  const first = text.split('\n')[0].trim();
  if (!first) return 'Updating failed for an unknown reason.';
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Checks on a timer — never downloads. The first check waits so it doesn't compete with startup and
 * a guest booting; after that it repeats, since the app is often left open for days.
 *
 * Returns a function that stops it.
 */
export function scheduleChecks(
  service: UpdateService,
  { firstDelayMs = 30_000, everyMs = 6 * 60 * 60_000, timers = REAL_TIMERS }: {
    firstDelayMs?: number;
    everyMs?: number;
    timers?: Timers;
  } = {},
): () => void {
  const run = () => void service.check();
  let interval: unknown = null;
  const first = timers.setTimeout(() => {
    run();
    interval = timers.setInterval(run, everyMs);
  }, firstDelayMs);
  return () => {
    timers.clearTimeout(first);
    if (interval !== null) timers.clearInterval(interval);
  };
}
