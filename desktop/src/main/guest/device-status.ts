import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { DeviceState, ProfileId } from '../../shared/device-types';
import { isProfileId } from '../../shared/device-types';

/**
 * Parses the `key=value` lines `open-emu status` prints.
 *
 * Deliberately tolerant: `status` prints a different set of lines depending on whether the
 * emulator is up, whether adb answered, and whether a snapshot exists. Anything absent stays at
 * its default rather than being guessed at — reporting "not provisioned" because a line was
 * missing would send the user through a 20-minute re-provision they did not need.
 */
export function parseStatus(lines: string[]): Partial<DeviceState> {
  const fields = new Map<string, string>();
  for (const raw of lines) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    // Only the first occurrence: `profile=` trails a whole env dump on one line.
    if (!fields.has(line.slice(0, eq))) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }

  const state: Partial<DeviceState> = {};

  const avd = fields.get('avd');
  if (avd) state.avd = avd;

  const emulator = fields.get('emulator');
  if (emulator === 'running') state.phase = 'running';
  else if (emulator === 'stopped') state.phase = 'stopped';

  state.bootCompleted = fields.get('boot_completed') === '1';

  // "android=11 api=30" arrives as one line.
  const android = fields.get('android');
  if (android) {
    const [version, apiPart] = android.split(/\s+/);
    if (version && version !== 'unknown') state.androidVersion = version;
    const api = Number.parseInt((apiPart ?? '').replace('api=', ''), 10);
    if (Number.isFinite(api)) state.api = api;
  }

  // "snapshot=booted present=yes"
  const snapshot = fields.get('snapshot');
  if (snapshot) state.snapshot = /present=yes/.test(snapshot);

  state.provisioned = fields.has('provisioned_at');

  return state;
}

interface DevicePrefs {
  profile: ProfileId;
}

/**
 * Which guest the user picked, remembered across launches.
 *
 * Persisted rather than held in memory because the profile decides which AVD — and therefore which
 * snapshot — every later `open-emu` call touches. Forgetting it between launches would silently
 * drop someone back onto the default guest with their Play sign-in apparently gone.
 */
export class DevicePrefsStore {
  private prefs: DevicePrefs;

  constructor(
    private readonly file: string,
    fallback: ProfileId = 'openemu',
  ) {
    this.prefs = { profile: fallback };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DevicePrefs>;
      if (isProfileId(raw.profile)) this.prefs = { profile: raw.profile };
    } catch {
      // First run, or an unreadable file — the fallback stands.
    }
  }

  get(): ProfileId {
    return this.prefs.profile;
  }

  set(profile: ProfileId): ProfileId {
    this.prefs = { profile };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.prefs), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // Held for this session only.
    }
    return profile;
  }
}
