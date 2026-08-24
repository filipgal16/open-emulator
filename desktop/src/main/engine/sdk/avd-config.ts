import type { DeviceIdentity, GuestProfile } from '../env-file';
import type { GuestTuning } from './host';

/**
 * Rewrites an AVD's `config.ini`.
 *
 * Ports the `sed` block in `android/scripts/setup_avd.sh`, and the reason it is a *rewrite* of a
 * template rather than a file generated from scratch is that the template carries ~40 tuned keys
 * (`hw.device.hash2`, sensor toggles, partition sizes) that nothing here has an opinion about.
 * Only the keys this project actually decides are overridden; everything else is left exactly as
 * shipped.
 */
export function applyAvdConfig(template: string, overrides: Record<string, string>): string {
  const seen = new Set<string>();

  const lines = template.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return line;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) return line;

    const key = trimmed.slice(0, eq).trim();
    if (!(key in overrides)) return line;

    seen.add(key);
    return `${key}=${overrides[key]}`;
  });

  // A key the template does not mention still has to land, or an override silently does nothing.
  // `PlayStore.enabled` on a template that omits it is exactly this case.
  for (const [key, value] of Object.entries(overrides)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  return `${lines.filter((line, index) => line.length > 0 || index < lines.length - 1).join('\n')}\n`;
}

export interface AvdConfigInput {
  profile: GuestProfile;
  device: DeviceIdentity;
  tuning: GuestTuning;
  apiLevel?: number;
  /** True until `provision` has saved one. Forces the cold-boot path for the first start. */
  hasSnapshot: boolean;
  snapshotName: string;
}

/**
 * The keys this project decides, and why each one matters.
 *
 * The load-bearing one is **`hw.gpu.mode`**, which must match the `-gpu` flag the emulator is
 * launched with. If they disagree, the snapshot written by one boot records a different renderer
 * than `config.ini` claims, and the next warm start dies with "The emulator hardware cannot load
 * snapshot". Both values come from the same `GuestTuning` object precisely so they cannot drift —
 * see `emulatorArgs`, which reads `tuning.gpuMode` for the flag.
 */
export function avdConfigOverrides(input: AvdConfigInput): Record<string, string> {
  const { profile, device, tuning, hasSnapshot, snapshotName, apiLevel = 30 } = input;

  const overrides: Record<string, string> = {
    AvdId: profile.avdName,
    'avd.ini.displayname': profile.avdName,
    'hw.cpu.ncore': String(tuning.cores),
    'hw.ramSize': String(tuning.ramMb),
    'hw.gpu.mode': tuning.gpuMode,
    'hw.gpu.enabled': 'yes',
    'image.sysdir.1': `system-images/android-${apiLevel}/${profile.imageTag}/x86_64/`,
    'tag.id': profile.imageTag,
    // Claiming a Play Store the image does not ship is how the old config ended up advertising one
    // on an AOSP image that never had it.
    'PlayStore.enabled': profile.playStore ? 'true' : 'false',
  };

  overrides['tag.display'] = displayNameForTag(profile.imageTag);

  // Panel geometry has to live in config.ini rather than a `-prop`: the framebuffer size is
  // hardware, fixed when the AVD boots.
  if (device.lcdWidth && device.lcdHeight && device.lcdDensity) {
    overrides['hw.lcd.width'] = String(device.lcdWidth);
    overrides['hw.lcd.height'] = String(device.lcdHeight);
    overrides['hw.lcd.density'] = String(device.lcdDensity);
  }

  // Until `provision` has saved a snapshot there is nothing to fast-boot from, and pointing the
  // AVD at one that does not exist produces a failed restore on the very first start.
  if (hasSnapshot) {
    overrides['fastboot.forceColdBoot'] = 'no';
    overrides['fastboot.forceFastBoot'] = 'yes';
    overrides['fastboot.forceChosenSnapshotBoot'] = 'yes';
    overrides['fastboot.chosenSnapshotFile'] = snapshotName;
  } else {
    overrides['fastboot.forceColdBoot'] = 'yes';
    overrides['fastboot.forceFastBoot'] = 'no';
    overrides['fastboot.forceChosenSnapshotBoot'] = 'no';
  }

  return overrides;
}

function displayNameForTag(imageTag: string): string {
  if (imageTag === 'default') return 'AOSP';
  if (imageTag === 'google_apis_playstore') return 'Google Play';
  return 'Google APIs';
}

export interface EmulatorArgsInput {
  avdName: string;
  tuning: GuestTuning;
  device: DeviceIdentity;
  /** Restore the named snapshot instead of booting from scratch. */
  useSnapshot: string | null;
  headless: boolean;
  writableSystem?: boolean;
}

/**
 * The emulator's command line.
 *
 * Two flags are here for reasons that cost real debugging, and neither is cosmetic:
 *
 * **`-gpu <mode>` is never `auto`.** The emulator resolves `auto` to a concrete renderer that
 * varies by system image — swiftshader on `google_apis`, lavapipe on AOSP — and writes the
 * *resolved* name into the snapshot's `hardware.ini`. `config.ini` would still say something else,
 * and the next warm start refuses the snapshot. `tuning.gpuMode` is the single source for both.
 *
 * **`-no-snapshot-save` on a cold boot** is as important as `-no-snapshot-load`. Without it the
 * emulator writes a `default_boot` snapshot while quitting, and a kill arriving shortly after
 * lands mid-write and corrupts the snapshot store. Snapshots are written deliberately by
 * `provision`, never as a side effect of shutting down.
 */
export function emulatorArgs(input: EmulatorArgsInput): string[] {
  const { avdName, tuning, device, useSnapshot, headless, writableSystem = false } = input;

  const args = [
    '-avd',
    avdName,
    '-gpu',
    tuning.gpuMode,
    '-accel',
    tuning.accel,
    '-no-boot-anim',
    '-no-metrics',
    '-netdelay',
    'none',
    '-netspeed',
    'full',
  ];

  if (headless) {
    // Audio has no sink in a headless run — the emulator logs a driver failure and initialises it
    // anyway. Skipping the subsystem is cheaper than letting it fail.
    args.push('-no-window', '-no-audio');
  }

  if (writableSystem) args.push('-writable-system');

  // Device identity is baked into the boot, so a snapshot taken afterwards carries it — which is
  // why switching device needs a re-provision rather than just a restart.
  for (const [key, value] of Object.entries(device.props)) {
    args.push('-prop', `${key}=${value}`);
  }

  if (useSnapshot) {
    args.push('-snapshot', useSnapshot, '-no-snapshot-save');
  } else {
    args.push('-no-snapshot-load', '-no-snapshot-save');
  }

  return args;
}
