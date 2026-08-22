import { spawn } from 'child_process';
import { posixQuote } from './shell-quote';
import { decodeWindowsProcessOutput } from './windows-text';
import type { CommandResult, LogStream } from '../shared/ipc-types';

export type LogHandler = (stream: LogStream, line: string) => void;

/**
 * Resolves a leading `~` against a known home directory.
 *
 * Neither of the obvious shortcuts works here, and both fail *silently*:
 *
 *   `cd '~/open-emulator'`      Single quotes switch off tilde expansion, so bash looks for a
 *                               directory literally named `~`. Paired with `mkdir -p` it creates
 *                               one, relative to whatever working directory the process inherited.
 *                               A packaged build did this — it made `…/win-unpacked/~/open-emulator`
 *                               beside the installed app and began re-downloading the Android SDK
 *                               into it.
 *   `cd "$HOME/open-emulator"`  `$HOME` is empty in the login shell WSL spawns for us. `cd ""`
 *                               returns success and does not move, so every command afterwards
 *                               ran in the app's own directory while reporting no error at all.
 *
 * So the home directory is looked up out of band and substituted here, and the result is an
 * ordinary absolute path that can be single-quoted like anything else.
 */
export function expandHome(remotePath: string, home: string): string {
  const base = home.replace(/\/+$/, '');
  if (remotePath === '~') return base;
  if (remotePath.startsWith('~/')) return `${base}/${remotePath.slice(2)}`;
  return remotePath;
}

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
  /**
   * Guest profile from `android/profiles/` — `fast`, `full`, or `play`. Null lets open-emu pick
   * its own default.
   *
   * This has to be forwarded on every call, not set once: each `open-emu` invocation is a fresh
   * process, and the profile decides the AVD name, the system image, and therefore which snapshot
   * gets loaded. Without it the shell would always drive the default profile no matter which one
   * the user provisioned — so a provisioned Play guest would sit there unused.
   */
  profile: string | null;
}

/**
 * Runs commands inside a WSL2 distro via `wsl.exe`, streaming stdout/stderr back line by line.
 * Commands are serialized: open-emu writes shared PID/state files under android/state/ and
 * is not safe to invoke concurrently against the same AVD.
 */
export class WslBridge {
  private queue: Promise<unknown> = Promise.resolve();
  private remoteDirKey: string | null = null;
  private remoteDirValue: Promise<string> | null = null;

  constructor(private readonly target: WslTarget) {}

