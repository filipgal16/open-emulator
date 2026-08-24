import path from 'path';
import { repoRootWinPath } from '../win-paths';
import type { WslBridge } from '../wsl-bridge';
import { detectAcceleration, type AccelerationState } from './acceleration';
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
export function nativeRoot(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? 'C:\\', 'AppData', 'Local');
  return path.join(base, 'open-emulator');
}

export function resolveEngineId(raw: string | undefined): EngineId {
  if (raw === 'sdk' || raw === 'qemu' || raw === 'wsl') return raw;
  // WSL remains the default until the native engine has booted a guest on a real machine. Shipping
  // an untested runtime as the default would trade a slow product for a broken one.
  return 'wsl';
}

export interface EngineContext {
  engine: AndroidEngine;
  layout: SdkLayout;
  /** Resolved once and cached — probing costs a PowerShell round trip. */
  acceleration: () => Promise<AccelerationState>;
}

export interface CreateEngineOptions {
  id: EngineId;
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
  const layout = createSdkLayout(nativeRoot());

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
    return {
      layout,
      acceleration,
      engine: new SdkEngine({
        layout,
        androidRoot: path.join(repoRootWinPath(), 'android'),
        profile: options.profile,
        device: options.device,
        accelerated: () => accelerated,
        windowed: true,
        onLog: options.onLog,
      }),
    };
  }

  if (!options.wsl) throw new Error(`the ${options.id} engine needs a WSL bridge`);
  return { layout, acceleration, engine: new WslEngine(options.wsl.bridge, options.wsl.target) };
}
