import { isTypeableText, keyCommand, swipeCommand, tapCommand, textCommand } from './guest-input';
import { guestShellArg, posixQuote } from './shell-quote';
import { LogHandler, WslBridge } from './wsl-bridge';
import type { CommandResult } from '../shared/ipc-types';

/**
 * Thin typed wrapper over the `open-emu` CLI surface. Input forwarding (tap/swipe/key) reuses
 * the existing `shell` passthrough subcommand rather than adding new CLI surface — `open-emu
 * shell input tap x y` already works today.
 */
export class OpenEmuClient {
  constructor(private readonly bridge: WslBridge) {}

  status(onLog: LogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu('status', onLog, 15_000);
  }

  doctor(onLog: LogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu('doctor', onLog, 60_000);
  }

  start(onLog: LogHandler, cold = false): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`start${cold ? ' --cold' : ''}`, onLog, 20 * 60_000);
  }

  stop(onLog: LogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu('stop', onLog, 30_000);
  }

  tap(x: number, y: number, onLog: LogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`shell ${tapCommand(x, y)}`, onLog, 10_000);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number, onLog: LogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`shell ${swipeCommand(x1, y1, x2, y2, durationMs)}`, onLog, 10_000);
  }

  /** Resolves false without touching the guest when the keycode isn't one we recognise. */
  async key(keycode: string, onLog: LogHandler): Promise<boolean> {
    const command = keyCommand(keycode);
    if (!command) return false;
    const result = await this.bridge.runOpenEmu(`shell ${command}`, onLog, 10_000);
    return result.code === 0;
  }

  /** Types into whatever the guest currently has focused. False for text `input` can't send. */
  async text(value: string, onLog: LogHandler): Promise<boolean> {
    const command = textCommand(value);
    if (!command) return false;
    const result = await this.bridge.runOpenEmu(`shell ${command}`, onLog, 20_000);
    return result.code === 0;
  }

  /**
   * Types a secret without putting it in a command line.
   *
   * The value is escaped for the guest's `sh` here on the host, then handed to bash as an
   * environment variable and re-quoted by the `"'…'"` around the expansion. Bash does not re-expand
   * the contents of a variable, so `$`, backticks, and quotes inside a password stay literal at
   * both shell layers. See `WslBridge.runOpenEmuWithEnv` for why this isn't just interpolated.
   */
  async textSecret(value: string, onLog: LogHandler): Promise<boolean> {
    if (!isTypeableText(value)) return false;
    const escaped = value.replace(/'/g, "'\\''");
    const result = await this.bridge.runOpenEmuWithEnv(
      `shell input text "'$OE_INPUT_TEXT'"`,
      { OE_INPUT_TEXT: escaped },
      onLog,
      20_000,
    );
    return result.code === 0;
  }

  /** Opens the guest's own "add a Google account" flow. Nothing is automated past this point. */
  async startAddGoogleAccount(onLog: LogHandler): Promise<boolean> {
    const result = await this.bridge.runOpenEmu(
      'shell am start -a android.settings.ADD_ACCOUNT_SETTINGS --esa account_types com.google',
      onLog,
      30_000,
    );
    return result.code === 0;
  }

  install(apkPath: string, onLog: LogHandler, timeoutMs = 10 * 60_000): Promise<CommandResult> {
    // Single-quoted, not double: `open-emu install` takes this as argv and uses it as a path
    // directly, so it is parsed by bash here and by nothing afterwards.
    return this.bridge.runOpenEmu(`install ${posixQuote(apkPath)}`, onLog, timeoutMs);
  }

  /** Fires a VIEW intent — how the Play client is driven (`market://search?q=…`). */
  async viewIntent(uri: string, onLog: LogHandler): Promise<boolean> {
    const result = await this.bridge.runOpenEmu(
      `shell am start -a android.intent.action.VIEW -d ${guestShellArg(uri)}`,
      onLog,
      30_000,
    );
    return result.code === 0;
  }

  /** A single system property, or null when the guest doesn't answer. */
  async getprop(name: string, onLog: LogHandler): Promise<string | null> {
    if (!/^[a-zA-Z0-9._]{1,64}$/.test(name)) return null;
    const result = await this.bridge.runOpenEmu(`shell getprop ${name}`, onLog, 15_000);
    if (result.code !== 0) return null;
    return result.stdout.map((line) => line.trim()).find((line) => line.length > 0) ?? null;
  }

  /** Generic `adb shell` passthrough. Callers are responsible for quoting their own arguments. */
  shell(command: string, onLog: LogHandler, timeoutMs = 15_000): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`shell ${command}`, onLog, timeoutMs);
  }
}
