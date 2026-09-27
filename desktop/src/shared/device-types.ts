// Shared between main, preload, and renderer. Type-only content plus plain data constants.

export type ProfileId = 'openemu' | 'fast' | 'full' | 'play';

export interface ProfileSpec {
  id: ProfileId;
  label: string;
  /** One line, in the user's terms — not "google_apis_playstore;x86_64". */
  description: string;
  playStore: boolean;
  /** Roughly what the one-time download costs, so the choice is informed. */
  downloadHint: string;
  /**
   * Whether the image carries Google Mobile Services.
   *
   * Surfaced in the picker because it decides more than which apps run: a GMS image cannot be
   * redistributed, and shipping one commercially needs an agreement with Google. The AOSP image
   * is Apache-2.0 and carries no such condition. See LICENSING.md.
   */
  proprietary: boolean;
}

/**
 * The guest images a user can choose between, described the way a person would ask for them.
 *
 * These mirror `android/profiles/*.env`. The ids must match those filenames — the shell passes the
 * id straight through as `ANDROID_PROFILE`.
 */
export const PROFILES: Record<ProfileId, ProfileSpec> = {
  openemu: {
    id: 'openemu',
    label: 'open-emulator',
    description: 'Our own build of Android: the stock image debloated, tuned and branded for this emulator. No Google Play.',
    playStore: false,
    // Built from the Fast image, so it costs nothing extra once that is downloaded.
    downloadHint: 'built from Fast, no extra download',
    proprietary: false,
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'Plain Android. Boots quickest. No Google Play.',
    playStore: false,
    downloadHint: 'about 4 GB',
    proprietary: false,
  },
  full: {
    id: 'full',
    label: 'Google apps',
    description: 'Adds Google Play Services, for apps that need them. Still no Play Store app.',
    playStore: false,
    downloadHint: 'about 4 GB',
    proprietary: true,
  },
  play: {
    id: 'play',
    label: 'Play Store',
    description: 'Google Play Store built in — sign in and install apps normally. Slowest to start.',
    playStore: true,
    downloadHint: 'about 4 GB extra',
    proprietary: true,
  },
};

export const PROFILE_IDS = Object.keys(PROFILES) as ProfileId[];

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value);
}

export type EmuPhase = 'unknown' | 'stopped' | 'starting' | 'running' | 'stopping';

export interface DeviceState {
  profile: ProfileId;
  phase: EmuPhase;
  avd: string | null;
  /** e.g. "11" */
  androidVersion: string | null;
  api: number | null;
  bootCompleted: boolean;
  /** Whether this profile's AVD has been prepared (and so can boot from a snapshot). */
  provisioned: boolean;
  snapshot: boolean;
  /** True while a start/stop/prepare is in flight — the UI disables its buttons on this. */
  busy: boolean;
  /** Set when the last action failed, so the UI can say what went wrong. */
  error: string | null;
}

export const INITIAL_DEVICE_STATE: DeviceState = {
  profile: 'openemu',
  phase: 'unknown',
  avd: null,
  androidVersion: null,
  api: null,
  bootCompleted: false,
  provisioned: false,
  snapshot: false,
  busy: false,
  error: null,
};
