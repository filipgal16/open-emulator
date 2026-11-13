import { readFileSync } from 'fs';
import path from 'path';

/**
 * Reads the `KEY=value` files under `android/profiles/` and `android/devices/`.
 *
 * Those files are `source`d by bash today (`load_profile`, `load_device` in
 * `android/lib/common.sh`). They stay the single source of truth after the native port rather than
 * being duplicated into JSON — one definition of what the `play` guest is, not two that can drift.
 *
 * This parses the subset they actually use — comments, blank lines, bare values, and single- or
 * double-quoted values — and nothing else. It is deliberately *not* a shell: no `$VAR` expansion,
 * no command substitution, no `export`. A file that wants any of that is a file that has outgrown
 * being data, and executing it would hand a config file the ability to run commands.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    // Keys are identifiers. Anything else is a line this parser has misread, and guessing at it
    // would be worse than skipping it.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    out[key] = unquote(line.slice(eq + 1).trim());
  }

  return out;
}

/**
 * Strips one matched pair of surrounding quotes.
 *
 * A trailing comment is only stripped from an *unquoted* value: `DEVICE_MODEL="2201117TG"` must
 * keep everything inside its quotes, while `PROFILE_IMAGE_TAG=default  # the AOSP one` must not
 * carry the comment into the value.
 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  const hash = value.indexOf(' #');
  return hash === -1 ? value : value.slice(0, hash).trimEnd();
}

/** Names come from the UI and end up in a filesystem path, so they are matched, not trusted. */
export function isSafeConfigName(name: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(name);
}

export interface GuestProfile {
  name: string;
  description: string;
  /** `system-images;android-30;google_apis_playstore;x86_64` */
  systemImage: string;
  /** `default` | `google_apis` | `google_apis_playstore` | `openemu` | `openemu-compat` */
  imageTag: string;
  /**
   * The Android API level of the image, and of its base when it is derived: the one number every
   * SDK path, package and AVD target is built from. 30 when the file does not say, which is what
   * every profile was before there was a second.
   */
  apiLevel: number;
  /**
   * Guest RAM this image needs, in MB, or null to let `tuneForHost` decide. A hint for images the
   * measured default is too small for, not a preference.
   */
  ramMb: number | null;
  /**
   * The stock image this one is built from, or null when the image is downloaded as-is.
   *
   * A derived image is not in Google's repository: setup fetches the base and runs the image
   * ROM builder (`rom/builder.ts`), and the result is installed under `imageTag`.
   */
  baseImageTag: string | null;
  playStore: boolean;
  avdName: string;
}

export interface DeviceIdentity {
  name: string;
  /** `ro.product.*` and `ro.build.*` overrides. Empty entries are dropped, not sent as blanks. */
  props: Record<string, string>;
  lcdWidth: number | null;
  lcdHeight: number | null;
  lcdDensity: number | null;
}

function read(file: string): Record<string, string> {
  return parseEnvFile(readFileSync(file, 'utf8'));
}

/**
 * `android/profiles/<name>.env`.
 *
 * Throws rather than falling back to a default. Silently running the wrong guest is how someone
 * ends up staring at an AOSP image wondering where the Play Store went — and worse, how a snapshot
 * taken against one image gets loaded against another.
 */
export function loadProfile(androidRoot: string, name: string): GuestProfile {
  if (!isSafeConfigName(name)) throw new Error(`unsafe profile name: ${name}`);

  const file = path.join(androidRoot, 'profiles', `${name}.env`);
  let env: Record<string, string>;
  try {
    env = read(file);
  } catch {
    throw new Error(`unknown profile '${name}' (expected ${file})`);
  }

  const systemImage = env.PROFILE_SYSTEM_IMAGE;
  const imageTag = env.PROFILE_IMAGE_TAG;
  if (!systemImage || !imageTag) throw new Error(`profile '${name}' is missing its system image`);

  return {
    name: env.PROFILE_NAME || name,
    description: env.PROFILE_DESC ?? '',
    systemImage,
    imageTag,
    apiLevel: intField(env, 'PROFILE_API_LEVEL', name, 21, 99) ?? 30,
    ramMb: intField(env, 'PROFILE_RAM_MB', name, 1024, 16_384),
    baseImageTag: env.PROFILE_BASE_IMAGE_TAG && isSafeConfigName(env.PROFILE_BASE_IMAGE_TAG) ? env.PROFILE_BASE_IMAGE_TAG : null,
    playStore: env.PROFILE_PLAYSTORE === 'true',
    avdName: env.PROFILE_AVD_NAME || 'OpenEmulator_API30',
  };
}

/**
 * A whole number within bounds, or null when the key is absent or empty.
 *
 * A value that is present but wrong throws, for the reason `loadProfile` does: `PROFILE_API_LEVEL=3O`
 * read as "not set" would quietly point the guest at the API 30 image of another profile.
 */
function intField(env: Record<string, string>, key: string, profile: string, min: number, max: number): number | null {
  const raw = env[key];
  if (raw === undefined || raw === '') return null;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`profile '${profile}': ${key}=${raw} is not a whole number from ${min} to ${max}`);
  }
  return value;
}

/** The `ro.product.*` keys `device_prop_args` builds, paired with the file's field names. */
const DEVICE_PROPS: Array<[string, string]> = [
  ['ro.product.brand', 'DEVICE_BRAND'],
  ['ro.product.manufacturer', 'DEVICE_MANUFACTURER'],
  ['ro.product.model', 'DEVICE_MODEL'],
  ['ro.product.name', 'DEVICE_PRODUCT'],
  ['ro.product.device', 'DEVICE_DEVICE'],
  ['ro.build.fingerprint', 'DEVICE_FINGERPRINT'],
  ['ro.build.id', 'DEVICE_BUILD_ID'],
  ['ro.build.tags', 'DEVICE_BUILD_TAGS'],
  ['ro.build.type', 'DEVICE_BUILD_TYPE'],
];

/**
 * `android/devices/<name>.env`.
 *
 * Empty fields are skipped rather than passed as blanks, which is what makes `generic` add no
 * overrides at all — the same rule `device_prop_args` follows. Passing `ro.product.brand=` would
 * not be "no opinion", it would be an opinion that the brand is the empty string.
 */
export function loadDevice(androidRoot: string, name: string): DeviceIdentity {
  if (!isSafeConfigName(name)) throw new Error(`unsafe device name: ${name}`);

  const file = path.join(androidRoot, 'devices', `${name}.env`);
  let env: Record<string, string>;
  try {
    env = read(file);
  } catch {
    throw new Error(`unknown device '${name}' (expected ${file})`);
  }

  const props: Record<string, string> = {};
  for (const [prop, field] of DEVICE_PROPS) {
    const value = env[field];
    if (value) props[prop] = value;
  }

  const num = (value: string | undefined): number | null => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  return {
    name: env.DEVICE_NAME || name,
    props,
    lcdWidth: num(env.DEVICE_LCD_WIDTH),
    lcdHeight: num(env.DEVICE_LCD_HEIGHT),
    lcdDensity: num(env.DEVICE_LCD_DENSITY),
  };
}
