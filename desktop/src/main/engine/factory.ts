import path from 'path';
import { repoRootWinPath } from '../platform/win-paths';
import type { WslBridge } from '../wsl/bridge';
import { detectAcceleration, type AccelerationState } from './acceleration';
import type { GuestProfile } from './env-file';
import type { GuestTuning } from './sdk/host';
import { createSdkLayout, type SdkLayout } from './sdk/layout';
import { SdkEngine } from './sdk/sdk-engine';
import type { AndroidEngine, EngineId } from './types';
import { WslEngine } from './wsl-engine';

/**
 * Where the native runtime keeps the SDK, images, and state.
 *
 * `%LOCALAPPDATA%\open-emulator`, deliberately **not** `app.getPath('userData')`. The two happen to
 * resolve to sibling paths, but they mean different things: this is a multi-gigabyte cache the user
 * may reasonably want to delete, while userData holds their account and preferences. Keeping them
 * apart means "free up space" cannot take the account with it.
 */
export function nativeRoot(override?: string | null): string {
  if (override && override.trim().length > 0) return override;
  const base = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? 'C:\\', 'AppData', 'Local');
  return path.join(base, 'open-emulator');
}

export function resolveEngineId(raw: string | undefined, platform: NodeJS.Platform = process.platform): EngineId {
  if (raw === 'sdk' || raw === 'qemu' || raw === 'wsl') return raw;
  // Native on Windows. It is the only runtime with a window to embed — the WSL guest is headless
  // and can only be photographed at ~3fps — and it downloads 1.1 GB instead of a 4 GB distro.
  // WSL remains reachable with OPEN_EMULATOR_ENGINE=wsl, and is the only option off Windows.
  return platform === 'win32' ? 'sdk' : 'wsl';
}

export interface EngineContext {
  engine: AndroidEngine;
  layout: SdkLayout;
  /** Resolved once and cached — probing costs a PowerShell round trip. */
  acceleration: () => Promise<AccelerationState>;
  /**
   * What the native engine will start a profile with, for setup's ROM build to agree with it; null
   * for the other runtimes, which build no ROM.
   */
  guestTuning: ((profile: GuestProfile) => GuestTuning) | null;
}

export interface CreateEngineOptions {
  id: EngineId;
  /** Where downloads live. Null uses the default under %LOCALAPPDATA%. */
  downloadRoot?: string | null;
  profile: string | null;
  /** Which device identity the guest should report as. Read live. */
  device?: () => string;
  /** Shared mutable target, only needed by the WSL engine. */
  wsl?: { bridge: WslBridge; target: { profile: string | null } };
  onLog?: (message: string) => void;
}

/**
 * Builds the runtime the app will drive.
 *
 * The only place an engine is chosen. Everything downstream holds `OpenEmuClient` and cannot tell
 * which one it got, which is what makes this switch a one-line change rather than a migration.
 */
export function createEngine(options: CreateEngineOptions): EngineContext {
  const layout = createSdkLayout(nativeRoot(options.downloadRoot));

  let cached: Promise<AccelerationState> | null = null;
  const acceleration = () => {
    cached ??= detectAcceleration();
    return cached;
  };

  // Read synchronously by the engine on every start, so it reflects a feature enabled mid-session
  // once the probe has resolved, rather than being frozen at launch.
  let accelerated = false;
  void acceleration().then((state) => {
    accelerated = state.available;
    options.onLog?.(`[engine] acceleration: ${state.detail}`);
  });

  if (options.id === 'sdk') {
    const engine = new SdkEngine({
      layout,
      androidRoot: path.join(repoRootWinPath(), 'android'),
      profile: options.profile,
      device: options.device,
      accelerated: () => accelerated,
      windowed: true,
      onLog: options.onLog,
    });
    return { layout, acceleration, engine, guestTuning: (profile) => engine.guestTuning(profile) };
  }

  if (!options.wsl) throw new Error(`the ${options.id} engine needs a WSL bridge`);
  return { layout, acceleration, engine: new WslEngine(options.wsl.bridge, options.wsl.target), guestTuning: null };
}
