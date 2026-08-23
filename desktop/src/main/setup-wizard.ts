import { readdirSync } from 'fs';
import path from 'path';
import { LogHandler, WslBridge, WslTarget } from './wsl-bridge';
import { OpenEmuClient } from './open-emu-client';
import { installDistro, isRebootPending, isWslAvailable, listDistros, setDistroVersion2 } from './wsl-detect';
import { repoRootWinPath, toWslMountPath } from './win-paths';
import type { SetupStepStatus } from '../shared/ipc-types';

interface CheckResult {
  pass: boolean;
  warn?: boolean;
  detail: string;
}

/**
 * Guest profiles this build ships, read from the repo beside the app.
 *
 * Names are validated rather than trusted: they are interpolated into a shell command that crosses
 * into WSL, and a filename is not something to hand a shell unchecked.
 */
/**
 * `ANDROID_PROFILE=<name>` for a raw `bridge.run`, or empty when no profile is pinned.
 *
 * Validated rather than trusted: profile names come from a fixed set of filenames, but this is
 * interpolated into a shell command that crosses into WSL.
 */
/**
 * The distro-side checkout, as a quoted absolute path.
 *
 * Async because resolving `~` means asking the distro where home actually is — see
 * `expandHome` for why neither `'~/…'` nor `"$HOME/…"` can be used directly.
 */
function remote(bridge: WslBridge): Promise<string> {
  return bridge.quotedRemoteDir();
}

export function profileEnv(target: { profile: string | null }): string {
  const profile = target.profile && /^[a-z0-9_-]{1,32}$/.test(target.profile) ? target.profile : null;
  return profile ? `ANDROID_PROFILE=${profile}` : '';
}

/** The profile whose image the SDK check should look for. Validated; falls back to the default. */
export function selectedProfile(target: { profile: string | null }): string {
  return target.profile && /^[a-z0-9_-]{1,32}$/.test(target.profile) ? target.profile : 'fast';
}

/**
 * Is the emulator *and* the system image the selected profile needs actually on disk?
 *
 * Reads the image tag straight out of `android/profiles/<name>.env` rather than sourcing
 * `common.sh` and calling `android_env`. That version looked tidier and did not work: under the
 * login shell WSL hands us, the sourced function's variables came back empty and the probe
 * reported "not downloaded" for a complete SDK — sending the app off to re-fetch 4 GB it already
 * had. Two `test`s and a `sed` have nowhere to hide.
 *
 * Checking the image, not just the emulator binary, is the point: switching to the Play guest used
 * to sail past this step with no Play image present and fail much later inside `avdmanager`.
 */
export async function sdkProbe(bridge: WslBridge, target: { profile: string | null }): Promise<string> {
  const dir = await bridge.quotedRemoteDir();
  const profile = selectedProfile(target);
  // Absolute paths throughout, with no `cd`. The version that changed directory first and used
  // relative paths reported a complete SDK as missing from inside the packaged app — and would
  // have sent every user off to re-download 4 GB. Nothing here depends on the working directory,
  // which is one fewer thing that can differ between a dev run and an installed one.
  return (
    `tag=$(sed -n 's/^PROFILE_IMAGE_TAG=//p' ${dir}/android/profiles/${profile}.env | tr -d '"' | head -1) && ` +
    `test -n "$tag" && test -x ${dir}/android/sdk/emulator/emulator && ` +
    `test -f ${dir}/android/sdk/system-images/android-30/"$tag"/x86_64/system.img && echo yes || echo no`
  );
}

/** Commands the Android backend needs on PATH inside the distro, and the package each comes from. */
export const REQUIRED_TOOLS: Array<{ command: string; pkg: string }> = [
  { command: 'java', pkg: 'openjdk-17-jdk-headless' },
  { command: 'unzip', pkg: 'unzip' },
  { command: 'make', pkg: 'make' },
  { command: 'curl', pkg: 'curl' },
  { command: 'python3', pkg: 'python3' },
];

