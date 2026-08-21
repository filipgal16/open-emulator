import { spawn } from 'child_process';
import { decodeWindowsProcessOutput } from './windows-text';

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

/** Triggers Windows' one-line WSL2 + distro installer. May require an admin prompt and a reboot. */
export async function installDistro(name = 'Ubuntu-22.04'): Promise<void> {
  await runWslRaw(['--install', '-d', name], 10 * 60_000);
}

export async function setDistroVersion2(name: string): Promise<void> {
  await runWslRaw(['--set-version', name, '2'], 5 * 60_000);
}
