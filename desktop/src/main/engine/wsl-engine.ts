import { posixQuote } from '../shell-quote';
import { toWslMountPath } from '../win-paths';
import type { WslBridge } from '../wsl-bridge';
import type { AndroidEngine, EngineLogHandler, StartOptions } from './types';
import type { CommandResult } from '../../shared/ipc-types';

/**
 * The original runtime: Google's SDK emulator inside a WSL2 distro, driven by `android/bin/open-emu`.
 *
 * This exists to give the pre-native arrangement the same shape as the engines replacing it, so
 * the seam can be introduced without changing any behaviour. It is the reference implementation —
 * every quirk it works around is documented at the point of the workaround in `WslBridge` and in
 * the shell scripts, and the native engines have to answer the same questions differently rather
 * than not at all.
 *
 * Slated for deletion once `SdkEngine` boots a guest.
 */
export class WslEngine implements AndroidEngine {
  readonly id = 'wsl' as const;

  constructor(
    private readonly bridge: WslBridge,
    /**
     * The same mutable object `WslBridge` and `ScreenMirror` hold. Shared by reference on purpose:
     * the distro name is not settled until the setup wizard resolves it, so nothing may capture a
     * frozen copy.
     */
    private readonly target: { profile: string | null },
  ) {}

  setProfile(profile: string | null): void {
    this.target.profile = profile;
  }

  start(onLog: EngineLogHandler, options?: StartOptions): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`start${options?.cold ? ' --cold' : ''}`, onLog, 20 * 60_000);
  }

  stop(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu('stop', onLog, 30_000);
  }

  status(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu('status', onLog, 15_000);
  }

  provision(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu('provision', onLog, 40 * 60_000);
  }

  doctor(onLog: EngineLogHandler): Promise<CommandResult> {
    return this.bridge.runOpenEmu('doctor', onLog, 60_000);
  }

  shell(command: string, onLog: EngineLogHandler, timeoutMs = 15_000): Promise<CommandResult> {
    return this.bridge.runOpenEmu(`shell ${command}`, onLog, timeoutMs);
  }

  /**
   * The value is escaped for the guest's `sh` here, handed to bash as an environment variable, and
   * re-quoted by the `"'…'"` around the expansion. Bash does not re-expand a variable's contents,
   * so `$`, backticks, and quotes inside a password stay literal at both shell layers.
   */
  typeSecret(value: string, onLog: EngineLogHandler, timeoutMs = 20_000): Promise<CommandResult> {
    const escaped = value.replace(/'/g, "'\\''");
    return this.bridge.runOpenEmuWithEnv(
      `shell input text "'$OE_INPUT_TEXT'"`,
      { OE_INPUT_TEXT: escaped },
      onLog,
      timeoutMs,
    );
  }

  /**
   * Windows path in, `/mnt/<drive>/…` passthrough out.
   *
   * Doing the translation here rather than at the call site is what keeps `store/installer.ts`
   * runtime-agnostic — a native engine gets the same Windows path and has nothing to convert.
   */
  installApk(hostPath: string, onLog: EngineLogHandler, timeoutMs = 10 * 60_000): Promise<CommandResult> {
    // Single-quoted, not double: `open-emu install` takes this as argv and uses it as a path
    // directly, so it is parsed by bash here and by nothing afterwards.
    return this.bridge.runOpenEmu(`install ${posixQuote(toWslMountPath(hostPath))}`, onLog, timeoutMs);
  }

  /** Headless inside the distro — there is no window to embed, so the screen is mirrored instead. */
  displayHandle(): Promise<number | null> {
    return Promise.resolve(null);
  }
}