/** Which of `REQUIRED_TOOLS` are not present. One round trip, not one per tool. */
export async function missingPackages(bridge: WslBridge): Promise<string[]> {
  const probe = REQUIRED_TOOLS.map(({ command }) => `command -v ${command} >/dev/null || echo ${command}`).join('; ');
  const result = await bridge.run(probe, () => undefined, 30_000);
  const absent = new Set(result.stdout.map((line) => line.trim()).filter(Boolean));
  return REQUIRED_TOOLS.filter(({ command }) => absent.has(command)).map(({ pkg }) => pkg);
}

export function localProfileNames(): string[] {
  try {
    return readdirSync(path.join(repoRootWinPath(), 'android', 'profiles'))
      .filter((entry) => entry.endsWith('.env'))
      .map((entry) => entry.slice(0, -'.env'.length))
      .filter((name) => /^[a-z0-9_-]{1,32}$/.test(name));
  } catch {
    // No profiles directory beside the app (a packaged build laid out differently) — fall back to
    // the presence check alone rather than declaring a working distro stale.
    return [];
  }
}

interface Step {
  id: string;
  label: string;
  blocking: boolean;
  /** Shown while the fix runs. Plain language, and honest about how long it will take. */
  working?: string;
  check: () => Promise<CheckResult>;
  fix?: (onLog: LogHandler) => Promise<void>;
}

/**
 * Doctor-check + remediation steps, run in order. Each blocking step must pass before the setup
 * wizard hands off to the main app screen; `kvm` is informational only (TCG fallback works).
 *
 * `target` is the same mutable object shared with the app's WslBridge/ScreenMirror instances —
 * the exact distro to use isn't known until the `distro` step resolves it (it may adopt an
 * existing WSL2 Ubuntu install under a name other than the configured default), so that
 * resolution writes back into `target.distro` directly rather than being a step-local value.
 */
