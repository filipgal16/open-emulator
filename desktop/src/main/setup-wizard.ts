import { LogHandler, WslBridge, WslTarget } from './wsl-bridge';
import { OpenEmuClient } from './open-emu-client';
import { installDistro, isWslAvailable, listDistros, setDistroVersion2 } from './wsl-detect';
import { repoRootWinPath, toWslMountPath } from './win-paths';
import type { SetupStepStatus } from '../shared/ipc-types';

interface CheckResult {
  pass: boolean;
  warn?: boolean;
  detail: string;
}

interface Step {
  id: string;
  label: string;
  blocking: boolean;
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
      label: 'WSL2 installed',
      blocking: true,
      check: async () => {
        const ok = await isWslAvailable();
        return { pass: ok, detail: ok ? 'wsl.exe responds' : 'wsl.exe not found or not responding' };
      },
      fix: async () => {
        await installDistro();
      },
    },
    {
      id: 'distro',
      label: 'WSL2 distro ready',
      blocking: true,
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
        return { pass: false, detail: 'no usable distro found' };
      },
      fix: async () => {
        const distros = await listDistros();
        const ubuntu1 = distros.find((d) => /ubuntu/i.test(d.name) && d.version !== '2');
        if (ubuntu1) {
          await setDistroVersion2(ubuntu1.name);
          target.distro = ubuntu1.name;
          return;
        }
        await installDistro('Ubuntu-22.04');
        target.distro = 'Ubuntu-22.04';
      },
    },
    {
      id: 'kvm',
      label: 'KVM nested virtualization',
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
      label: 'Backend synced into distro',
      blocking: true,
      check: async () => {
        const result = await bridge.run(
          `test -x '${target.remotePath}/android/bin/open-emu' && echo yes || echo no`,
          () => undefined,
          10_000,
        );
        const ok = truthy(result);
        return { pass: ok, detail: ok ? `${target.remotePath} present` : `${target.remotePath} missing or incomplete` };
      },
      fix: async (onLog) => {
        const src = toWslMountPath(repoRootWinPath());
        await bridge.run(`mkdir -p '${target.remotePath}' && cp -r '${src}/.' '${target.remotePath}/'`, onLog, 120_000);
      },
    },
    {
      id: 'sdk',
      label: 'Android SDK fetched',
      blocking: true,
      check: async () => {
        const result = await bridge.run(
          `test -x '${target.remotePath}/android/sdk/emulator/emulator' && echo yes || echo no`,
          () => undefined,
          10_000,
        );
        const ok = truthy(result);
        return { pass: ok, detail: ok ? 'SDK + system image present' : 'SDK not fetched yet (~4 GiB download)' };
      },
      fix: async (onLog) => {
        await bridge.run(`cd '${target.remotePath}' && make android-fetch`, onLog, 30 * 60_000);
      },
    },
    {
      id: 'provisioned',
      label: 'AVD provisioned',
      blocking: true,
      check: async () => {
        const result = await openEmu.status(() => undefined);
        const ok = result.stdout.some((l) => l.startsWith('provisioned_at='));
        return { pass: ok, detail: ok ? 'provisioned' : 'not provisioned yet' };
      },
      fix: async (onLog) => {
        await bridge.run(`cd '${target.remotePath}' && make android-setup`, onLog, 5 * 60_000);
        await bridge.run(`cd '${target.remotePath}' && make android-provision`, onLog, 20 * 60_000);
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
