import { existsSync } from 'fs';
import type { OpenEmuClient } from '../client';
import type { CheckResult, Step } from '../../setup-wizard';
import type { LogHandler } from '../../wsl/bridge';
import { detectAcceleration, enableWhpx } from '../acceleration';
import { isRebootPending } from '../elevation';
import { formatBytes, acquireDependencies, cleanup, resolveDependencies } from './dependencies';
import type { GuestProfile } from '../env-file';
import { systemImagePath, type SdkLayout } from './layout';
import { isExtractorAvailable } from './unzip';

export interface NativeSetupContext {
  layout: SdkLayout;
  openEmu: OpenEmuClient;
  profile: () => GuestProfile;
  /** Fires as bytes arrive, so the wizard's single bar tracks the real download. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * The first-run steps for the native Windows runtime.
 *
 * Same `Step` shape the WSL wizard uses, so `SetupRunner` drives either without knowing which — it
 * keeps the resumability, the "repair what you can unattended" behaviour, and the blocking-step
 * semantics for free.
 *
 * The step list is where going native shows up most plainly. Installing a Linux distribution,
 * apt-getting a JDK, and syncing a shell backend into it are all simply gone; what is left is the
 * work that was always the real cost.
 */
export function buildNativeSteps(context: NativeSetupContext): Step[] {
  const { layout, openEmu, profile } = context;

  return [
    {
      id: 'acceleration',
      label: 'Hardware acceleration',
      // Not blocking: without a hypervisor the guest still runs, just slowly. Refusing to continue
      // would be worse than a slow emulator, and the user may not be able to change their firmware.
      blocking: false,
      working: 'Turning on the Windows Hypervisor Platform. Windows will ask for permission.',
      check: async (): Promise<CheckResult> => {
        const state = await detectAcceleration();
        if (state.available) return { pass: true, detail: state.detail };

        // A staged feature reports success and does nothing until reboot; saying so at the point of
        // failure is the difference between a dead end and a fix.
        if (state.fixable && (await isRebootPending())) {
          return {
            pass: false,
            warn: true,
            detail: 'Windows needs a restart to finish enabling acceleration. Restart, then reopen open-emulator.',
          };
        }
        return { pass: false, warn: true, detail: state.detail };
      },
      fix: async (onLog: LogHandler) => {
        const state = await detectAcceleration();
        // Only offer the fix that can actually work. Running DISM when the real problem is a BIOS
        // setting burns a UAC prompt and changes nothing.
        if (!state.fixable) return;
        await enableWhpx(onLog);
      },
    },
    {
      id: 'extractor',
      label: 'Archive support',
      blocking: true,
      check: async (): Promise<CheckResult> => {
        const ok = await isExtractorAvailable();
        return {
          pass: ok,
          detail: ok
            ? 'Present'
            : 'tar.exe is missing from System32. It ships with Windows 10 build 1803 and later.',
        };
      },
    },
    {
      id: 'sdk',
      label: 'Android system image',
      blocking: true,
      working: 'Downloading Android. This is the long one, and it only happens once.',
      /**
       * The emulator binary *and* the image the selected profile needs.
       *
       * Checking only the emulator was wrong the moment there was more than one profile: switching
       * to the Play guest sails past a check that only looks for `emulator.exe` and fails much
       * later, long after "download Android" was the obvious remedy.
       */
      check: async (): Promise<CheckResult> => {
        const current = profile();
        const haveEmulator = existsSync(layout.emulator) && existsSync(layout.adb);
        const haveImage = existsSync(systemImagePath(layout, current.imageTag));

        if (haveEmulator && haveImage) return { pass: true, detail: 'Downloaded' };
        return {
          pass: false,
          detail: haveEmulator
            ? `The ${current.name} system image is not downloaded yet`
            : 'Not downloaded yet (about 1.2 GB)',
        };
      },
      fix: async (onLog: LogHandler) => {
        const plan = await resolveDependencies({ profile: profile() });
        onLog('stdout', `${plan.archives.length} packages, ${formatBytes(plan.totalBytes)} total`);

        await acquireDependencies({
          layout,
          plan,
          onLog,
          onProgress: (progress) => context.onProgress?.(progress.bytesDone, progress.bytesTotal),
        });

        // Only now, with every extraction done. Archives deleted earlier would make one failed
        // extraction cost the whole download again.
        const freed = cleanup(layout);
        if (freed.bytesFreed > 0) {
          onLog('stdout', `cleaned up ${formatBytes(freed.bytesFreed)} of installation files`);
        }
      },
    },
    {
      id: 'provisioned',
      label: 'Preparing your device',
      // Not blocking, and that is the point of the whole reordering. Everything above this can
      // finish without a restart, so setup completes and the several-gigabyte download is banked.
      // The one thing that genuinely needs a hypervisor is starting Android, and deferring it here
      // means a restart is something the user does when convenient rather than a gate they hit
      // before anything useful has happened.
      blocking: false,
      working: 'Starting Android for the first time and saving a snapshot, so later launches are quick.',
      check: async (): Promise<CheckResult> => {
        const result = await openEmu.status(() => undefined);
        if (result.stdout.some((line) => line.startsWith('provisioned_at='))) {
          return { pass: true, detail: 'Ready' };
        }

        // Preparing means booting, and on Windows the emulator will not boot without a hypervisor
        // — it starts and then sits there. Attempting it anyway would hang setup for an hour and
        // then fail, so say what is needed instead.
        const acceleration = await detectAcceleration();
        if (!acceleration.available) {
          return {
            pass: false,
            warn: true,
            detail: `Everything is downloaded. ${acceleration.detail}`,
          };
        }

        return { pass: false, detail: 'Not prepared yet' };
      },
      fix: async (onLog: LogHandler) => {
        const acceleration = await detectAcceleration();
        // Skip rather than fail: the download succeeded, and reporting a red step for something
        // that is waiting on a restart misrepresents what happened.
        if (!acceleration.available) return;

        const result = await openEmu.provision(onLog);
        if (result.code !== 0) {
          throw new Error(result.stderr.join(' ') || 'the device could not be prepared');
        }
      },
    },
  ];
}
