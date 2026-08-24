import { spawn } from 'child_process';

/**
 * Running something as administrator, and knowing when Windows wants a restart.
 *
 * Both of these were written for the WSL install path and both outlive it: enabling the Windows
 * Hypervisor Platform needs exactly the same two things — one elevated command, and an honest
 * answer about whether it has actually taken effect yet.
 */

/**
 * Runs a command elevated, via a UAC prompt.
 *
 * Resolves only if the user accepts and the command exits 0. Declining throws, which the caller
 * surfaces as a setup failure rather than a silent no-op — a setup step that quietly does nothing
 * is worse than one that fails, because the failure arrives later and somewhere else.
 */
export function runElevated(file: string, args: string[], timeoutMs = 15 * 60_000): Promise<void> {
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
 * True when Windows has staged feature changes that need a restart to take effect.
 *
 * This is the trap that every "enable an optional feature" flow falls into. `wsl --install` and
 * `DISM /Enable-Feature` both report success, change nothing observable, and stay that way until
 * the machine reboots — while every direct check keeps saying the feature is fine. The user sees a
 * green step immediately followed by a baffling failure two steps later, with no mention anywhere
 * of the one action that fixes it.
 *
 * Only ever used to *explain* a failure, never to cause one: a reboot pending for unrelated
 * reasons (a Windows update) must not block setup on a machine where everything already works.
 *
 * The CBS key is the one servicing sets when a feature is enabled but not yet live.
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
