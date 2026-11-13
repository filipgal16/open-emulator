// Shared between main, preload, and renderer. Type-only content plus plain data constants.

export type ThemeChoice = 'system' | 'light' | 'dark';

/** Matches the filenames in `android/devices/`. The id is passed straight through. */
export type DeviceId = 'generic' | 'pixel_5' | 'redmi_note_11';

export interface DeviceSpec {
  id: DeviceId;
  label: string;
  /** One line in the user's terms — not a build fingerprint. */
  description: string;
}

/**
 * The device identities a guest can report as.
 *
 * Not cosmetic: stock AVD images identify as brand "Android", model "mainline", and plenty of apps
 * treat that as an emulator and refuse to run. Presenting a real handset is a compatibility
 * feature, which is why it belongs in settings rather than being hidden.
 */
export const DEVICES: Record<DeviceId, DeviceSpec> = {
  generic: {
    id: 'generic',
    label: 'Default',
    description: 'Reports whatever the Android image says. The honest option.',
  },
  pixel_5: {
    id: 'pixel_5',
    label: 'Pixel 5',
    description: 'Reports as a Google Pixel 5. Helps with apps that refuse to run on an emulator.',
  },
  redmi_note_11: {
    id: 'redmi_note_11',
    label: 'Redmi Note 11',
    description: 'Reports as a Xiaomi handset. Some games gate features on the manufacturer.',
  },
};

export const DEVICE_IDS = Object.keys(DEVICES) as DeviceId[];

export function isDeviceId(value: unknown): value is DeviceId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEVICES, value);
}

/**
 * Everything the user can change.
 *
 * `cores` and `ramMb` are null by default and mean "decide from this machine". They are exposed
 * because the automatic answer is a *measured* default rather than a universal one — but the
 * measurements behind it are unintuitive enough to be worth surfacing rather than hiding. More RAM
 * makes the guest slower to resume, because warm start is dominated by restoring the snapshot's
 * memory image.
 */
export interface Settings {
  theme: ThemeChoice;
  /**
   * Where the Android SDK and system images are downloaded.
   *
   * Null means the default under %LOCALAPPDATA%. This is the largest thing the product puts on a
   * disk — several gigabytes — so pinning it to the system drive is exactly the assumption someone
   * with a small SSD and a large second drive needs to override.
   */
  downloadRoot: string | null;
  device: DeviceId;
  /** Null means "choose from this machine". */
  cores: number | null;
  ramMb: number | null;
  /**
   * How large Android draws everything, as the panel's density in dpi. Null keeps the chosen
   * device's own.
   *
   * There is no resolution setting on purpose: the display follows the window, so its size *is*
   * the resolution. What a window cannot say is how many of those pixels a button should take.
   */
  density: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  downloadRoot: null,
  device: 'generic',
  cores: null,
  ramMb: null,
  density: null,
};

/**
 * The range the controls offer. The store accepts a little more (a hand-edited file is clamped,
 * not refused), but these are the values a slider should be able to reach.
 */
export const RAM_MIN_MB = 2048;
export const RAM_MAX_MB = 16_384;
export const RAM_STEP_MB = 512;
/** Windows keeps this much for itself however the slider is set. */
export const RAM_HOST_RESERVE_MB = 2048;
/** Android's own density buckets run from 160 (large tablets) to 480 (small, sharp phones). */
export const DENSITY_MIN = 160;
export const DENSITY_MAX = 480;
export const DENSITY_STEP = 40;

/** What the automatic answer would be, so the UI can show it beside the override. */
export interface TuningPreview {
  /** What the next start will use: the override if there is one, else the automatic value. */
  cores: number;
  ramMb: number;
  density: number;
  /** What "Automatic" means on this machine, for the profile in use. */
  autoCores: number;
  autoRamMb: number;
  autoDensity: number;
  gpuMode: string;
  accelerated: boolean;
  /** Plain-language acceleration status, suitable to show directly. */
  accelerationDetail: string;
  hostCpus: number;
  hostRamMb: number;
}

export interface MoveResult {
  ok: boolean;
  /** What happened, in a sentence the UI can show directly. */
  message: string;
  movedBytes: number;
}

export interface StorageUsage {
  /** Where the runtime keeps the SDK, images, and per-guest state. */
  root: string;
  totalBytes: number;
  /** Archives and scratch that `freeSpace` would remove. */
  reclaimableBytes: number;
}

export interface SettingsState {
  settings: Settings;
  tuning: TuningPreview;
  storage: StorageUsage;
  /** `wsl` or `sdk` — which runtime is driving, so the UI can be honest about it. */
  engine: string;
  /** Result of the last action that had something to say, e.g. moving the download folder. */
  lastMessage?: string;
}
