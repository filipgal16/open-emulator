import { spawn } from 'child_process';
import { decodeWindowsProcessOutput } from '../platform/windows-text';
import { isRebootPending, runElevated } from '../engine/elevation';
import type { LogStream } from '../../shared/ipc-types';

// Re-exported so existing callers keep a single import site while the WSL path is retired. The
// implementations moved to engine/elevation.ts because enabling the Windows Hypervisor Platform
// needs exactly the same two things installing WSL did: one elevated command, and an honest answer
// about whether Windows wants a restart before it takes effect.
export { isRebootPending, runElevated };

/**
 * Matches `LogHandler` in wsl-bridge, declared here so detection stays independent of the bridge.
 */
export type DetectLogHandler = (stream: LogStream, line: string) => void;

export interface DistroInfo {
  name: string;
  state: string;
  version: string;
  isDefault: boolean;
}

function runWslRaw(args: string[], timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, { windowsHide: true });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`wsl.exe ${args.join(' ')} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: decodeWindowsProcessOutput(Buffer.concat(outChunks)),
        stderr: decodeWindowsProcessOutput(Buffer.concat(errChunks)),
      });
    });
  });
}

export async function isWslAvailable(): Promise<boolean> {
  try {
    const { code } = await runWslRaw(['--status']);
    return code === 0;
  } catch {
    return false;
  }
}

export async function listDistros(): Promise<DistroInfo[]> {
  const { stdout } = await runWslRaw(['-l', '-v']);
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const distros: DistroInfo[] = [];
  for (const line of lines) {
    if (/^NAME\s+STATE\s+VERSION/i.test(line)) continue;
    const isDefault = line.startsWith('*');
    const cleaned = line.replace(/^\*\s*/, '');
    const parts = cleaned.split(/\s+/);
    if (parts.length < 3) continue;
    const version = parts[parts.length - 1];
    const state = parts[parts.length - 2];
    const name = parts.slice(0, parts.length - 2).join(' ');
    distros.push({ name, state, version, isDefault });
  }
  return distros;
}

/**
 * Installs WSL2 and a distro, unattended apart from one UAC prompt.
 *
 * Two details make this work without someone at the keyboard:
 *
 *   elevation   `wsl --install` turns on Windows optional features, which needs admin. The app
 *               itself runs unelevated on purpose, so it asks for elevation just here.
 *   --no-launch without it, the new distro immediately starts its interactive first-run and asks
 *               for a UNIX username and password. That would hang setup forever. Registering the
 *               distro unlaunched and then entering it as root initialises it silently.
 *
 * Windows may still want a restart afterwards to finish enabling the virtual machine platform;
 * the caller's next check will fail and say so.
 */
export async function installDistro(name = 'Ubuntu-22.04', onLog?: DetectLogHandler): Promise<void> {
  // The elevated child runs in its own console, so its output cannot be captured here. Narrating
  // the steps is not decoration: without it the setup wizard's log pane sits completely empty for
  // the several minutes this takes, which is exactly when someone is deciding whether the app has
  // hung. Every line below is a real transition, not filler.
  const log = (line: string) => onLog?.('stdout', line);

  log(`requesting administrator approval to install ${name}`);
  await runElevated('wsl.exe', ['--install', '-d', name, '--no-launch']);
  log(`wsl --install reported success for ${name}`);

  // First entry as root creates the filesystem without the account-setup prompt.
  log('initialising the distro filesystem');
  await runWslRaw(['-d', name, '-u', 'root', '--', 'true'], 5 * 60_000);

  // `wsl --install` exits 0 after merely *staging* the optional features, so success above does
  // not mean the distro exists. Confirming it registered turns a green step followed by a baffling
  // failure two steps later into one accurate message at the point of failure.
  const registered = (await listDistros()).some((d) => d.name === name);
  if (!registered) {
    log(`${name} did not register`);
    const pending = await isRebootPending();
    throw new Error(
      pending
        ? 'Windows needs a restart to finish enabling WSL. Restart Windows, then reopen open-emulator — setup continues where it stopped.'
        : `${name} did not register after installation. Restarting Windows usually resolves this.`,
    );
  }
  log(`${name} registered`);
}

export async function setDistroVersion2(name: string): Promise<void> {
  await runWslRaw(['--set-version', name, '2'], 5 * 60_000);
}
