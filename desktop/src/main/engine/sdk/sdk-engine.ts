import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { posixQuote } from '../../platform/shell-quote';
import { loadDevice, loadProfile, type DeviceIdentity, type GuestProfile } from '../env-file';
import { ProcessRunner, spawnDetached, type DetachedProcess } from '../process';
import type { AndroidEngine, EngineLogHandler, StartOptions } from '../types';
import { Adb } from './adb';
import { avdConfigOverrides, applyAvdConfig, emulatorArgs } from './avd-config';
import { avdExists, createAvd } from './avd';
import { tuneForHost, type GuestTuning } from './host';
import { avdDir, avdState, snapshotDir, systemImagePath, type SdkLayout } from './layout';
import type { CommandResult } from '../../../shared/ipc-types';

const SNAPSHOT = 'booted';
const NO_LOG: EngineLogHandler = () => undefined;

export interface SdkEngineOptions {
  layout: SdkLayout;
  /** The tree holding `profiles/` and `devices/` — `repoRootWinPath()/android`. */
  androidRoot: string;
  profile: string | null;
  /** Read live, so changing the identity in settings does not need an app restart. */
  device?: () => string;
  /** Whether a hypervisor the emulator can use is available. Decides accel and renderer. */
  accelerated: () => boolean;
  /** False forces `-no-window`; true lets the emulator paint a window we can embed. */
  windowed?: boolean;
  onLog?: (message: string) => void;
}

/**
 * Google's SDK emulator, as a native Windows process.
 *
 * This is the port of `android/bin/open-emu` and `android/lib/common.sh`. What it inherits from
 * them is the set of behaviours that were arrived at by failing: the warm path that does not
 * reboot a running guest, the cold-boot fallback that keeps the snapshot rather than deleting it,
 * per-AVD state, and the refusal to let the emulator write a snapshot while quitting.
 *
 * What it sheds is everything WSL forced: no `setsid` (a native child is ours and dies when we say
 * so), no two-shell quoting, no `~` that cannot be expanded, and a real window with a real GPU
 * instead of a headless guest photographed three times a second.
 */
export class SdkEngine implements AndroidEngine {
  readonly id = 'sdk' as const;

  private readonly runner = new ProcessRunner();
  private readonly adb: Adb;
  private readonly log: (message: string) => void;
  private emulator: DetachedProcess | null = null;
  private serial: string | null = null;
  private profileName: string | null;

  constructor(private readonly options: SdkEngineOptions) {
    this.adb = new Adb(options.layout.adb, this.runner);
    this.log = (message) => options.onLog?.(`[sdk] ${message}`);
    this.profileName = options.profile;
  }

  /**
   * One shell to cross: adb takes argv directly, so only the guest's sh re-parses. Quoting twice
   * here would leave the outer quotes inside the value.
   */
  quoteGuestArg(value: string): string {
    return posixQuote(value);
  }

  setProfile(profile: string | null): void {
    this.profileName = profile;
    // The serial belongs to whichever guest was running; it means nothing for a different AVD.
    this.serial = null;
  }

  // ── Configuration ────────────────────────────────────────────────────────────────────────────

  private profile(): GuestProfile {
    return loadProfile(this.options.androidRoot, this.profileName ?? 'fast');
  }

  private device(): DeviceIdentity {
    return loadDevice(this.options.androidRoot, this.options.device?.() ?? 'generic');
  }

  private tuning(): GuestTuning {
    return tuneForHost({
      cpus: os.cpus().length,
      totalRamMb: Math.round(os.totalmem() / (1024 * 1024)),
      accelerated: this.options.accelerated(),
      hasWindow: this.options.windowed !== false,
    });
  }

