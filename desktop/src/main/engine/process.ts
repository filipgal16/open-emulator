import { ChildProcess, spawn } from 'child_process';
import { decodeWindowsProcessOutput } from '../platform/windows-text';
import type { EngineLogHandler } from './types';
import type { CommandResult, LogStream } from '../../shared/ipc-types';

export interface RunOptions {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onLog?: EngineLogHandler;
}

const NO_LOG: EngineLogHandler = () => undefined;

/**
 * Splits a byte stream into whole lines, holding a partial line until the rest arrives.
 *
 * `flush()` must be called when the stream ends. A program's last line frequently has no trailing
 * newline, and without the flush that line vanishes — which is the worst possible failure for a
 * log, because the last thing a process says before dying is usually the reason it died.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer): void;
  flush(): void;
} {
  let pending = '';
  const emit = (line: string) => {
    if (line.length > 0) onLine(line);
  };
  return {
    push(chunk: Buffer) {
      pending += decodeWindowsProcessOutput(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) emit(line);
    },
    flush() {
      const last = pending;
      pending = '';
      emit(last);
    },
  };
}

/**
 * Runs native child processes and streams their output back line by line.
 *
 * This is what replaces `WslBridge` once the runtime is native, and the difference is mostly in
 * what it no longer has to do. There is no `wsl.exe -e` versus `--` distinction to get wrong, no
 * `$HOME` that resolves to nothing, no `~` that cannot be quoted, and no second shell re-parsing
 * the command — arguments are passed as **argv**, so nothing is ever re-split and there is nothing
 * to escape. A whole class of quoting bugs stops being possible.
 *
 * Commands are serialized for the same reason they were before: the runtimes write shared pid and
 * state files and are not safe to drive concurrently against one guest.
 */
export class ProcessRunner {
  private queue: Promise<unknown> = Promise.resolve();

  /** Serialized. Rejections do not poison the queue — later commands still run. */
  run(file: string, options: RunOptions = {}): Promise<CommandResult> {
    const task = this.queue.then(() => this.exec(file, options));
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Bypasses the queue. For reads that must answer while a long command holds it. */
  runUnqueued(file: string, options: RunOptions = {}): Promise<CommandResult> {
    return this.exec(file, options);
  }

  private exec(file: string, options: RunOptions): Promise<CommandResult> {
    const { args = [], cwd, env = process.env, timeoutMs = 30_000, onLog = NO_LOG } = options;

    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd, env, windowsHide: true });

      const stdout: string[] = [];
      const stderr: string[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`command timed out after ${timeoutMs}ms: ${file} ${args.join(' ')}`));
      }, timeoutMs);

      const collect = (stream: LogStream, sink: string[]) =>
        createLineSplitter((line) => {
          sink.push(line);
          onLog(stream, line);
        });

      const out = collect('stdout', stdout);
      const err = collect('stderr', stderr);
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));

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
        out.flush();
        err.flush();
        resolve({ code, signal, stdout, stderr });
      });
    });
  }
}

export interface DetachedProcess {
  pid: number | null;
  child: ChildProcess;
}

/**
 * Starts a process that outlives the call — the emulator itself.
 *
 * The WSL runtime needed `setsid` here, and the reason it needed it is worth recording because it
 * is exactly what goes away: WSL tears down a session's processes when the `wsl.exe` that created
 * it exits, so an emulator started by a one-shot call was killed a second after it finished
 * booting. A native child has no such session to be torn out of. It is owned by this process and
 * dies when we say so, which is the behaviour we wanted all along.
 *
 * `detached: false` is therefore deliberate: the emulator *should* go away if the app is killed,
 * rather than being left orphaned holding the AVD's lock files.
 */
export function spawnDetached(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onLog?: EngineLogHandler } = {},
): DetachedProcess {
  const { cwd, env = process.env, onLog = NO_LOG } = options;

  const child = spawn(file, args, {
    cwd,
    env,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = createLineSplitter((line) => onLog('stdout', line));
  const err = createLineSplitter((line) => onLog('stderr', line));
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

  // Flushed on exit for the reason that matters most here: when the emulator dies, its final
  // message is the one worth reading, and it is exactly the one most likely to arrive without a
  // trailing newline.
  child.on('close', () => {
    out.flush();
    err.flush();
  });

  // Without a listener, an EPIPE or spawn failure on a detached child is an unhandled 'error'
  // event, which takes the whole main process down.
  child.on('error', (error) => onLog('stderr', `[spawn] ${error.message}`));

  return { pid: child.pid ?? null, child };
}
