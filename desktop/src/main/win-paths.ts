import path from 'path';

/** Converts an absolute Windows path to its WSL2 `/mnt/<drive>/...` passthrough form. */
export function toWslMountPath(winPath: string): string {
  const normalized = path.resolve(winPath).replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) throw new Error(`cannot convert to a WSL mount path: ${winPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/** Windows path to the repo root (parent of desktop/), derived from this compiled file's location. */
export function repoRootWinPath(): string {
  // dist/main/win-paths.js -> dist/main -> dist -> desktop -> repo root
  return path.resolve(__dirname, '..', '..', '..');
}
