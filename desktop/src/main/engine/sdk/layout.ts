import path from 'path';

/**
 * Where the native runtime keeps everything it downloads.
 *
 * Takes the root as an argument rather than calling `app.getPath` so this stays free of an
 * electron import and testable under plain `node --test`, the same rule `win-paths.ts` follows.
 *
 * The root should be under `%LOCALAPPDATA%`, and **must not contain spaces**: the Android SDK's
 * own tooling has a long history of mishandling them, and `%LOCALAPPDATA%\open-emulator` avoids
 * the question entirely. Notably this is *not* `app.getPath('userData')`, which is
 * `…\Local\open-emulator` only by coincidence of the product name — the SDK lives beside the app's
 * settings, not inside them, because it is a multi-gigabyte cache the user may want to delete
 * without losing their account and preferences.
 */
export interface SdkLayout {
  /** `%LOCALAPPDATA%\open-emulator` */
  root: string;
  /** The Android SDK: `cmdline-tools/`, `platform-tools/`, `emulator/`, `system-images/`. */
  sdkRoot: string;
  cmdlineTools: string;
  sdkManager: string;
  avdManager: string;
  emulator: string;
  adb: string;
  /** Fetched only when the host has no usable `java` — `sdkmanager` is a Java program. */
  jreRoot: string;
  /** `ANDROID_AVD_HOME`. One `.avd` directory and `.ini` per profile. */
  avdHome: string;
  logs: string;
  /** Per-AVD, never shared: see `avdState`. */
  stateRoot: string;
  /** Android-x86 ISOs and QEMU, for the licence-clean engine. */
  images: string;
  qemuRoot: string;
}

/** On Windows every SDK entry point is a `.exe` or a `.bat`; elsewhere it is bare. */
function exe(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function bat(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.bat` : name;
}

export function createSdkLayout(root: string, platform: NodeJS.Platform = process.platform): SdkLayout {
  const sdkRoot = path.join(root, 'sdk');
  const cmdlineTools = path.join(sdkRoot, 'cmdline-tools', 'latest');

  return {
    root,
    sdkRoot,
    cmdlineTools,
    sdkManager: path.join(cmdlineTools, 'bin', bat('sdkmanager', platform)),
    avdManager: path.join(cmdlineTools, 'bin', bat('avdmanager', platform)),
    emulator: path.join(sdkRoot, 'emulator', exe('emulator', platform)),
    adb: path.join(sdkRoot, 'platform-tools', exe('adb', platform)),
    jreRoot: path.join(root, 'jre'),
    avdHome: path.join(root, 'avd'),
    logs: path.join(root, 'logs'),
    stateRoot: path.join(root, 'state'),
    images: path.join(root, 'images'),
    qemuRoot: path.join(root, 'qemu'),
  };
}

/**
 * The state directory for one AVD.
 *
 * Per-AVD, not shared — the same rule `android_env` learned the hard way. Sharing it across
 * profiles meant a `provisioned_at` written while running one guest vouched for another, so
 * switching to the Play profile would launch an unprovisioned guest that claimed to be ready.
 */
export function avdState(layout: SdkLayout, avdName: string): string {
  return path.join(layout.stateRoot, avdName);
}

/** The AVD's own directory, which is where `config.ini` and `snapshots/` live. */
export function avdDir(layout: SdkLayout, avdName: string): string {
  return path.join(layout.avdHome, `${avdName}.avd`);
}

export function snapshotDir(layout: SdkLayout, avdName: string, snapshot: string): string {
  return path.join(avdDir(layout, avdName), 'snapshots', snapshot);
}

/**
 * The unpacked system image a profile needs, e.g.
 * `sdk/system-images/android-30/google_apis_playstore/x86_64/system.img`.
 *
 * Checking for the image rather than just the emulator binary is what stops a profile switch
 * sailing past the "is Android downloaded?" check and failing much later inside `avdmanager` — the
 * mistake `sdkProbe` in setup-wizard.ts was written to correct.
 */
export function systemImagePath(layout: SdkLayout, imageTag: string, apiLevel = 30): string {
  return path.join(layout.sdkRoot, 'system-images', `android-${apiLevel}`, imageTag, 'x86_64', 'system.img');
}
