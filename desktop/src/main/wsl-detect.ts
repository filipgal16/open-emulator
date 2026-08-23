import { spawn } from 'child_process';
import { decodeWindowsProcessOutput } from './windows-text';
import type { LogStream } from '../shared/ipc-types';

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

/**
 * True when Windows has staged feature changes that need a restart to take effect.
 *
 * `wsl --install` enables the Virtual Machine Platform optional feature. On a machine that did not
 * already have it, the command reports success, registers no distro, and everything stays that way
 * until the machine reboots — while `wsl --status` keeps exiting 0 throughout, so
 * `isWslAvailable()` sees nothing wrong.
 *
 * That combination is what a first-time user actually hits: a green "Windows Subsystem for Linux —
 * Installed" immediately followed by "no usable distro found", and no mention anywhere of the one
 * action that fixes it. This is only ever used to *explain* a failure, never to cause one — a
 * reboot pending for unrelated reasons (a Windows update) must not block setup on a machine where
 * WSL already works.
 *
 * The CBS key is the one servicing sets when an optional feature is enabled but not yet live.
 */
export function isRebootPending(): Promise<boolean> {
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending';
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['query', key], { windowsHide: true });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Absence of the key is the common case and exits non-zero; anything unexpected is reported as
    // "not pending" so this can never be the reason setup fails.
    const timer = setTimeout(() => done(false), 10_000);
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
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
 * Runs a command elevated, via a UAC prompt.
 *
 * Resolves only if the user accepts and the command exits 0. Declining the prompt throws, which
 * the caller surfaces as a setup failure rather than a silent no-op.
 */
function runElevated(file: string, args: string[], timeoutMs = 15 * 60_000): Promise<void> {
  const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const script = `$p = Start-Process -FilePath '${file}' -ArgumentList ${quoted} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('the elevated command timed out'));
    }, timeoutMs);

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
      if (code === 0) resolve();
      else reject(new Error(`elevation was declined or the command failed (exit ${code})`));
    });
  });
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
