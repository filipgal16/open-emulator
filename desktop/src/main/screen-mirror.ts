import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import type { WslTarget } from './wsl-bridge';

const FRAME_MARKER = 'FRAME:';
const HEADER_LEN = FRAME_MARKER.length + 8 + 1; // "FRAME:" + 8-digit size + ":"

export type FrameHandler = (png: Buffer) => void;
export type MirrorLogHandler = (stream: 'stdout' | 'stderr', line: string) => void;

/**
 * Polls `adb exec-out screencap` inside WSL2 on a fixed interval and streams length-prefixed PNG
 * frames back over a single long-lived process (spawning wsl.exe fresh per frame is too slow to
 * hit even 2-5 FPS). Talks to adb directly via android/lib/common.sh's env resolution, bypassing
 * open-emu's per-call logging/state writes.
 */
export class ScreenMirror {
  private child: ChildProcessWithoutNullStreams | null = null;
  private acc: Buffer = Buffer.alloc(0);

  constructor(
    private readonly target: WslTarget,
    private readonly intervalMs = 300,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(onFrame: FrameHandler, onLog: MirrorLogHandler): void {
    if (this.child) return;
    this.acc = Buffer.alloc(0);

    // `$HOME` is empty in the shell WSL gives us, so the checkout path is resolved from the passwd
    // database instead — the same reason `WslBridge.remoteDir` exists.
    const script = `
cd "$(getent passwd "$(id -u)" | cut -d: -f6)/${this.target.remotePath.replace(/^~\/?/, '')}" || exit 1
source android/lib/common.sh
android_env >/dev/null 2>&1
while true; do
  tmp=$(mktemp)
  "$ADB_BIN" exec-out screencap -p > "$tmp" 2>/dev/null
  sz=$(stat -c%s "$tmp" 2>/dev/null || echo 0)
  if [ "$sz" -gt 0 ]; then
    printf 'FRAME:%08d:' "$sz"
    cat "$tmp"
  fi
  rm -f "$tmp"
  sleep ${(this.intervalMs / 1000).toFixed(2)}
done
`;

    // `-e` rather than `--`: with `--`, wsl.exe substitutes `$VAR` itself before bash runs, which
    // would empty `$tmp` and `$sz` below and make this loop capture nothing. See `WslBridge.exec`.
    const child = spawn('wsl.exe', ['-d', this.target.distro, '-e', 'bash', '-lc', script], { windowsHide: true });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk, onFrame));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) onLog('stderr', text);
    });
    child.on('close', () => {
      this.child = null;
    });
  }

  stop(): void {
    if (!this.child) return;
    // Killing wsl.exe doesn't always promptly kill the loop it launched inside the distro
    // (a known WSL2 quirk); acceptable for v1 — the loop is cheap and self-terminates on the
    // next screencap failure once the emulator/device goes away.
    this.child.kill();
    this.child = null;
    this.acc = Buffer.alloc(0);
  }

  private handleData(chunk: Buffer, onFrame: FrameHandler): void {
    this.acc = Buffer.concat([this.acc, chunk]);
    for (;;) {
      const markerIdx = this.acc.indexOf(FRAME_MARKER);
      if (markerIdx === -1) {
        if (this.acc.length > FRAME_MARKER.length) {
          this.acc = this.acc.subarray(this.acc.length - FRAME_MARKER.length);
        }
        return;
      }
      if (markerIdx > 0) {
        this.acc = this.acc.subarray(markerIdx);
      }
      if (this.acc.length < HEADER_LEN) return;

      const sizeStr = this.acc.subarray(FRAME_MARKER.length, FRAME_MARKER.length + 8).toString('ascii');
      const size = Number.parseInt(sizeStr, 10);
      if (!Number.isFinite(size) || size < 0) {
        this.acc = this.acc.subarray(FRAME_MARKER.length);
        continue;
      }

      const total = HEADER_LEN + size;
      if (this.acc.length < total) return;

      onFrame(Buffer.from(this.acc.subarray(HEADER_LEN, total)));
      this.acc = this.acc.subarray(total);
    }
  }
}
