import { existsSync } from 'fs';
import path from 'path';

/** Converts an absolute Windows path to its WSL2 `/mnt/<drive>/...` passthrough form. */
export function toWslMountPath(winPath: string): string {
  const normalized = path.resolve(winPath).replace(/\\/g, '/');
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
 *   source     three levels up from `dist/main`, i.e. the repo root.
 *
 * Detected by looking for the backend rather than by asking electron whether it is packaged, which
 * keeps this module free of an electron import — `setup-wizard.ts` depends on it, and that has to
 * stay loadable under plain `node --test`.
 */
export function repoRootWinPath(): string {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'backend') : null;
  if (packaged && existsSync(path.join(packaged, 'android', 'bin', 'open-emu'))) return packaged;

  // dist/main/win-paths.js -> dist/main -> dist -> desktop -> repo root
  return path.resolve(__dirname, '..', '..', '..');
}
