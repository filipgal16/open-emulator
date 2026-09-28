import { existsSync } from 'fs';
import path from 'path';

/**
 * Converts an absolute Windows path to its WSL2 `/mnt/<drive>/...` passthrough form.
 *
 * `path.win32` rather than `path`: the input is always a Windows path, whatever this process runs
 * on. Under the host's own rules on Linux, `C:\x` is a relative name and resolves to `<cwd>/C:\x`.
 */
export function toWslMountPath(winPath: string): string {
  const normalized = path.win32.resolve(winPath).replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) throw new Error(`cannot convert to a WSL mount path: ${winPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/**
 * Where the Android backend lives on the Windows side — the tree that gets synced into the distro.
 *
 * Two layouts, because a packaged app is not a source checkout:
 *
 *   installed  `resources/backend/` beside the asar. The backend *must* live outside `app.asar`:
 *              an asar is a single file, so a path inside it is not a real directory and cannot be
 *              read by `tar`, `cp`, or WSL at all. electron-builder puts it there via
 *              `extraResources`.
 *   source     the repo root, found by walking up from this file.
 *
 * Detected by looking for the backend rather than by asking electron whether it is packaged, which
 * keeps this module free of an electron import — `setup-wizard.ts` depends on it, and that has to
 * stay loadable under plain `node --test`.
 *
 * The walk searches for `android/profiles` rather than counting directories. Counting is what this
 * did before, and moving this file one level deeper silently changed where it landed — the profile
 * list came back empty and the setup wizard decided the backend was stale. A marker cannot drift
 * that way.
 */
export function repoRootWinPath(): string {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'backend') : null;
  if (packaged && existsSync(path.join(packaged, 'android', 'bin', 'open-emu'))) return packaged;

  let dir = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, 'android', 'profiles'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Nothing found — fall back to the historical guess so the caller gets a path rather than a
  // throw, and fails with its own message about what is actually missing.
  return path.resolve(__dirname, '..', '..', '..', '..');
}
