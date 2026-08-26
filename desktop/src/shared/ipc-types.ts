// Shared between main, preload, and renderer. Type-only content — safe to import from both
// the tsc-compiled (CommonJS/Node) side and the esbuild-bundled (browser) renderer side.

import type { AccountState, FillField, FillResult } from './account-types';
import type { DeviceState, ProfileId } from './device-types';
import type { Settings, SettingsState } from './settings-types';
import type { AppDetail, InstallJob, SourceId, StoreApp, StoreState } from './store-types';

export interface InstalledApp {
  packageName: string;
  label: string;
}

export type LogStream = 'stdout' | 'stderr';

export interface LogEvent {
  stream: LogStream;
  line: string;
}

export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string[];
  stderr: string[];
}

export type StepState = 'pending' | 'running' | 'pass' | 'fail' | 'warn';

export interface SetupStepStatus {
  id: string;
  label: string;
  status: StepState;
  detail: string;
  blocking: boolean;
}

export interface OpenEmuApi {
  runStatus(): Promise<CommandResult>;
  getSetupSteps(): Promise<SetupStepStatus[]>;
  runSetupChecks(): Promise<SetupStepStatus[]>;
  /** Checks everything and repairs what it can, unattended. The first-run path. */
  runSetupAuto(): Promise<SetupStepStatus[]>;
  runSetupFix(id: string): Promise<SetupStepStatus>;
  onSetupStep(callback: (status: SetupStepStatus) => void): void;
  onLog(callback: (event: LogEvent) => void): void;
  startMirror(): void;
  stopMirror(): void;
  onFrame(callback: (data: Uint8Array) => void): void;
  /**
   * Where the device pane is, in **real device pixels** — CSS pixels times `devicePixelRatio` —
   * and whether it should be showing.
   *
   * Drives both halves of the display at once: Android's logical display size, and the position of
   * the guest's own window embedded in ours. Safe to call on every resize; main debounces the
   * expensive half.
   *
   * **Resolves true when the guest's real window is embedded**, which means it is painting at the
   * emulator's own frame rate and the caller must not also mirror frames. False means fall back to
   * mirroring — the WSL runtime has no window, and embedding can be refused.
   */
  reportViewport(rect: { x: number; y: number; width: number; height: number }, visible: boolean): Promise<boolean>;
  /**
   * One PNG of the guest, captured now. Null when nothing is running or the runtime cannot capture.
   *
   * Captured on demand rather than read from the mirror, because an embedded guest produces no
   * mirrored frames — and because this way the file is at the guest's real resolution.
   */
  screenshot(): Promise<Uint8Array | null>;
  /**
   * Turns the guest a quarter turn, returning its new rotation (0–3) or null if it refused.
   *
   * Rotates Android itself rather than transforming the picture, so apps re-lay out for the new
   * orientation — and so it works at all with the guest's own window embedded, where there is no
   * image to transform.
   */
  rotateDevice(): Promise<number | null>;
  tap(x: number, y: number): void;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void;
  /** Android keycode name (`KEYCODE_BACK`) or a numeric code. Anything else is dropped in main. */
  key(keycode: string): void;
  /** Types into whatever the guest has focused. False when `input` can't send the string. */
  typeText(value: string): Promise<boolean>;
  listApps(): Promise<InstalledApp[]>;
  launchApp(packageName: string): Promise<boolean>;

  // ── Device: everything the CLI does, with buttons ────────────────────────────────────────────
  deviceState(): Promise<DeviceState>;
  deviceStart(): Promise<DeviceState>;
  deviceStop(): Promise<DeviceState>;
  /** First boot + snapshot, so later launches are quick. Safe to re-run. */
  devicePrepare(): Promise<DeviceState>;
  /** Refused while the emulator is running; the returned state carries the reason. */
  deviceSetProfile(id: ProfileId): Promise<DeviceState>;
  onDeviceState(callback: (state: DeviceState) => void): void;

  // ── Store ────────────────────────────────────────────────────────────────────────────────────
  storeState(): Promise<StoreState>;
  /** Re-asks the guest for its API level, Play presence, and identity. */
  storeProbeGuest(force?: boolean): Promise<StoreState>;
  storeRefreshIndex(force?: boolean): Promise<StoreState>;
  /** `source` null searches every catalogue source at once. */
  storeSearch(query: string, source: SourceId | null, limit?: number): Promise<StoreApp[]>;
  storeDetail(source: SourceId, packageName: string): Promise<AppDetail | null>;
  /** Null when the app or version could not be resolved. Progress arrives via `onStoreJob`. */
  storeInstall(source: SourceId, packageName: string, versionCode: number | null): Promise<InstallJob | null>;
  storeJobs(): Promise<InstallJob[]>;
  storeImportApk(filePath: string): Promise<boolean>;
  onStoreJob(callback: (job: InstallJob) => void): void;
  /** Fires once an install has really landed in the guest — the cue to re-read the app list. */
  onStoreInstalled(callback: (packageName: string) => void): void;
  onStoreIndexUpdated(callback: (state: StoreState) => void): void;
  /** Resolves a dropped `File` to its path on disk. Null when the drop carried no real file. */
  pathForFile(file: File): string | null;

  // ── Play, driven inside the guest ────────────────────────────────────────────────────────────
  playOpen(): Promise<boolean>;
  playSearch(query: string): Promise<boolean>;
  playDetails(packageName: string): Promise<boolean>;
  playBack(): Promise<boolean>;

  // ── Device-wide account ──────────────────────────────────────────────────────────────────────
  accountState(): Promise<AccountState>;
  accountRefresh(force?: boolean): Promise<AccountState>;
  accountSetEmail(email: string | null): Promise<AccountState>;
  accountSetDisplayName(name: string): Promise<AccountState>;
  /**
   * Stores or clears the Google password in the OS keychain. One-way: nothing ever reads a
   * password back out to the renderer.
   */
  accountSetPassword(password: string | null): Promise<AccountState>;
  accountSetAutofill(enabled: boolean): Promise<AccountState>;
  accountSignOut(): Promise<AccountState>;
  accountBeginSignIn(): Promise<FillResult>;
  /** Types the stored value for `field` into the guest's focused input. */
  accountFill(field: FillField): Promise<FillResult>;

  // ── Settings ─────────────────────────────────────────────────────────────────────────────────
  settingsState(): Promise<SettingsState>;
  /** Merges a partial update; invalid values fall back rather than being stored. */
  settingsSet(patch: Partial<Settings>): Promise<SettingsState>;
  /** Deletes archives and scratch. Never touches the extracted SDK or a guest. */
  settingsFreeSpace(): Promise<SettingsState>;
  /** Opens a native folder picker and moves any existing download to the chosen folder. */
  settingsChooseDownloadFolder(): Promise<SettingsState>;
  /** Relaunches the app, so a changed download location takes effect. */
  settingsRestartApp(): Promise<void>;

  // ── Antivirus exclusion (opt-in, speeds Android's disk I/O) ──────────────────────────────────
  /** Whether Defender already excludes the emulator folder: 'excluded' | 'not-excluded' | 'unknown'. */
  defenderState(): Promise<DefenderState>;
  /**
   * Adds or removes the exclusion, via a UAC prompt. Only ever called from an explicit user action.
   * Returns the state after the change, or the reason it did not happen (declined, no Defender).
   */
  defenderSetExcluded(enabled: boolean): Promise<DefenderResult>;
}

export type DefenderState = 'excluded' | 'not-excluded' | 'unknown';

export interface DefenderResult {
  state: DefenderState;
  /** Present when the change did not go through — e.g. the UAC prompt was declined. */
  error?: string;
}
