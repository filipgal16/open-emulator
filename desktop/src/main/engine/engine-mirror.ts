import type { AndroidEngine } from './types';
import type { LogStream } from '../../shared/ipc-types';

export type FrameHandler = (png: Buffer) => void;
export type MirrorLogHandler = (stream: LogStream, line: string) => void;

/**
 * Mirrors the guest by asking the engine for frames.
 *
 * The WSL runtime could not do this. Each frame there costs a `wsl.exe` round trip, which is why
 * `ScreenMirror` keeps a long-lived bash loop inside the distro and parses length-prefixed PNGs out
 * of its stdout — a real piece of machinery built entirely to avoid per-frame process startup.
 * Natively that whole problem disappears: `adb exec-out screencap` is a local process, so the loop
 * can live here in plain TypeScript.
 *
 * This is still a stopgap. Polling for PNGs is bounded by however long a screencap takes, and the
 * real answer is embedding the emulator's own window — at which point this becomes the fallback for
 * headless runs and for machines where embedding misbehaves.
 */
export class EngineMirror {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;

  constructor(
    private readonly engine: AndroidEngine,
    private readonly intervalMs = 250,
  ) {}

  get active(): boolean {
    return this.running;
  }

  start(onFrame: FrameHandler, onLog: MirrorLogHandler): void {
    if (this.running) return;
    if (!this.engine.screencap) {
      onLog('stderr', `the ${this.engine.id} engine cannot capture frames directly`);
      return;
    }
    this.running = true;

    let consecutiveFailures = 0;

    const tick = async (): Promise<void> => {
      // Skip rather than queue. A capture slower than the interval would otherwise build a backlog
      // of requests that all return stale frames, and the display would drift further behind the
      // guest the longer it ran.
      if (!this.running || this.inFlight) return;
      this.inFlight = true;

      try {
        const png = await this.engine.screencap!();
        // A zero-length capture is normal while the guest is still coming up; it is not an error
        // worth reporting, it just means there is nothing to show yet.
        if (png.length > 0) {
          onFrame(png);
          consecutiveFailures = 0;
        }
      } catch (err) {
        consecutiveFailures += 1;
        // Report once, not every 250ms. A guest that has gone away would otherwise fill the log
        // with the same line four times a second.
        if (consecutiveFailures === 1) {
          onLog('stderr', `screen capture failed: ${(err as Error).message}`);
        }
      } finally {
        this.inFlight = false;
      }
    };

    this.timer = setInterval(() => void tick(), this.intervalMs);
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
