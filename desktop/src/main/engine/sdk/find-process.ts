import { spawn } from 'child_process';
import { decodeWindowsProcessOutput } from '../../platform/windows-text';

/**
 * Finds the emulator's QEMU process for an AVD by its command line.
 *
 * Exists because the pid we spawn is the wrong one to remember. `emulator.exe` is a launcher: it
 * starts `qemu-system-x86_64.exe` and forwards its output — and when the app that spawned it
 * exits, the launcher's stdio pipes close and the launcher goes with them, while QEMU carries on
 * running the guest. The pid file then names a dead process, `status` reports a running guest as
 * stopped, nothing embeds its window, and the next `start` boots a second emulator against the
 * same AVD. Observed exactly that way after the first app restart.
 *
 * The AVD name is on QEMU's command line as `-avd <name>`, which is enough to find it again.
 */

const QEMU_IMAGE = 'qemu-system-x86_64.exe';

/** Picks the pid whose command line names this AVD. Pure, so the matching can be tested. */
export function matchQemuPid(lines: string[], avdName: string): number | null {
  const escaped = avdName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)-avd\\s+"?${escaped}"?(?:\\s|$)`);
  for (const raw of lines) {
    const line = raw.trim();
    const sep = line.indexOf('|');
    if (sep <= 0) continue;
    const pid = Number.parseInt(line.slice(0, sep), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (pattern.test(line.slice(sep + 1))) return pid;
  }
  return null;
}

export async function findQemuPid(avdName: string, timeoutMs = 15_000): Promise<number | null> {
  if (process.platform !== 'win32') return null;

  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${QEMU_IMAGE}'" | ` +
    'ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }';

  const output = await new Promise<string>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done('');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Never the reason a status poll fails: every error path reads as "not found".
    child.on('error', () => done(''));
    child.on('close', () => done(decodeWindowsProcessOutput(Buffer.concat(chunks))));
  });

  return matchQemuPid(output.split(/\r?\n/), avdName);
}