export function buildSteps(bridge: WslBridge, openEmu: OpenEmuClient, target: WslTarget): Step[] {
  const truthy = (result: { stdout: string[] }) => result.stdout.join('').trim() === 'yes';

  return [
    {
      id: 'wsl',
      label: 'Windows Subsystem for Linux',
      blocking: true,
      working: 'Installing Windows Subsystem for Linux. Windows may ask you to restart afterwards.',
      check: async () => {
        const ok = await isWslAvailable();
        return {
          pass: ok,
          detail: ok
            ? 'Installed'
            : // The most common reason this is still failing after the fix ran: Windows enabled the
              // virtual machine platform but wants a restart before it works.
              'Not available yet. If it was just installed, restart Windows and reopen open-emulator.',
        };
      },
      fix: async (onLog) => {
        await installDistro('Ubuntu-22.04', onLog);
      },
    },
    {
      id: 'distro',
      label: 'Linux environment',
      blocking: true,
      working: 'Setting up the Linux environment that runs Android.',
      check: async () => {
        const distros = await listDistros();
        const configured = distros.find((d) => d.name === target.distro);
        if (configured && configured.version === '2') {
          return { pass: true, detail: `${configured.name} (WSL2, ${configured.state})` };
        }
        // Configured distro not present under that name — adopt any existing WSL2 Ubuntu
        // install instead of forcing the user through a fresh multi-GB install.
        const ubuntu2 = distros.find((d) => /ubuntu/i.test(d.name) && d.version === '2');
        if (ubuntu2) {
          target.distro = ubuntu2.name;
          return { pass: true, detail: `adopted existing distro "${ubuntu2.name}" (WSL2, ${ubuntu2.state})` };
        }
        const ubuntu1 = distros.find((d) => /ubuntu/i.test(d.name));
        if (ubuntu1) return { pass: false, detail: `"${ubuntu1.name}" is WSL1, needs upgrade to WSL2` };
        // No distro *and* staged feature changes means WSL was just installed and has not taken
        // effect yet. Naming the restart here is the difference between a dead end and a fix: the
        // `wsl` step above already passed, so its own restart hint never rendered.
        if (await isRebootPending()) {
          return {
            pass: false,
            detail: 'Windows needs a restart to finish enabling WSL. Restart, then reopen open-emulator.',
          };
        }
        return { pass: false, detail: 'no usable distro found' };
      },
      fix: async (onLog) => {
        const distros = await listDistros();
        const ubuntu1 = distros.find((d) => /ubuntu/i.test(d.name) && d.version !== '2');
        if (ubuntu1) {
          await setDistroVersion2(ubuntu1.name);
          target.distro = ubuntu1.name;
          return;
        }
        await installDistro('Ubuntu-22.04', onLog);
        target.distro = 'Ubuntu-22.04';
      },
    },
    {
      id: 'deps',
      label: 'Android tools',
      blocking: true,
      working: 'Installing the packages Android needs. A minute or two.',
      /**
       * A fresh `wsl --install` Ubuntu has curl and python3, but no Java, no unzip, and no make —
       * and `sdkmanager` is a Java program. Without this the download step fails several minutes
       * in with a message about a missing JVM, which reads as a broken app rather than a missing
       * package. Nothing else in the flow installs these.
       */
      check: async () => {
        const missing = await missingPackages(bridge);
        return missing.length === 0
          ? { pass: true, detail: 'Installed' }
          : { pass: false, detail: `Missing: ${missing.join(', ')}` };
      },
      fix: async (onLog) => {
        // Root, because there is nobody present to answer a sudo prompt. Headless JDK and
        // --no-install-recommends keep this to a few hundred MB rather than pulling in a desktop.
        await bridge.runAsRoot(
          'export DEBIAN_FRONTEND=noninteractive && apt-get update && ' +
            'apt-get install -y --no-install-recommends ' +
            'openjdk-17-jdk-headless unzip make curl ca-certificates python3 libpulse0',
          onLog,
          20 * 60_000,
        );
        // The emulator opens /dev/kvm, which is root:kvm. Whoever runs the backend needs to be in
        // that group; it takes effect on the next distro start, which the emulator start does.
        await bridge.runAsRoot(
          'getent group kvm >/dev/null && usermod -aG kvm "$(id -un 1000 2>/dev/null || echo root)" || true',
          onLog,
          30_000,
        );
      },
    },
    {
      id: 'kvm',
      label: 'Hardware acceleration',
      blocking: false,
      check: async () => {
        const result = await bridge.run('test -e /dev/kvm && echo yes || echo no', () => undefined, 10_000);
        const has = truthy(result);
        return {
          pass: has,
          warn: !has,
          detail: has ? '/dev/kvm present' : '/dev/kvm not found — will run slower (software rendering fallback)',
        };
      },
    },
    {
      id: 'backend',
      label: 'Emulator files',
      blocking: true,
      working: 'Copying the emulator files into the Linux environment.',
      /**
       * Presence *and* freshness.
       *
       * Checking only that `open-emu` exists meant the copy was made once and never revisited, so
       * a distro synced by an older build kept running that older backend forever. The profiles
       * are the cheap tell: they are the newest thing the shell depends on by name (the Store's
       * Play tab needs `play.env`), and `load_profile` hard-fails on a missing one — which would
       * otherwise surface as a confusing error deep inside a make target.
       */
      check: async () => {
        const dir = await remote(bridge);
        const profiles = localProfileNames();
        const tests = [
          `test -x ${dir}/android/bin/open-emu`,
          ...profiles.map((name) => `test -f ${dir}/android/profiles/${name}.env`),
        ].join(' && ');

        const result = await bridge.run(`${tests} && echo yes || echo no`, () => undefined, 15_000);
        if (truthy(result)) return { pass: true, detail: `${target.remotePath} present and current` };

        const present = await bridge.run(
          `test -x ${dir}/android/bin/open-emu && echo yes || echo no`,
          () => undefined,
          10_000,
        );
        return {
          pass: false,
          detail: truthy(present)
            ? `${target.remotePath} is out of date — re-sync to pick up newer profiles`
            : `${target.remotePath} missing or incomplete`,
        };
      },
      fix: async (onLog) => {
        const src = toWslMountPath(repoRootWinPath());
        // Quoted so `~` still expands. Single-quoting this was how a packaged build ended up
        // creating a directory literally named `~` beside the installed app and syncing into it.
        const dest = await remote(bridge);

        // Copied through tar rather than `cp -r`, so the transfer can exclude things.
        //
        // The distro runs the Android backend and nothing else — it never runs Electron — but a
        // plain `cp -r` of the repo root drags `desktop/node_modules` across with it: ~465 MB of
        // files the far side has no use for, over a 9p mount, every time someone re-syncs. The
        // part that matters is a few hundred KB.
        //
        // Excluding the generated Android directories is what makes the copy safe to repeat: the
        // fetched SDK, the AVD, and the runtime state live only in the distro, and re-syncing must
        // leave them alone rather than half-overwrite them from a Windows tree that has none.
        const excludes = [
          './.git',
          './desktop/node_modules',
          './desktop/dist',
          './desktop/build',
          './desktop/out',
          './build',
          './android/sdk',
          './android/avd',
          './android/state',
          './android/logs',
          '*/node_modules',
        ]
          .map((pattern) => `--exclude='${pattern}'`)
          .join(' ');

        // Then normalise line endings and restore the executable bit.
        //
        // Load-bearing on Windows. Git's `core.autocrlf=true` — the usual default here — checks
        // these scripts out with CRLF, and bash cannot parse those: `open-emu` fails with
        // `/usr/bin/env: 'bash\r': No such file or directory`, which reads as a corrupt file
        // rather than a line-ending problem. Copying them in unmodified would replace a working
        // backend with one that cannot start. `.gitattributes` pins LF for fresh clones; this
        // covers working copies that already have CRLF on disk.
        const scripts = `find ${dest}/android ${dest}/scripts -type f \\( -name '*.sh' -o -name '*.env' \\) -print0 2>/dev/null`;

        await bridge.run(
          [
            `mkdir -p ${dest}`,
            `tar -C '${src}' -cf - ${excludes} . | tar -C ${dest} -xf -`,
            `${scripts} | xargs -0 -r sed -i 's/\\r$//'`,
            `sed -i 's/\\r$//' ${dest}/android/bin/open-emu`,
            `chmod +x ${dest}/android/bin/open-emu`,
            `chmod +x ${dest}/android/scripts/*.sh 2>/dev/null || true`,
            // The FOSS runtime's entry point needs the same treatment for the same reason, and is
            // caught by neither rule above: the `find` matches on extension and this file has
            // none, and the explicit lines name `bin/open-emu` only. Guarded so syncing a tree
            // from before `android/foss/` existed stays a no-op rather than breaking the chain.
            `if [ -f ${dest}/android/foss/open-emu-foss ]; then ` +
              `sed -i 's/\\r$//' ${dest}/android/foss/open-emu-foss && ` +
              `chmod +x ${dest}/android/foss/open-emu-foss; fi`,
          ].join(' && '),
          onLog,
          180_000,
        );
      },
    },
    {
      id: 'sdk',
      label: 'Android system image',
      blocking: true,
      working: 'Downloading Android. This is the long one — around 4 GB, and it only happens once.',
      /**
       * The emulator binary *and* the system image the selected profile actually needs.
       *
       * Checking only for the emulator was wrong the moment there was more than one profile:
       * switching to the Play guest would sail past this step with no Play image on disk, and fail
       * later inside `avdmanager` with a message about an unavailable package — long after the
       * point where "download Android" was the obvious remedy.
       *
       * The profile's image tag lives in `android/profiles/*.env`, so the distro is asked rather
       * than the mapping being duplicated here.
       */
      check: async () => {
        const probe = await sdkProbe(bridge, target);
        const result = await bridge.run(probe, () => undefined, 20_000);
        const ok = truthy(result);
        if (!ok) {
          // The one check that sends the app off to download 4 GB. If it is wrong, it is wrong
          // expensively, so it says exactly what it ran and what came back.
          console.log(`[setup] sdk probe: ${probe}`);
          console.log(`[setup] sdk probe output: ${JSON.stringify([...result.stdout, ...result.stderr])}`);
        }
        return { pass: ok, detail: ok ? 'Downloaded' : 'Not downloaded yet (about 4 GB)' };
      },
      fix: async (onLog) => {
        // Without the profile this downloads the *default* guest's image, which is the one thing
        // it must not do when the user has chosen Play — they would wait out 4 GB and still not
        // have the image they asked for.
        await bridge.run(
          `cd ${await remote(bridge)} && ${profileEnv(target)} make android-fetch`,
          onLog,
          60 * 60_000,
        );
      },
    },
    {
      id: 'provisioned',
      label: 'Preparing your device',
      blocking: true,
      working: 'Starting Android for the first time and saving a snapshot, so later launches are quick.',
      check: async () => {
        const result = await openEmu.status(() => undefined);
        const ok = result.stdout.some((l) => l.startsWith('provisioned_at='));
        return { pass: ok, detail: ok ? 'Ready' : 'Not prepared yet' };
      },
      fix: async (onLog) => {
        const env = profileEnv(target);
        const dir = await remote(bridge);
        await bridge.run(`cd ${dir} && ${env} make android-setup`, onLog, 10 * 60_000);
        await bridge.run(`cd ${dir} && ${env} make android-provision`, onLog, 40 * 60_000);
      },
    },
  ];
}

