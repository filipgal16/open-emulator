// Shared between main, preload, and renderer. Type-only content — safe to import from both
// the tsc-compiled (CommonJS/Node) side and the esbuild-bundled (browser) renderer side.

import type { AdsState, Creative, LicenseResult, SlotBounds, SlotId, TagPlan } from './ads-types';

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
  runSetupFix(id: string): Promise<SetupStepStatus>;
  onSetupStep(callback: (status: SetupStepStatus) => void): void;
  onLog(callback: (event: LogEvent) => void): void;
  startMirror(): void;
  stopMirror(): void;
  onFrame(callback: (data: Uint8Array) => void): void;
  tap(x: number, y: number): void;
  adsState(): Promise<AdsState>;
  adsRequest(slot: SlotId): Promise<Creative | null>;
  adsSetOptedOut(optedOut: boolean): Promise<AdsState>;
  /** Fire-and-forget; counted once per token, and only when the creative was really viewable. */
  adsImpression(token: string): void;
  /** Opens the campaign's destination in the system browser. The renderer never sees the URL. */
  adsClick(token: string): void;
  adsSetConsent(granted: boolean): Promise<AdsState>;
  adsActivateLicense(key: string): Promise<LicenseResult>;
  /** Null when no third-party tag is configured for this slot. */
  adsTagPlan(slot: SlotId): Promise<TagPlan | null>;
  adsMountTag(slot: SlotId, bounds: SlotBounds): void;
  adsUpdateTagBounds(slot: SlotId, bounds: SlotBounds): void;
  adsUnmountTag(slot: SlotId): void;
  /** Fires with `filled: false` when the tag painted nothing and the slot should fall back. */
  onAdsTagResult(callback: (slot: SlotId, filled: boolean) => void): void;
  listApps(): Promise<InstalledApp[]>;
  launchApp(packageName: string): Promise<boolean>;
}
