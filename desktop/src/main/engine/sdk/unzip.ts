import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { ProcessRunner } from '../process';

const runner = new ProcessRunner();

/**
 * Windows' own `tar.exe`, by absolute path — never resolved through `PATH`.
 *
 * This matters more than it looks. Windows ships **bsdtar** in System32, which reads zip. But other
 * tools put a **GNU tar** on `PATH` — Git for Windows is the common one — and GNU tar cannot read
 * zip at all. Worse, handed a Windows path it reads `C:\…` as a remote `host:path` spec and fails
 * with "Cannot connect to C: resolve failed", which looks like a network problem rather than the
 * wrong binary.
 *
 * Which one `tar` resolves to would therefore depend on how the app happened to be launched, so
 * the location is pinned instead of trusted.
 */
function windowsTar(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

/**
 * Extracts a zip archive.
 *
 * Uses `tar.exe`, which is **bsdtar** and has shipped in Windows since 10 build 1803. It reads zip
 * natively and is dramatically faster than the alternatives on the file sizes involved here: the
 * emulator package is 442 MB and the system image 676 MB, and PowerShell's `Expand-Archive` is
 * well known for taking minutes on archives that size because it streams each entry through the
 * pipeline. A pure-JavaScript inflate would be portable but sits in the middle on speed and would
 * add a meaningful chunk of code to maintain for a product that only ships on Windows.
 *
 * Off Windows it falls back to `unzip`, which keeps the module usable in a Linux dev checkout.
 */
export async function extractZip(zipPath: string, destination: string): Promise<void> {
  if (!existsSync(zipPath)) throw new Error(`archive not found: ${zipPath}`);
  mkdirSync(destination, { recursive: true });

  const windows = process.platform === 'win32';
  const file = windows ? windowsTar() : 'unzip';
  // bsdtar detects zip from the file itself, so no format flag is needed. `-C` is honoured by both.
  const args = windows ? ['-xf', zipPath, '-C', destination] : ['-oq', zipPath, '-d', destination];

  let result;
  try {
    result = await runner.run(file, { args, timeoutMs: 30 * 60_000 });
  } catch (err) {
    throw new Error(
      `could not run ${file} to extract ${zipPath}: ${(err as Error).message}. ` +
        (windows ? 'tar.exe ships with Windows 10 1803 and later.' : 'Install unzip.'),
    );
  }

  if (result.code !== 0) {
    const detail = [...result.stderr, ...result.stdout].slice(-3).join('; ');
    throw new Error(`extracting ${zipPath} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Whether the extractor this platform needs is actually present, for a setup preflight.
 *
 * The probe flag differs per tool. Info-ZIP `unzip` has no `--version`: it prints its banner and
 * exits 10, which made this report "missing" on every Linux machine that had it. `-v` is its
 * version flag and exits 0.
 */
export async function isExtractorAvailable(): Promise<boolean> {
  const windows = process.platform === 'win32';
  const file = windows ? windowsTar() : 'unzip';
  try {
    const result = await runner.run(file, { args: [windows ? '--version' : '-v'], timeoutMs: 15_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