export class SetupRunner {
  constructor(private readonly steps: Step[]) {}

  list(): SetupStepStatus[] {
    return this.steps.map((s) => ({ id: s.id, label: s.label, status: 'pending', detail: '', blocking: s.blocking }));
  }

  async runAll(emit: (status: SetupStepStatus) => void): Promise<SetupStepStatus[]> {
    const results: SetupStepStatus[] = [];
    for (const step of this.steps) {
      emit({ id: step.id, label: step.label, status: 'running', detail: '', blocking: step.blocking });
      const status = await this.runCheck(step);
      emit(status);
      results.push(status);
    }
    return results;
  }

  /**
   * Checks every step and repairs what it can, without being asked.
   *
   * This is the first-run path. The older `runAll` + per-step "Fix" button flow was a developer's
   * doctor console: it told someone their AVD was not provisioned and left them to press the
   * right buttons in the right order. Every step here already knew how to fix itself — nothing
   * was calling them.
   *
   * A failing blocking step stops the run rather than letting the rest fail after it. Everything
   * downstream depends on it, and a cascade of six red rows buries the one cause worth reading.
   */
  async runAuto(emit: (status: SetupStepStatus) => void, onLog: LogHandler): Promise<SetupStepStatus[]> {
    const results: SetupStepStatus[] = [];

    for (const step of this.steps) {
      const base = { id: step.id, label: step.label, blocking: step.blocking };
      emit({ ...base, status: 'running', detail: 'Checking…' });

      let status = await this.runCheck(step);

      if (status.status === 'fail' && step.fix) {
        emit({ ...base, status: 'running', detail: step.working ?? 'Working…' });
        try {
          await step.fix(onLog);
          status = await this.runCheck(step);
        } catch (err) {
          status = { ...base, status: 'fail', detail: (err as Error).message };
        }
      }

      emit(status);
      results.push(status);
      if (status.status === 'fail' && step.blocking) break;
    }

    return results;
  }

  async runFix(id: string, onLog: LogHandler, emit: (status: SetupStepStatus) => void): Promise<SetupStepStatus> {
    const step = this.steps.find((s) => s.id === id);
    if (!step) throw new Error(`unknown setup step: ${id}`);
    if (!step.fix) throw new Error(`step "${id}" has no automated fix`);

    emit({ id: step.id, label: step.label, status: 'running', detail: 'applying fix…', blocking: step.blocking });
    try {
      await step.fix(onLog);
    } catch (err) {
      const status: SetupStepStatus = {
        id: step.id,
        label: step.label,
        status: 'fail',
        detail: (err as Error).message,
        blocking: step.blocking,
      };
      emit(status);
      return status;
    }
    const status = await this.runCheck(step);
    emit(status);
    return status;
  }

  private async runCheck(step: Step): Promise<SetupStepStatus> {
    try {
      const { pass, warn, detail } = await step.check();
      return {
        id: step.id,
        label: step.label,
        status: pass ? 'pass' : warn ? 'warn' : 'fail',
        detail,
        blocking: step.blocking,
      };
    } catch (err) {
      return { id: step.id, label: step.label, status: 'fail', detail: (err as Error).message, blocking: step.blocking };
    }
  }
}
