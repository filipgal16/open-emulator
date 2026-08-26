import { spawn } from 'child_process';
import { runElevated } from './elevation';

/**
 * An opt-in Windows Defender exclusion for the emulator's folder.
 *
 * Defender's real-time scanner inspects every write, and a cold boot writes a lot — the guest's
 * userdata and snapshot images churn constantly. Excluding the emulator's own directory is a known
 * emulator speedup on Windows, and it is the most likely explanation for native Windows measuring
 * ~37s where the same setup measured ~24s under KVM.
 *
 * **This changes a security setting, so it is only ever done on an explicit request from the user.**
 * Nothing here runs on its own: detection is read-only and unprivileged; applying and reverting are
 * one elevated command each, behind a UAC prompt, and the reversal is exact. The exclusion is
 * scoped to `%LOCALAPPDATA%\open-emulator`, which holds nothing but this app's SDK and guest state.
 */

/** Runs a read-only PowerShell snippet and returns its stdout. Never throws; returns '' on failure. */
function powershell(script: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let out = '';
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

    child.stdout.on('data', (chunk) => (out += chunk.toString()));
    child.on('error', () => done(''));
    child.on('close', () => done(out));
  });
}

/**
 * Whether Defender is currently excluding the emulator folder.
 *
 * Read-only and unprivileged — `Get-MpPreference` needs no elevation. A path matches when it equals
 * the folder or sits beneath it, so a broader exclusion the user already has (their whole profile,
 * say) still counts and we do not offer to add a redundant one.
 *
 * `unknown` is a real third answer, distinct from `false`: Defender may be absent (a third-party
 * AV), managed by policy, or simply not queryable. The UI must not claim "not protected — turn it
 * on" when it does not actually know.
 */
export async function defenderExclusionState(folder: string): Promise<'excluded' | 'not-excluded' | 'unknown'> {
  const script =
    '$ErrorActionPreference="SilentlyContinue"; ' +
    '$p = (Get-MpPreference).ExclusionPath; ' +
    'if ($null -eq $p) { "none" } else { $p -join "`n" }';
  const out = (await powershell(script)).trim();
  if (out === '') return 'unknown';
  if (out === 'none') return 'not-excluded';

  return isCoveredBy(folder, out.split(/\r?\n/)) ? 'excluded' : 'not-excluded';
}

/**
 * Whether `folder` is covered by any of `exclusions` — equal to one, or nested under one.
 *
 * Pure and case-folded so it can be tested without a real Defender, and so a broader exclusion the
 * user already has (their whole profile directory, say) correctly counts as covering ours.
 */
export function isCoveredBy(folder: string, exclusions: string[]): boolean {
  const target = normalize(folder);
  if (!target) return false;

  for (const raw of exclusions) {
    const entry = normalize(raw);
    if (!entry) continue;
    if (target === entry || target.startsWith(`${entry}\\`)) return true;
  }
  return false;
}

/** Adds the exclusion, via one UAC prompt. Rejects if the user declines. */
export async function addDefenderExclusion(folder: string): Promise<void> {
  // Passed to powershell.exe (not the emulator), so the whole Add-MpPreference call is the argument
  // and the folder is single-quoted with any quote doubled — the same escaping runElevated uses.
  const quoted = `'${folder.replace(/'/g, "''")}'`;
  await runElevated('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Add-MpPreference -ExclusionPath ${quoted}`,
  ]);
}

/** Removes exactly the exclusion `addDefenderExclusion` adds. */
export async function removeDefenderExclusion(folder: string): Promise<void> {
  const quoted = `'${folder.replace(/'/g, "''")}'`;
  await runElevated('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Remove-MpPreference -ExclusionPath ${quoted}`,
  ]);
}

/** Case-folded, trailing-slash-trimmed, for comparing Windows paths. */
function normalize(p: string): string {
  return p.trim().replace(/[\\/]+$/, '').toLowerCase();
}
