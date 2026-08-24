import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { DeviceIdentity, GuestProfile } from '../env-file';
import { applyAvdConfig, avdConfigOverrides } from './avd-config';
import type { GuestTuning } from './host';
import { avdDir, snapshotDir, type SdkLayout } from './layout';

/**
 * Creates an AVD without `avdmanager`.
 *
 * `avdmanager` lives in `cmdline-tools`, which the native runtime no longer downloads — it existed
 * only to run `sdkmanager`. That turns out to cost nothing, because an AVD is not a rich object:
 * it is a pointer file and a `config.ini`, and the emulator creates the userdata images itself on
 * first boot.
 *
 * The old `setup_avd.sh` makes this plain. It ran `avdmanager create avd`, then immediately
 * overwrote the generated `config.ini` with the project's own template, rewrote a dozen keys with
 * `sed`, and hand-wrote the `.ini` pointer anyway. Almost nothing avdmanager produced survived the
 * next five lines, so writing the two files directly is both simpler and more predictable — there
 * is no longer a generated file whose contents have to be corrected.
 */

/** The `config.ini` template shipped with the project, holding the keys nothing here decides. */
export function loadTemplate(androidRoot: string): string {
  return readFileSync(path.join(androidRoot, 'config', 'avd_config.ini'), 'utf8');
}

export interface CreateAvdInput {
  layout: SdkLayout;
  androidRoot: string;
  profile: GuestProfile;
  device: DeviceIdentity;
  tuning: GuestTuning;
  apiLevel?: number;
  snapshotName?: string;
}

export interface AvdPaths {
  dir: string;
  configIni: string;
  pointerIni: string;
}

export function avdPaths(layout: SdkLayout, avdName: string): AvdPaths {
  return {
    dir: avdDir(layout, avdName),
    configIni: path.join(avdDir(layout, avdName), 'config.ini'),
    pointerIni: path.join(layout.avdHome, `${avdName}.ini`),
  };
}

/** Whether this profile's AVD already exists and is pointed at correctly. */
export function avdExists(layout: SdkLayout, avdName: string): boolean {
  const paths = avdPaths(layout, avdName);
  return existsSync(paths.configIni) && existsSync(paths.pointerIni);
}

/**
 * Writes (or refreshes) the AVD.
 *
 * Safe to re-run: it rewrites the two configuration files and touches nothing else, so an existing
 * guest keeps its userdata, its snapshot, and its installed apps. That is what lets the setup
 * wizard call this on every start to keep cores, RAM, and the renderer in step with the host —
 * `hw.gpu.mode` in particular has to match the `-gpu` flag or the snapshot becomes unloadable.
 */
export function createAvd(input: CreateAvdInput): AvdPaths {
  const { layout, androidRoot, profile, device, tuning, apiLevel = 30, snapshotName = 'booted' } = input;

  const paths = avdPaths(layout, profile.avdName);
  mkdirSync(paths.dir, { recursive: true });

  const overrides = avdConfigOverrides({
    profile,
    device,
    tuning,
    apiLevel,
    hasSnapshot: existsSync(snapshotDir(layout, profile.avdName, snapshotName)),
    snapshotName,
  });

  writeFileSync(paths.configIni, applyAvdConfig(loadTemplate(androidRoot), overrides), 'utf8');

  // The pointer the emulator reads to find the AVD by name. `path` must be absolute; `path.rel` is
  // what makes the AVD relocatable, and the emulator prefers it when it resolves.
  writeFileSync(
    paths.pointerIni,
    [
      'avd.ini.encoding=UTF-8',
      `path=${paths.dir}`,
      `path.rel=avd/${profile.avdName}.avd`,
      `target=android-${apiLevel}`,
      '',
    ].join('\n'),
    'utf8',
  );

  /**
   * Feature flags the guest boots with.
   *
   * `Vulkan = off` is not tidying. The emulator's Vulkan path negotiates with the host driver at
   * startup and hangs on a good number of Windows GPUs when the guest has no window in focus,
   * which presents as a boot that never completes rather than as a graphics error.
   */
  writeFileSync(
    path.join(paths.dir, 'advancedFeatures.ini'),
    ['GLDirectMem = on', 'Vulkan = off', 'LogcatPipe = on', ''].join('\n'),
    'utf8',
  );

  return paths;
}
