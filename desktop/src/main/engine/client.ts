import type { AndroidEngine, EngineLogHandler } from './types';
import { isTypeableText, keyCommand, swipeCommand, tapCommand, textCommand } from '../guest/input';
import type { CommandResult } from '../../shared/ipc-types';

/**
 * Typed façade over whichever `AndroidEngine` is driving the guest.
 *
 * Everything above this line — the store, the account, the app library, the IPC handlers — talks
 * to this class and never to an engine directly, which is what makes the runtime swappable. Input
 * forwarding reuses the engine's `adb shell` passthrough rather than adding engine surface for it:
 * `shell input tap x y` is the same command whichever process is carrying it.
 */
export class OpenEmuClient {
  constructor(private readonly engine: AndroidEngine) {}

  /** Which runtime is actually driving the guest, for logging and for the settings UI. */
  get engineId(): AndroidEngine['id'] {
    return this.engine.id;
  }

  setProfile(profile: string | null): void {
    this.engine.setProfile(profile);
  }

  status(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.engine.status(onLog);
  }

  doctor(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.engine.doctor(onLog);
  }

  start(onLog: EngineLogHandler, cold = false): Promise<CommandResult> {
    return this.engine.start(onLog, { cold });
  }

  stop(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.engine.stop(onLog);
  }

  provision(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.engine.provision(onLog);
  }

  /** The guest's own window, as an HWND, or null when the screen has to be mirrored instead. */
  displayPid(): Promise<number | null> {
    return this.engine.displayPid();
  }

  tap(x: number, y: number, onLog: EngineLogHandler): Promise<CommandResult> {
    return this.engine.shell(tapCommand(x, y), onLog, 10_000);
  }

  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
    onLog: EngineLogHandler,
  ): Promise<CommandResult> {
    return this.engine.shell(swipeCommand(x1, y1, x2, y2, durationMs), onLog, 10_000);
  }

  /** Resolves false without touching the guest when the keycode isn't one we recognise. */
  async key(keycode: string, onLog: EngineLogHandler): Promise<boolean> {
    const command = keyCommand(keycode);
    if (!command) return false;
    const result = await this.engine.shell(command, onLog, 10_000);
    return result.code === 0;
  }

  /** Types into whatever the guest currently has focused. False for text `input` can't send. */
  async text(value: string, onLog: EngineLogHandler): Promise<boolean> {
    const command = textCommand(value, (text) => this.engine.quoteGuestArg(text));
    if (!command) return false;
    const result = await this.engine.shell(command, onLog, 20_000);
    return result.code === 0;
  }

  /**
   * Types a secret without putting it on a command line.
   *
   * The engine decides how to hide it — see `AndroidEngine.typeSecret`. Validated here rather than
   * there so every engine inherits the same refusal: `input` speaks printable ASCII only, and a
   * silently mangled password is worse than an obvious "no".
   */
  async textSecret(value: string, onLog: EngineLogHandler): Promise<boolean> {
    if (!isTypeableText(value)) return false;
    const result = await this.engine.typeSecret(value, onLog);
    return result.code === 0;
  }

  /** Opens the guest's own "add a Google account" flow. Nothing is automated past this point. */
  async startAddGoogleAccount(onLog: EngineLogHandler): Promise<boolean> {
    const result = await this.engine.shell(
      'am start -a android.settings.ADD_ACCOUNT_SETTINGS --esa account_types com.google',
      onLog,
      30_000,
    );
    return result.code === 0;
  }

  /** Takes a path on the **Windows** filesystem; the engine translates if it has to. */
  install(apkPath: string, onLog: EngineLogHandler, timeoutMs = 10 * 60_000): Promise<CommandResult> {
    return this.engine.installApk(apkPath, onLog, timeoutMs);
  }

  /** Fires a VIEW intent — how the Play client is driven (`market://search?q=…`). */
  async viewIntent(uri: string, onLog: EngineLogHandler): Promise<boolean> {
    const result = await this.engine.shell(
      `am start -a android.intent.action.VIEW -d ${this.engine.quoteGuestArg(uri)}`,
      onLog,
      30_000,
    );
    return result.code === 0;
  }

  /** A single system property, or null when the guest doesn't answer. */
  async getprop(name: string, onLog: EngineLogHandler): Promise<string | null> {
    if (!/^[a-zA-Z0-9._]{1,64}$/.test(name)) return null;
    const result = await this.engine.shell(`getprop ${name}`, onLog, 15_000);
    if (result.code !== 0) return null;
    return result.stdout.map((line) => line.trim()).find((line) => line.length > 0) ?? null;
  }

  /** Generic `adb shell` passthrough. Callers are responsible for quoting their own arguments. */
  shell(command: string, onLog: EngineLogHandler, timeoutMs = 15_000): Promise<CommandResult> {
    return this.engine.shell(command, onLog, timeoutMs);
  }
}
