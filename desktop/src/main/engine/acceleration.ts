import { spawn } from 'child_process';
import { decodeWindowsProcessOutput } from '../windows-text';
import { isRebootPending, runElevated } from './elevation';
import type { EngineLogHandler } from './types';

/**
 * Hardware acceleration on Windows, for both engines.
 *
 * Without it the guest still runs — QEMU falls back to interpreting every instruction — but a cold
 * boot goes from well under a minute to the better part of an hour. It is the single largest factor
 * in whether this feels like a product.
 *
 * Two mechanisms exist and they are mutually exclusive:
 *
 *   **WHPX** (Windows Hypervisor Platform) is a Windows feature. It works on Intel and AMD, and it
 *   coexists with Hyper-V, WSL2, Docker, and WSA. Enabling it costs one elevated command and a
 *   restart. This is the default, and the reason is compatibility rather than speed: a machine
 *   running this app is quite likely running WSL2 or Docker too.
 *
 *   **AEHD** (Android Emulator Hypervisor Driver, Google's successor to Intel HAXM) is a kernel
 *   driver that benchmarks faster on AMD — but it requires Hyper-V and the Virtual Machine
 *   Platform to be **off**, which breaks WSL2 and everything built on it. Detected and used when
 *   already present; never installed automatically, because doing so would silently disable other
 *   software the user depends on.
 */

export type AccelMethod = 'whpx' | 'aehd' | 'none';

export interface AccelerationState {
  available: boolean;
  method: AccelMethod;
  /** Plain-language explanation, suitable for the setup UI. */
  detail: string;
  /** True when the fix is "enable a Windows feature", which this app can offer to do. */
  fixable: boolean;
}

const WHPX_FEATURE = 'HypervisorPlatform';

function runQuiet(file: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
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
    // Detection must never be the thing that breaks startup: every failure path resolves to an
    // empty string, which reads downstream as "not available" rather than throwing.
    child.on('error', () => done(''));
    child.on('close', () => done(decodeWindowsProcessOutput(Buffer.concat(chunks))));
  });
}

/**
 * Whether the Windows Hypervisor Platform feature is enabled.
 *
 * Queried through CIM rather than `DISM /Get-FeatureInfo` because DISM's online image operations
 * want elevation, and this runs at startup in an unelevated app. `InstallState = 1` means enabled.
 */
export async function isWhpxEnabled(): Promise<boolean> {
  const out = await runQuiet('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='${WHPX_FEATURE}'").InstallState`,
  ]);
  return out.trim() === '1';
}

/** Whether Google's hypervisor driver is installed and running. */
export async function isAehdRunning(): Promise<boolean> {
  // Both names are checked: the driver shipped as `gvm` before it was renamed `aehd`, and machines
  // set up against older SDK releases still have the old one.
  for (const service of ['aehd', 'gvm']) {
    const out = await runQuiet('sc.exe', ['query', service], 10_000);
    if (/RUNNING/i.test(out)) return true;
  }
  return false;
}

/**
 * Whether the firmware exposes virtualization at all.
 *
 * Distinguishing "turned off in BIOS" from "Windows feature not enabled" matters, because only one
 * of them is something this app can fix. Telling someone to click a button that cannot help is
 * worse than telling them to reboot into firmware settings.
 */
export async function isVirtualizationEnabledInFirmware(): Promise<boolean> {
  const out = await runQuiet('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-CimInstance Win32_ComputerSystem).HypervisorPresent, ' +
      '(Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled',
  ]);
  // Either being true is enough: once a hypervisor is running, the firmware flag often reads False
  // because the setting has already been consumed by it.
  return /true/i.test(out);
}

export interface AccelerationProbes {
  windows: boolean;
  aehdRunning: boolean;
  whpxEnabled: boolean;
  firmwareVirtualization: boolean;
  /**
   * Windows has staged feature changes that need a restart.
   *
   * Only meaningful alongside `whpxEnabled`: the feature reports itself enabled the moment DISM
   * finishes, and stays that way — while doing nothing at all — until the machine restarts.
   */
  rebootPending: boolean;
}

