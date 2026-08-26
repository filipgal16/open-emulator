import type { CommandResult, LogStream } from '../../shared/ipc-types';

/**
 * Which runtime is driving the guest.
 *
 *   wsl   Google's SDK emulator inside a WSL2 distro, driven by the `open-emu` shell script.
 *         The original arrangement, and the one being replaced.
 *   sdk   Google's SDK emulator as a native Windows process (`emulator.exe`, `adb.exe`).
 *   qemu  Stock QEMU running Android-x86, natively. The licence-clean runtime.
 */
export type EngineId = 'wsl' | 'sdk' | 'qemu';

export type EngineLogHandler = (stream: LogStream, line: string) => void;

export interface StartOptions {
  /**
   * Boot from scratch rather than restoring a snapshot. Deliberate cold boots discard the
   * snapshot; a cold boot used as a *fallback* after a failed restore must not, or one bad
   * restore turns into a mandatory re-provision.
   */
  cold?: boolean;
}

/**
 * Everything the shell needs from an Android runtime.
 *
 * The point of this interface is that nothing above it knows which runtime is running. `store/`,
 * `account/`, and `app-library.ts` reach the guest exclusively through `OpenEmuClient`, which is a
 * typed façade over this — so swapping WSL for a native Windows process, or Google's emulator for
 * QEMU, touches only the implementations here.
 *
 * Commands are expected to be serialized per engine: the runtimes write shared pid and state files
 * and are not safe to drive concurrently against one guest.
 */
export interface AndroidEngine {
  readonly id: EngineId;

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────────
  start(onLog: EngineLogHandler, options?: StartOptions): Promise<CommandResult>;
  stop(onLog: EngineLogHandler): Promise<CommandResult>;
  /** `key=value` lines; `device-status.ts#parseStatus` is deliberately tolerant of missing ones. */
  status(onLog: EngineLogHandler): Promise<CommandResult>;
  /** First boot, guest tuning, then a snapshot so later starts are quick. Safe to re-run. */
  provision(onLog: EngineLogHandler): Promise<CommandResult>;
  doctor(onLog: EngineLogHandler): Promise<CommandResult>;

  // ── Guest access ─────────────────────────────────────────────────────────────────────────────
  /**
   * `adb shell <command>`. The caller is responsible for quoting its own arguments — see
   * `guestShellArg` in shell-quote.ts for why that needs care.
   */
  shell(command: string, onLog: EngineLogHandler, timeoutMs?: number): Promise<CommandResult>;

  /**
   * Quotes one argument so it reaches the guest's `sh` as a literal value.
   *
   * This belongs to the engine because the answer depends on **how many shells** sit between this
   * process and the guest, and the two runtimes differ:
   *
   *   wsl   `wsl.exe -e bash -lc "…"` → bash splits it → `adb shell …` → the guest's sh. Two
   *         shells, so a value has to be quoted twice or the first one eats the quotes.
   *   sdk   `adb.exe shell …` with argv passed directly → the guest's sh. One shell, so quoting
   *         twice leaves the outer quotes *in the value*.
   *
   * Getting this wrong is silent and ugly: a password typed into Google's sign-in page arrives as
   * `'P@ss w0rd!'`, quotes included, and the login simply fails.
   */
  quoteGuestArg(value: string): string;

  /**
   * Types a string into the guest's focused field without putting it on a command line.
   *
   * Semantic rather than a `shell()` call with an escaping convention attached, because the two
   * runtimes hide the value differently: the WSL engine passes it through `WSLENV`, and a native
   * engine hands it to `adb.exe` as an argv entry. Either way it stays out of the command string
   * that every process listing on the machine can read.
   */
  typeSecret(value: string, onLog: EngineLogHandler, timeoutMs?: number): Promise<CommandResult>;

  /**
   * Installs an APK from a path **on the Windows filesystem**.
   *
   * Taking a Windows path rather than an engine-specific one is what lets `store/installer.ts` stay
   * runtime-agnostic: translating to a `/mnt/c/...` passthrough is the WSL engine's problem, and
   * a native engine has nothing to translate.
   */
  installApk(hostPath: string, onLog: EngineLogHandler, timeoutMs?: number): Promise<CommandResult>;

  // ── Presentation ─────────────────────────────────────────────────────────────────────────────
  /**
   * The process whose window shows the guest, or null when this engine has no window and the
   * screen has to be mirrored frame by frame instead.
   *
   * A **pid** rather than an `HWND` for two reasons. An `HWND` from koffi is an opaque pointer that
   * does not survive being typed as a number; and finding the window is presentation work that
   * belongs in the main process next to the `BrowserWindow`, not in a runtime. The engine knows
   * which process it started — turning that into a window is `GuestWindow`'s job.
   *
   * Null for the WSL engine, which runs the emulator headless inside the distro. That null is what
   * selects the mirror fallback, so it is a supported answer rather than a failure.
   */
  displayPid(): Promise<number | null>;

  /**
   * One PNG of the guest's screen, or undefined when this engine cannot capture cheaply.
   *
   * Optional because the two runtimes differ in kind here. A native engine can call
   * `adb exec-out screencap` directly and hand back the bytes. The WSL engine has to keep a
   * long-lived shell loop inside the distro, because paying for a `wsl.exe` round trip per frame
   * cannot reach even a few frames a second — so it mirrors through `ScreenMirror` instead, and
   * leaves this undefined.
   */
  screencap?(): Promise<Buffer>;

  /** Which guest profile later commands should drive, or null to let the runtime pick. */
  setProfile(profile: string | null): void;
}
