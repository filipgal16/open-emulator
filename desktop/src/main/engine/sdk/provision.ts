import type { GuestProfile } from '../env-file';
import type { EngineLogHandler } from '../types';
import type { Adb } from './adb';
import type { CommandResult } from '../../../shared/ipc-types';

export interface ProvisionInput {
  adb: Adb;
  serial: string;
  profile: GuestProfile;
  accelerated: boolean;
  onLog: EngineLogHandler;
  log: (message: string) => void;
  onProvisioned: () => void;
}

/**
 * Guest settings applied once, before the snapshot is taken.
 *
 * Ported from `android/scripts/provision.sh`. Each group earns its place: a guest that boots into
 * a setup wizard, sleeps after a minute, and refuses sideloaded APKs is technically working and
 * practically unusable.
 *
 * Ordered deliberately — the wizard and lockscreen first, because everything after them assumes
 * the home screen is reachable.
 */
const SETTINGS: Array<{ why: string; commands: string[] }> = [
  {
    why: 'setup wizard and lockscreen',
    commands: [
      'settings put global device_provisioned 1',
      'settings put secure user_setup_complete 1',
      'locksettings set-disabled true',
      'wm dismiss-keyguard',
    ],
  },
  {
    why: 'allow sideloaded installs',
    commands: [
      'settings put global package_verifier_enable 0',
      'settings put global verifier_verify_adb_installs 0',
      'settings put global install_non_market_apps 1',
      'settings put secure install_non_market_apps 1',
    ],
  },
  {
    why: 'stay awake and feel responsive',
    commands: [
      'settings put global window_animation_scale 0.5',
      'settings put global transition_animation_scale 0.5',
      'settings put global animator_duration_scale 0.5',
      // Never. A screen that times out inside an embedded window is a black rectangle with no
      // explanation, and `stay_on_while_plugged_in` alone did not keep it awake.
      'settings put system screen_off_timeout 2147483647',
      'settings put global stay_on_while_plugged_in 3',
    ],
  },
  {
    why: 'networking',
    commands: [
      'settings put global airplane_mode_on 0',
      'svc wifi enable',
      'svc data enable',
      'settings put global private_dns_mode off',
    ],
  },
];

/**
 * Packages compiled ahead of the snapshot, so a restored guest starts with warm ART instead of
 * JIT-ing on every warm boot.
 *
 * Deliberately short. Compiling more dirties more guest pages, which grows the snapshot's
 * `ram.bin` — and warm start is dominated by restoring that file, so a longer list makes every
 * subsequent start *slower*.
 */
const DEXOPT_PACKAGES = ['com.android.settings', 'com.android.systemui'];

/**
 * Extra userdata settings for the custom image. The debloat and the brand live in the image;
 * these are the things Android keeps in userdata and the snapshot then preserves — they would be
 * pointless in build.prop.
 *
 * Animations at 0 rather than 0.5: on a host-GPU window there is nothing to ease, and the stock
 * 0.5 still costs a frame of compositor work per transition. Bluetooth off because the image
 * unlinked the stack and a leftover toggle that cannot turn on is worse than none.
 */
const OPENEMU_SETTINGS = [
  'settings put global window_animation_scale 0',
  'settings put global transition_animation_scale 0',
  'settings put global animator_duration_scale 0',
  'settings put global bluetooth_on 0',
  'settings put secure screensaver_enabled 0',
];

export async function provisionGuest(input: ProvisionInput): Promise<CommandResult> {
  const { adb, serial, profile, accelerated, onLog, log, onProvisioned } = input;

  for (const group of SETTINGS) {
    log(`provisioning: ${group.why}`);
    for (const command of group.commands) {
      // Best-effort by design. Several of these are absent on some images (`svc data` on an AOSP
      // build with no telephony), and a missing one is not a reason to fail provisioning.
      await adb.shell(serial, command, onLog, 30_000).catch(() => undefined);
    }
  }

  if (profile.imageTag === 'openemu') {
    log('provisioning: open-emulator image tunings');
    for (const command of OPENEMU_SETTINGS) {
      await adb.shell(serial, command, onLog, 30_000).catch(() => undefined);
    }
  }

  // Play and GMS exist only on the Google images. Running these against lean AOSP spends an adb
  // round trip each to be told the package does not exist.
  if (profile.imageTag.startsWith('google')) {
    log(`enabling Play and GMS (profile ${profile.name})`);
    for (const pkg of ['com.android.vending', 'com.google.android.gms']) {
      await adb.shell(serial, `pm enable ${pkg}`, onLog, 60_000).catch(() => undefined);
    }
  }

  if (accelerated) {
    log(`compiling ${DEXOPT_PACKAGES.join(', ')}`);
    for (const pkg of DEXOPT_PACKAGES) {
      await adb.shell(serial, `cmd package compile -m speed-profile -f ${pkg}`, onLog, 300_000).catch(() => undefined);
    }
  } else {
    // On a software CPU this costs many minutes and buys back less than it spends.
    log('no acceleration — skipping ahead-of-time compilation');
  }

  await adb.shell(serial, 'input keyevent KEYCODE_HOME', onLog, 30_000).catch(() => undefined);

  log('saving the snapshot');
  // Saved under Quick Boot's own name, so the very next start restores it. Under any other name
  // the emulator ignores it on launch and cold-boots instead — which is what made provisioning
  // look successful while every later start still took half a minute.
  const saved = await adb
    .exec(serial, ['emu', 'avd', 'snapshot', 'save', 'default_boot'], onLog, 180_000)
    .catch(() => null);
  if (!saved || saved.code !== 0) {
    return { code: 1, signal: null, stdout: [], stderr: ['could not save the snapshot'] };
  }

  onProvisioned();
  log('provisioned');
  return { code: 0, signal: null, stdout: ['provisioned=1'], stderr: [] };
}