/**
 * Turns four facts into an answer and a sentence.
 *
 * Split from the probing so the branch that matters can be tested: distinguishing "your BIOS has
 * virtualization switched off" from "Windows needs a feature enabled" decides whether the UI shows
 * a button that fixes it or instructions that the button cannot. Offering a fix that cannot work
 * is worse than offering none.
 */
export function decideAcceleration(probes: AccelerationProbes): AccelerationState {
  if (!probes.windows) {
    return { available: false, method: 'none', detail: 'not a Windows host', fixable: false };
  }

  // AEHD first: if it is running, WHPX is necessarily off, and reporting WHPX as the missing piece
  // on a machine that is already accelerated would be simply wrong.
  if (probes.aehdRunning) {
    return {
      available: true,
      method: 'aehd',
      detail: 'Android Emulator Hypervisor Driver is running',
      fixable: false,
    };
  }

  if (probes.whpxEnabled) {
    // Enabled is not the same as working. DISM reports success and flips the feature's state
    // immediately, but nothing actually changes until the machine restarts — so believing the flag
    // here would have the app pass `-accel whpx` to an emulator that then refuses to start, and
    // blame the emulator. This is the same trap `wsl --install` sets, and the reason
    // `isRebootPending` exists at all.
    if (probes.rebootPending) {
      return {
        available: false,
        method: 'none',
        detail:
          'Hardware acceleration is switched on but needs a restart to take effect. ' +
          'Restart Windows, then reopen open-emulator.',
        // Not fixable from here: the fix is a restart, which is the user's to perform.
        fixable: false,
      };
    }
    return { available: true, method: 'whpx', detail: 'Windows Hypervisor Platform is enabled', fixable: false };
  }

  if (!probes.firmwareVirtualization) {
    return {
      available: false,
      method: 'none',
      detail:
        'Virtualization is turned off in your PC’s firmware. Enable it in the BIOS or UEFI settings — ' +
        'it is usually called Intel VT-x, AMD-V, or SVM.',
      fixable: false,
    };
  }

  return {
    available: false,
    method: 'none',
    detail: 'Windows Hypervisor Platform is not enabled yet. Android would run very slowly without it.',
    fixable: true,
  };
}

export async function detectAcceleration(): Promise<AccelerationState> {
  if (process.platform !== 'win32') {
    return decideAcceleration({
      windows: false,
      aehdRunning: false,
      whpxEnabled: false,
      firmwareVirtualization: false,
      rebootPending: false,
    });
  }

  const aehdRunning = await isAehdRunning();
  const whpxEnabled = aehdRunning ? false : await isWhpxEnabled();
  const firmwareVirtualization = aehdRunning || whpxEnabled ? true : await isVirtualizationEnabledInFirmware();
  // Only asked when it could change the answer — the check costs a reg.exe round trip.
  const rebootPending = whpxEnabled && !aehdRunning ? await isRebootPending() : false;

  return decideAcceleration({ windows: true, aehdRunning, whpxEnabled, firmwareVirtualization, rebootPending });
}

/**
 * Turns the Windows Hypervisor Platform on.
 *
 * One UAC prompt, then a restart. `/NoRestart` is deliberate: rebooting a machine out from under
 * someone is never acceptable, and the caller reports the pending restart instead — see
 * `isRebootPending`, which exists precisely because enabling a feature reports success and changes
 * nothing observable until the machine comes back.
 */
export async function enableWhpx(onLog: EngineLogHandler = () => undefined): Promise<void> {
  onLog('stdout', 'requesting administrator approval to enable the Windows Hypervisor Platform');
  await runElevated('dism.exe', [
    '/Online',
    '/Enable-Feature',
    `/FeatureName:${WHPX_FEATURE}`,
    '/All',
    '/NoRestart',
  ]);
  onLog('stdout', 'the feature was enabled — Windows needs a restart before it takes effect');
}