  run(command: string, onLog: LogHandler, timeoutMs = 30_000): Promise<CommandResult> {
    const task = this.queue.then(() => this.exec(command, onLog, timeoutMs));
    // Keep the queue alive even if this command rejects, so later commands still run.
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * The checkout's absolute path inside the distro, with `~` already resolved.
   *
   * Cached per distro+path, because it costs a `wsl.exe` round trip and is asked for by every
   * command. Public because the setup steps build their own commands against the same directory.
   */
  async remoteDir(): Promise<string> {
    const key = `${this.target.distro}|${this.target.remotePath}`;
    if (this.remoteDirKey !== key) {
      this.remoteDirKey = key;
      this.remoteDirValue = this.resolveRemoteDir();
    }
    return this.remoteDirValue as Promise<string>;
  }

  /** Single-quoted absolute path, ready to drop into a command. */
  async quotedRemoteDir(): Promise<string> {
    return posixQuote(await this.remoteDir());
  }

  private async resolveRemoteDir(): Promise<string> {
    if (!this.target.remotePath.startsWith('~')) return this.target.remotePath;
    // The passwd database rather than $HOME: the environment cannot be trusted here, and getting
    // this wrong is silent (see `expandHome`).
    try {
      const result = await this.exec(`getent passwd "$(id -u)" | cut -d: -f6`, () => undefined, 20_000);
      const home = result.stdout.map((line) => line.trim()).find((line) => line.startsWith('/'));
      if (home) return expandHome(this.target.remotePath, home);
    } catch {
      // Fall through to the default below.
    }
    // wsl.exe's default user on a fresh install is root, and that is where our installer syncs to.
    return expandHome(this.target.remotePath, '/root');
  }

  /** Convenience wrapper for `android/bin/open-emu <args>`, run from the synced repo checkout. */
  async runOpenEmu(args: string, onLog: LogHandler, timeoutMs?: number): Promise<CommandResult> {
    return this.run(await this.openEmuCommand(args), onLog, timeoutMs);
  }

  private async openEmuCommand(args: string): Promise<string> {
    // Profile names come from a fixed set of filenames in android/profiles/, never from user
    // input, but this is interpolated into a shell command — so it is validated anyway.
    const profile = this.target.profile && /^[a-z0-9_-]{1,32}$/.test(this.target.profile) ? this.target.profile : null;
    const env = ['ANDROID_HEADLESS=1', profile ? `ANDROID_PROFILE=${profile}` : ''].filter(Boolean).join(' ');
    return `cd ${await this.quotedRemoteDir()} && ${env} ./android/bin/open-emu ${args}`;
  }

  /**
   * Same as `runOpenEmu`, but with values handed over as environment variables for the command to
   * reference as `$NAME`.
   *
   * This exists for one reason: a secret embedded in the command string would sit in `wsl.exe`'s
   * command line, which every process listing on the machine can read. An environment variable is
   * not secret either, but it is not on display — and it is the difference between a stored Google
   * password being casually visible and not.
   *
   * WSL does not forward the Windows environment by default; `WSLENV` is what carries a named
   * variable across the boundary.
   */
  async runOpenEmuWithEnv(
    args: string,
    env: Record<string, string>,
    onLog: LogHandler,
    timeoutMs?: number,
  ): Promise<CommandResult> {
    const cmd = await this.openEmuCommand(args);
    const names = Object.keys(env);
    const wslenv = [process.env.WSLENV, ...names].filter(Boolean).join(':');
    const task = this.queue.then(() =>
      this.exec(cmd, onLog, timeoutMs ?? 30_000, { ...process.env, ...env, WSLENV: wslenv }),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * Runs a command as root inside the distro.
   *
   * Used for the one thing that genuinely needs it: installing the packages the Android SDK
   * depends on. `wsl -u root` is the only unattended way in — a fresh Ubuntu puts the default user
   * in the sudo group but still prompts for a password, and there is nobody at the keyboard during
   * first-run setup.
   */
  runAsRoot(command: string, onLog: LogHandler, timeoutMs = 30_000): Promise<CommandResult> {
    const task = this.queue.then(() => this.exec(command, onLog, timeoutMs, process.env, 'root'));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private exec(
    command: string,
    onLog: LogHandler,
    timeoutMs: number,
    env: NodeJS.ProcessEnv = process.env,
    user?: string,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      /**
       * `-e`, not `--`.
       *
       * With `--`, wsl.exe performs its own `$VAR` substitution over the command line before the
       * distro ever sees it, against *its* environment. Any shell variable we write is replaced
       * with nothing — even inside single quotes:
       *
       *     wsl -d Ubuntu -- bash -lc 'x=abc; echo "[$x]"'   ->  []
       *     wsl -d Ubuntu -e bash -lc 'x=abc; echo "[$x]"'   ->  [abc]
       *
       * Command substitution `$(…)` survives either way, which is what made this so slow to spot:
       * most commands here worked, and the ones using a variable failed quietly with an empty
       * value rather than an error. It emptied `$tmp`/`$sz` in the screen-mirror loop and `$tag`
       * in the SDK check, which then reported a complete 4 GB SDK as missing.
       */
      const args = ['-d', this.target.distro, ...(user ? ['-u', user] : []), '-e', 'bash', '-lc', command];
      const child = spawn('wsl.exe', args, {
        windowsHide: true,
        env,
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
