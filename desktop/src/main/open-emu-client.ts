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
    return this.bridge.runOpenEmu(`shell input tap ${x} ${y}`, onLog, 10_000);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number, onLog: LogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, onLog, 10_000);
  }

  key(keycode: string, onLog: LogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`shell input keyevent ${keycode}`, onLog, 10_000);
  }

  /** Generic `adb shell` passthrough. Callers are responsible for quoting their own arguments. */
  shell(command: string, onLog: LogHandler, timeoutMs = 15_000): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`shell ${command}`, onLog, timeoutMs);
  }
}
