import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import type { Settings, StorageUsage, ThemeChoice } from '../shared/settings-types';
import { DEFAULT_SETTINGS, isDeviceId } from '../shared/settings-types';

function isTheme(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * User settings, on disk.
 *
 * Follows `DevicePrefsStore` in `device-status.ts` deliberately rather than inventing a second
 * shape: atomic write through a temp file and a rename, and a missing or unreadable file falls back
 * to defaults instead of throwing. A settings file is the last thing that should be able to stop
 * the app starting.
 *
 * Every field is validated on read. The file is user-editable, and a hand-edited `cores: "lots"`
 * should mean "use the automatic value", not crash on first launch.
 */
export class SettingsStore {
  private current: Settings;

  constructor(private readonly file: string) {
    this.current = { ...DEFAULT_SETTINGS };
    try {
      this.current = sanitize(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // First run, or a file we cannot read. Defaults stand.
    }
  }

  get(): Settings {
    return { ...this.current };
  }

  /** Merges a partial update, validating each field. Returns the settings as they now stand. */
  set(patch: unknown): Settings {
    this.current = sanitize({ ...this.current, ...(patch as object) });
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // Held for this session only — worth less than refusing to apply the change at all.
    }
    return this.get();
  }
}

/**
 * Coerces anything into valid settings.
 *
 * The clamps are not arbitrary. Cores above the host's count oversubscribe a virtual CPU and make
 * the guest slower, and RAM below 1 GB will not boot Android at all — so a value that would
 * produce a broken guest is corrected rather than honoured.
 */
function sanitize(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;

  const clamp = (value: unknown, min: number, max: number): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };

  return {
    theme: isTheme(input.theme) ? input.theme : DEFAULT_SETTINGS.theme,
    device: isDeviceId(input.device) ? input.device : DEFAULT_SETTINGS.device,
    cores: clamp(input.cores, 1, 32),
    ramMb: clamp(input.ramMb, 1024, 16_384),
  };
}

/**
 * How much disk the runtime is using, and how much of that is reclaimable.
 *
 * Reclaimable means archives and scratch — never the extracted SDK or a guest's userdata. Someone
 * clicking "free up space" must not lose their apps, so the two numbers are computed from the same
 * definition `cleanup()` acts on.
 */
export function storageUsage(root: string, reclaimablePaths: string[]): StorageUsage {
  return {
    root,
    totalBytes: directorySize(root),
    reclaimableBytes: reclaimablePaths.reduce((sum, target) => sum + directorySize(target), 0),
  };
}

function directorySize(target: string): number {
  if (!existsSync(target)) return 0;
  try {
    const stat = statSync(target);
    if (stat.isFile()) return stat.size;
    let total = 0;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      total += directorySize(path.join(target, entry.name));
    }
    return total;
  } catch {
    // A file that vanished mid-walk, or one we cannot stat. Counting it as zero is better than
    // failing a size report.
    return 0;
  }
}
