import { spawn } from 'child_process';
import { decodeWindowsProcessOutput } from './windows-text';
import type { CommandResult, LogStream } from '../shared/ipc-types';

export type LogHandler = (stream: LogStream, line: string) => void;

/**
 * Mutable, shared by reference between WslBridge, ScreenMirror, and the setup wizard's step
 * definitions. The distro name isn't known for certain until the setup wizard resolves it
 * (it may adopt an existing distro under a different name than the configured default), so
 * nothing downstream may capture a frozen copy of `distro` at construction time.
 */
export interface WslTarget {
  /** Name of the WSL2 distro hosting the open-emulator checkout. */
  distro: string;
  /** Path to the synced repo checkout inside the distro, e.g. "~/open-emulator". */
  remotePath: string;
}

/**
 * Runs commands inside a WSL2 distro via `wsl.exe`, streaming stdout/stderr back line by line.
 * Commands are serialized: open-emu writes shared PID/state files under android/state/ and
 * is not safe to invoke concurrently against the same AVD.
 */
export class WslBridge {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly target: WslTarget) {}

  run(command: string, onLog: LogHandler, timeoutMs = 30_000): Promise<CommandResult> {
    const task = this.queue.then(() => this.exec(command, onLog, timeoutMs));
    // Keep the queue alive even if this command rejects, so later commands still run.
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Convenience wrapper for `android/bin/open-emu <args>`, run from the synced repo checkout. */
  runOpenEmu(args: string, onLog: LogHandler, timeoutMs?: number): Promise<CommandResult> {
    const cmd = `cd '${this.target.remotePath}' && ANDROID_HEADLESS=1 ./android/bin/open-emu ${args}`;
    return this.run(cmd, onLog, timeoutMs);
  }

  private exec(command: string, onLog: LogHandler, timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('wsl.exe', ['-d', this.target.distro, '--', 'bash', '-lc', command], {
        windowsHide: true,
      });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      const forward = (stream: LogStream, sink: string[]) => (chunk: Buffer) => {
        const text = decodeWindowsProcessOutput(chunk);
        for (const line of text.split(/\r?\n/)) {
          if (line.length === 0) continue;
          sink.push(line);
          onLog(stream, line);
        }
      };

      child.stdout.on('data', forward('stdout', stdoutLines));
      child.stderr.on('data', forward('stderr', stderrLines));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout: stdoutLines, stderr: stderrLines });
      });
    });
  }
}