  private stateDir(avdName: string): string {
    const dir = avdState(this.options.layout, avdName);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private hasSnapshot(avdName: string): boolean {
    return existsSync(snapshotDir(this.options.layout, avdName, SNAPSHOT));
  }

  private pidFile(avdName: string): string {
    return path.join(avdState(this.options.layout, avdName), 'emulator.pid');
  }

  /**
   * Is an emulator running for this AVD — including one this process did not start?
   *
   * The in-memory handle is not enough, and the gap is not theoretical. Close the app while Android
   * is running and reopen it, and the handle is gone while the emulator is very much still there.
   * Two things then go wrong: `status` reports the guest as stopped while it is plainly running,
   * and `start` misses the warm path and launches a **second** emulator against the same AVD —
   * which is what the AVD's own `multiinstance.lock` exists to complain about, and which corrupts
   * the userdata both instances are writing.
   *
   * So the pid file is read back, and the process actually checked. `process.kill(pid, 0)` sends no
   * signal; it only asks whether the pid can be signalled, and works on Windows.
   */
  private runningPid(avdName: string): number | null {
    if (this.emulator?.child.exitCode === null && this.emulator.pid) return this.emulator.pid;

    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(this.pidFile(avdName), 'utf8').trim(), 10);
    } catch {
      return null;
    }
    if (!Number.isFinite(pid) || pid <= 0) return null;

    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // The pid belongs to a process that has since exited. Clear the stale file so this is not
      // re-checked on every status poll.
      rmSync(this.pidFile(avdName), { force: true });
      return null;
    }
  }

  private provisionedAt(avdName: string): string | null {
    const marker = path.join(avdState(this.options.layout, avdName), 'provisioned_at');
    try {
      return readFileSync(marker, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Records the moment provisioning finished, which is what `status` reports as `provisioned_at`. */
  markProvisioned(avdName: string): void {
    writeFileSync(path.join(this.stateDir(avdName), 'provisioned_at'), new Date().toISOString(), 'utf8');
  }

  /**
   * Brings `config.ini` in line with the profile, the device, and this host's tuning.
   *
   * Run before every start, not only at creation: cores, RAM, and the renderer are host-dependent,
   * and `hw.gpu.mode` in particular has to agree with the `-gpu` flag or the snapshot this boot
   * writes cannot be loaded by the next one.
   */
  private syncAvdConfig(profile: GuestProfile, tuning: GuestTuning): void {
    // Create it if it is not there. avdmanager used to do this; it lived in cmdline-tools, which
    // the native runtime no longer downloads, and an AVD is only two configuration files.
    if (!avdExists(this.options.layout, profile.avdName)) {
      createAvd({
        layout: this.options.layout,
        androidRoot: this.options.androidRoot,
        profile,
        device: this.device(),
        tuning,
        snapshotName: SNAPSHOT,
      });
      this.log(`created AVD ${profile.avdName}`);
      return;
    }

    const configPath = path.join(avdDir(this.options.layout, profile.avdName), 'config.ini');

    const overrides = avdConfigOverrides({
      profile,
      device: this.device(),
      tuning,
      hasSnapshot: this.hasSnapshot(profile.avdName),
      snapshotName: SNAPSHOT,
    });

    writeFileSync(configPath, applyAvdConfig(readFileSync(configPath, 'utf8'), overrides), 'utf8');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────────

  async start(onLog: EngineLogHandler = NO_LOG, options: StartOptions = {}): Promise<CommandResult> {
    const profile = this.profile();
    const tuning = this.tuning();

    if (!existsSync(this.options.layout.emulator)) {
      return fail(`emulator not installed — expected ${this.options.layout.emulator}`);
    }
    if (!existsSync(systemImagePath(this.options.layout, profile.imageTag))) {
      return fail(`the ${profile.name} system image is not downloaded yet`);
    }

    // Warm path: a guest that is already up is not rebooted. Reconnecting to it is the whole
    // reason `start` is safe to call from a button.
    // Adopted on adb's word plus a live pid, NOT on holding the child handle — after an app
    // restart the handle is gone but the emulator is not, and starting a second one against the
    // same AVD corrupts the userdata both are writing.
    const existing = await this.adb.waitForDevice(2_000).catch(() => null);
    if (existing && this.runningPid(profile.avdName) !== null) {
      this.serial = existing;
      this.log(`already running on ${existing} — warm path, no reboot`);
      return ok([`adb_device=${existing}`]);
    }

    this.syncAvdConfig(profile, tuning);

    const useSnapshot = !options.cold && this.hasSnapshot(profile.avdName) && tuning.accel === 'on';
    const args = emulatorArgs({
      avdName: profile.avdName,
      tuning,
      device: this.device(),
      useSnapshot: useSnapshot ? SNAPSHOT : null,
      headless: this.options.windowed === false,
    });

    this.log(`starting emulator (${useSnapshot ? 'snapshot' : 'cold'}, gpu=${tuning.gpuMode}, accel=${tuning.accel})`);

    const failures: string[] = [];
    this.emulator = spawnDetached(this.options.layout.emulator, args, {
      env: {
        ...process.env,
        ANDROID_SDK_ROOT: this.options.layout.sdkRoot,
        ANDROID_HOME: this.options.layout.sdkRoot,
        ANDROID_AVD_HOME: this.options.layout.avdHome,
      },
      onLog: (stream, line) => {
        if (/cannot load snapshot|Failed to load snapshot/i.test(line)) failures.push(line);
        onLog(stream, line);
      },
    });

    this.stateDir(profile.avdName);
    writeFileSync(this.pidFile(profile.avdName), String(this.emulator.pid ?? ''), 'utf8');

    const serial = await this.adb.waitForDevice(useSnapshot ? 120_000 : 300_000);
    if (!serial) {
      return fail('the emulator started but no adb device appeared');
    }
    this.serial = serial;

    // A failed restore is recoverable, so it retries cold — but it must NOT delete the snapshot.
    // Deleting it turns one bad restore into a mandatory 20-minute re-provision.
    if (useSnapshot && failures.length > 0) {
      this.log('snapshot restore failed — cold booting, snapshot kept for the next attempt');
      await this.stop(onLog);
      return this.start(onLog, { cold: true });
    }

    const booted = await this.adb.waitForBoot(serial, tuning.accel === 'on' ? 300_000 : 1_800_000);
    if (!booted) return fail('Android did not finish booting');

    this.log(`booted on ${serial}`);
    return ok([`adb_device=${serial}`, 'boot_completed=1']);
  }

  async stop(onLog: EngineLogHandler = NO_LOG): Promise<CommandResult> {
    const profile = this.profile();

    // Ask first. A hard kill can interrupt qcow2 or snapshot writes still in flight, which is
    // exactly how the warm-boot path used to destroy its own snapshot.
    if (this.serial) await this.adb.emuKill(this.serial, onLog);

    const child = this.emulator?.child;
    if (child && child.exitCode === null) {
      const exited = await waitForExit(child, 30_000);
      if (!exited) {
        this.log('emulator still alive after 30s — terminating');
        child.kill();
        if (!(await waitForExit(child, 5_000))) child.kill('SIGKILL');
      }
    }

    // A guest this process did not start has no child handle, so fall back to the pid.
    const orphan = this.runningPid(profile.avdName);
    if (orphan !== null && !child) {
      try {
        process.kill(orphan);
      } catch {
        // Already gone between the check and the signal, which is the outcome we wanted anyway.
      }
    }

    this.emulator = null;
    this.serial = null;
    rmSync(this.pidFile(profile.avdName), { force: true });
    return ok(['emulator=stopped']);
  }

  /**
   * The `key=value` lines the UI reads.
   *
   * Shaped to match what `open-emu status` printed, because `device-status.ts#parseStatus` already
   * knows how to read it and is deliberately tolerant of lines that are absent — a missing line
   * leaves a field at its default rather than reporting "not provisioned" and sending someone
   * through a re-provision they did not need.
   */
  async status(_onLog: EngineLogHandler = NO_LOG): Promise<CommandResult> {
    let profile: GuestProfile;
    try {
      profile = this.profile();
    } catch (err) {
      return fail((err as Error).message);
    }

    const lines = [`avd=${profile.avdName}`];
    // From the pid file, not just the in-memory handle — otherwise a guest that outlived an app
    // restart is reported as stopped while it is plainly running.
    const pid = this.runningPid(profile.avdName);
    lines.push(`emulator=${pid !== null ? 'running' : 'stopped'}`);
    if (pid !== null) lines.push(`pid=${pid}`);

    const serial = this.serial ?? (await this.adb.devices().catch(() => []))[0] ?? null;
    lines.push(`adb_device=${serial ?? 'none'}`);

    if (serial) {
      this.serial = serial;
      const [boot, release, sdk] = await Promise.all([
        this.adb.getprop(serial, 'sys.boot_completed'),
        this.adb.getprop(serial, 'ro.build.version.release'),
        this.adb.getprop(serial, 'ro.build.version.sdk'),
      ]);
      lines.push(`boot_completed=${boot ?? 'unknown'}`);
      lines.push(`android=${release ?? 'unknown'} api=${sdk ?? 'unknown'}`);
    }

    lines.push(`snapshot=${SNAPSHOT} present=${this.hasSnapshot(profile.avdName) ? 'yes' : 'no'}`);
    const provisioned = this.provisionedAt(profile.avdName);
    if (provisioned) lines.push(`provisioned_at=${provisioned}`);

    return ok(lines);
  }

  async doctor(onLog: EngineLogHandler = NO_LOG): Promise<CommandResult> {
    const status = await this.status(onLog);
    const extra = [
      `emulator_binary=${existsSync(this.options.layout.emulator) ? 'present' : 'missing'}`,
      `adb_binary=${existsSync(this.options.layout.adb) ? 'present' : 'missing'}`,
      `acceleration=${this.options.accelerated() ? 'available' : 'missing — the guest will be very slow'}`,
    ];
    return ok([...status.stdout, ...extra]);
  }

  /** Provisioning is substantial enough to live on its own; see `provision.ts`. */
  async provision(onLog: EngineLogHandler = NO_LOG): Promise<CommandResult> {
    const { provisionGuest } = await import('./provision');
    const profile = this.profile();

    if (!this.serial) {
      const started = await this.start(onLog, { cold: true });
      if (started.code !== 0) return started;
    }
    if (!this.serial) return fail('no guest to provision');

    return provisionGuest({
      adb: this.adb,
      serial: this.serial,
      profile,
      accelerated: this.options.accelerated(),
      onLog,
      log: this.log,
      onProvisioned: () => this.markProvisioned(profile.avdName),
    });
  }

  // ── Guest access ─────────────────────────────────────────────────────────────────────────────

  private async requireSerial(): Promise<string | null> {
    if (this.serial) return this.serial;
    const found = (await this.adb.devices().catch(() => []))[0] ?? null;
    this.serial = found;
    return found;
  }

  async shell(command: string, onLog: EngineLogHandler = NO_LOG, timeoutMs = 15_000): Promise<CommandResult> {
    const serial = await this.requireSerial();
    if (!serial) return fail('no running guest');
    return this.adb.shell(serial, command, onLog, timeoutMs);
  }

  /**
   * The secret goes in as its own argv entry.
   *
   * Natively there is only one shell between here and the guest — the guest's own — so the value
   * is quoted once for that and handed to `adb.exe` as a single argument. It never appears in a
   * command string this process builds, which is the property that matters.
   */
  async typeSecret(value: string, onLog: EngineLogHandler = NO_LOG, timeoutMs = 20_000): Promise<CommandResult> {
    const serial = await this.requireSerial();
    if (!serial) return fail('no running guest');
    return this.adb.exec(serial, ['shell', 'input', 'text', posixQuote(value)], onLog, timeoutMs);
  }

  async installApk(hostPath: string, onLog: EngineLogHandler = NO_LOG, timeoutMs = 10 * 60_000): Promise<CommandResult> {
    const serial = await this.requireSerial();
    if (!serial) return fail('no running guest');
    // Nothing to translate: the emulator and the file are on the same filesystem. The path is one
    // argv entry, so spaces and quotes in it need no escaping at all.
    return this.adb.exec(serial, ['install', '-r', '-g', '-d', hostPath], onLog, timeoutMs);
  }

  /**
   * Null until the window-embedding work lands.
   *
   * The emulator does have a real window natively — finding its `HWND` by process id and
   * reparenting it is the next phase. Until then the screen is mirrored frame by frame, exactly as
   * it is today, which is why this returning null is a working answer rather than a placeholder.
   */
  displayHandle(): Promise<number | null> {
    return Promise.resolve(null);
  }

  /** Exposed so the mirror can pull frames without going through the serialized command queue. */
  screencap(): Promise<Buffer> {
    if (!this.serial) return Promise.reject(new Error('no running guest'));
    return this.adb.screencap(this.serial);
  }
}

function ok(stdout: string[]): CommandResult {
  return { code: 0, signal: null, stdout, stderr: [] };
}

function fail(message: string): CommandResult {
  return { code: 1, signal: null, stdout: [], stderr: [message] };
}

function waitForExit(child: { exitCode: number | null; once: (e: string, cb: () => void) => void }, ms: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
