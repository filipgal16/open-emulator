import type { OpenEmuClient } from '../engine/client';
import type { InstalledApp } from '../../shared/ipc-types';

/**
 * Android package names are `[a-zA-Z][a-zA-Z0-9_]*` segments joined by dots. Anything else is
 * refused rather than escaped: these strings are interpolated into a shell command that crosses
 * into WSL and then into `adb shell`, so an allowlist is the only defence that survives three
 * layers of quoting.
 */
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && PACKAGE_RE.test(name);
}

/**
 * Turns a package name into something a person recognises: `com.king.candycrushsaga` →
 * "Candycrushsaga". Crude, but the alternative is pulling real labels out of the guest's package
 * manager per app, which costs an adb round trip each and is not worth it for a list.
 */
export function prettyLabel(packageName: string): string {
  const last = packageName.split('.').filter(Boolean).pop() ?? packageName;
  return last.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export class AppLibrary {
  constructor(private readonly openEmu: OpenEmuClient) {}

  /** Third-party packages installed in the guest. Excludes the system image's own apps. */
  async list(): Promise<InstalledApp[]> {
    const result = await this.openEmu.shell('pm list packages -3', () => undefined, 20_000);
    return result.stdout
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length).trim())
      .filter(isValidPackageName)
      .sort()
      .map((packageName) => ({ packageName, label: prettyLabel(packageName) }));
  }

  /** Package names only — the cheap path used by install attribution polling. */
  async listPackageNames(): Promise<string[]> {
    return (await this.list()).map((app) => app.packageName);
  }

  async launch(packageName: string): Promise<boolean> {
    if (!isValidPackageName(packageName)) return false;
    const result = await this.openEmu.shell(
      `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
      () => undefined,
      20_000,
    );
    return result.code === 0;
  }
}
