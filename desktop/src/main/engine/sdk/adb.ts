import { spawn } from 'child_process';
import type { ProcessRunner } from '../process';
import type { EngineLogHandler } from '../types';
import type { CommandResult } from '../../../shared/ipc-types';

const NO_LOG: EngineLogHandler = () => undefined;

/**
 * Parses `adb devices` output into the serials that are actually usable.
 *
 * Only `device` counts. A serial listed as `offline`, `unauthorized`, or `bootloader` will accept a
 * connection and then fail every command against it, which reads as the guest being broken rather
 * than not ready yet.
 */
export function parseDevices(stdout: string[]): string[] {
  const serials: string[] = [];
  for (const raw of stdout) {
    const line = raw.trim();
    if (line.length === 0 || /^List of devices/i.test(line)) continue;
    const [serial, state] = line.split(/\s+/);
    if (serial && state === 'device') serials.push(serial);
  }
  return serials;
}

/** True when the guest has finished booting *and* its package manager will answer. */
export function isBootComplete(bootCompleted: string | null, packageManagerOk: boolean): boolean {
  return bootCompleted?.trim() === '1' && packageManagerOk;
}

export class Adb {
  constructor(
    private readonly binary: string,
    private readonly runner: ProcessRunner,
  ) {}

  /** `adb start-server`, so the first real command isn't the one that pays for the daemon. */
  async startServer(onLog: EngineLogHandler = NO_LOG): Promise<void> {
    await this.runner.run(this.binary, { args: ['start-server'], onLog, timeoutMs: 30_000 }).catch(() => undefined);
  }

  async devices(): Promise<string[]> {
    const result = await this.runner.runUnqueued(this.binary, { args: ['devices'], timeoutMs: 15_000 });
    return parseDevices(result.stdout);
  }

  /**
   * Raw `adb -s <serial> …`, with the serial as its own argv entry.
   *
   * Everything past `shell` is handed to the guest's `sh`, so a caller passing user text still has
   * to quote for *that* shell — see `guestShellArg`. What it no longer has to do is quote for a
   * host shell as well, because there isn't one.
   */
  exec(serial: string, args: string[], onLog: EngineLogHandler = NO_LOG, timeoutMs = 15_000): Promise<CommandResult> {
    return this.runner.run(this.binary, { args: ['-s', serial, ...args], onLog, timeoutMs });
  }

  shell(serial: string, command: string, onLog: EngineLogHandler = NO_LOG, timeoutMs = 15_000): Promise<CommandResult> {
    return this.exec(serial, ['shell', command], onLog, timeoutMs);
  }

  /** A single property, or null when the guest doesn't answer. */
  async getprop(serial: string, name: string): Promise<string | null> {
    const result = await this.runner
      .runUnqueued(this.binary, { args: ['-s', serial, 'shell', 'getprop', name], timeoutMs: 15_000 })
      .catch(() => null);
    if (!result || result.code !== 0) return null;
    const value = result.stdout.map((line) => line.trim()).find((line) => line.length > 0);
    return value ?? null;
  }

  /**
   * Captures a PNG straight from the guest.
   *
   * Spawned directly rather than through `ProcessRunner` because this output is **binary**. The
   * runner decodes to text and splits on newlines, which would corrupt a PNG in two distinct ways:
   * a `0x0a` byte inside the image data is not a line break, and the UTF-8 decode mangles anything
   * that is not valid text.
   *
   * `exec-out` rather than `shell` for the same class of reason — `adb shell` translates `\n` to
   * `\r\n` on some transports, which quietly corrupts every capture.
   */
  screencap(serial: string, timeoutMs = 20_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['-s', serial, 'exec-out', 'screencap', '-p'], { windowsHide: true });
      const chunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('screencap timed out'));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /** Waits for a serial to reach the `device` state. Resolves null on timeout, never throws. */
  async waitForDevice(timeoutMs: number, pollMs = 1_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    await this.startServer();
    while (Date.now() < deadline) {
      const serials = await this.devices().catch(() => []);
      if (serials.length > 0) return serials[0];
      await delay(pollMs);
    }
    return null;
  }

  /**
   * Waits for `sys.boot_completed=1` *and* a package manager that answers.
   *
   * The property alone is not enough: it flips before `pm` is ready, so an install fired the
   * moment it goes high fails with a package manager that is not up yet.
   */
  async waitForBoot(serial: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const booted = await this.getprop(serial, 'sys.boot_completed');
      if (booted?.trim() === '1') {
        const pm = await this.runner
          .runUnqueued(this.binary, { args: ['-s', serial, 'shell', 'pm', 'path', 'android'], timeoutMs: 15_000 })
          .catch(() => null);
        if (pm && pm.code === 0) return true;
      }
      await delay(pollMs);
    }
    return false;
  }

  /** Asks the emulator to shut itself down cleanly, so pending qcow2 writes are flushed. */
  async emuKill(serial: string, onLog: EngineLogHandler = NO_LOG): Promise<void> {
    await this.exec(serial, ['emu', 'kill'], onLog, 30_000).catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
