import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs';
import path from 'path';
import type { CommandResult } from '../../shared/ipc-types';
import type { InstallJob } from '../../shared/store-types';
import type { AppLibrary } from '../guest/app-library';
import type { OpenEmuClient } from '../engine/client';
import {
  inspectPackageFile,
  installTimeoutMs,
  PACKAGE_NAME,
  PackageFileError,
  parseAbiList,
  planExpansions,
  selectApks,
  type AppBundle,
} from './bundle';
import type { DownloadSpec } from './sources/source';
import { extractZipEntry, ZipError } from './zip-archive';

const MAX_APK_BYTES = 1_500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Unpacking gigabytes in 64 KB chunks would otherwise send the window tens of thousands of updates. */
const PROGRESS_INTERVAL_MS = 200;

export interface InstallerOptions {
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
  now?: () => number;
  /**
   * Where bundles are unpacked before install. Each job gets its own directory inside, removed
   * when the job ends however it ends. Defaults to a directory beside the download cache.
   */
  scratchDir?: string;
}

export type JobListener = (job: InstallJob) => void;

/**
 * Gets an APK from wherever it lives into the guest.
 *
 * Jobs run one at a time. Not because the bridge needs it — `WslBridge` already serializes
 * `open-emu` invocations — but because a queue of installs racing each other through a TCG-backed
 * emulator is slower in aggregate than doing them in order, and a single progress bar that means
 * something beats five that don't.
 */
export class Installer {
  private readonly queue: InstallJob[] = [];
  private readonly listeners = new Set<JobListener>();
  private readonly specs = new Map<string, DownloadSpec>();
  private running = false;

  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;
  private readonly now: () => number;
  private readonly scratchDir: string;

  constructor(
    private readonly openEmu: OpenEmuClient,
    private readonly library: AppLibrary,
    private readonly downloadDir: string,
    options: InstallerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onLog = options.onLog ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.scratchDir = options.scratchDir ?? `${downloadDir}-unpacking`;
  }

  onUpdate(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Active and recently-finished jobs, newest first. */
  jobs(): InstallJob[] {
    return [...this.queue].reverse();
  }

  enqueue(spec: DownloadSpec): InstallJob {
    const existing = this.queue.find(
      (job) =>
        job.packageName === spec.packageName &&
        job.source === spec.source &&
        job.state !== 'done' &&
        job.state !== 'failed',
    );
    if (existing) return existing;

    const job: InstallJob = {
      id: `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      packageName: spec.packageName,
      // For every source but `local`, the package name is known up front and needs no discovery.
      resolvedPackage: spec.source === 'local' ? null : spec.packageName,
      label: spec.label,
      source: spec.source,
      state: 'queued',
      bytesDone: 0,
      bytesTotal: spec.sizeBytes,
      error: null,
      startedAt: this.now(),
    };

    this.queue.push(job);
    this.specs.set(job.id, spec);
    this.emit(job);
    void this.drain();
    return job;
  }

  /**
   * Records a file that was turned away before it could become a job.
   *
   * As a failed job rather than a return value, so the reason appears in the same install list
   * the person is already watching, next to the files from the same choice that did go ahead.
   */
  refuse(label: string, reason: string): InstallJob {
    const job: InstallJob = {
      id: `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      packageName: label,
      resolvedPackage: null,
      label,
      source: 'local',
      state: 'failed',
      bytesDone: 0,
      bytesTotal: 0,
      error: reason,
      startedAt: this.now(),
    };
    this.onLog(`refused ${label}: ${reason}`);
    this.queue.push(job);
    this.emit(job);
    return job;
  }

  private emit(job: InstallJob): void {
    for (const listener of this.listeners) listener({ ...job });
  }

  private update(job: InstallJob, changes: Partial<InstallJob>): void {
    Object.assign(job, changes);
    this.emit(job);
  }

  private fail(job: InstallJob, message: string): void {
    this.onLog(`install failed (${job.label}): ${message}`);
    this.update(job, { state: 'failed', error: message });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.queue.find((candidate) => candidate.state === 'queued');
        if (!job) return;
        const spec = this.specs.get(job.id);
        if (!spec) {
          this.fail(job, 'internal: job lost its download spec');
          continue;
        }
        await this.run(job, spec);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: InstallJob, spec: DownloadSpec): Promise<void> {
    let apkPath: string;
    let bundle: AppBundle | null = null;
    try {
      apkPath = spec.kind === 'file' ? this.useLocalFile(job, spec) : await this.download(job, spec);
      if (spec.kind === 'file') bundle = bundleIn(apkPath);
    } catch (err) {
      this.fail(job, (err as Error).message);
      return;
    }

    if (bundle) {
      await this.runBundle(job, spec, apkPath, bundle);
      return;
    }

    // The package list is only needed for local files, whose real package name isn't known until
    // the guest tells us. Skipping the round trip otherwise keeps F-Droid installs one adb call
    // cheaper — which matters on a TCG guest where each one costs seconds.
    const needsDiff = spec.source === 'local';
    let before: string[] = [];
    if (needsDiff) {
      before = await this.library.listPackageNames().catch(() => []);
    }

    this.update(job, { state: 'installing' });

    try {
      // A Windows path, handed over as-is. Whether it needs translating for the runtime carrying
      // it is the engine's problem, which is what keeps this class runtime-agnostic.
      const result = await this.openEmu.install(apkPath, () => undefined, INSTALL_TIMEOUT_MS);
      if (result.code !== 0) {
        this.fail(job, failureDetail(result, 'open-emu install'));
        return;
      }
    } catch (err) {
      this.fail(job, (err as Error).message);
      return;
    }

    if (needsDiff) {
      const after = await this.library.listPackageNames().catch(() => []);
      const added = after.filter((pkg) => !before.includes(pkg));
      // Exactly one new package means the diff is unambiguous. Two would mean something else
      // installed alongside us, and guessing which one was ours would be worse than not knowing.
      if (added.length === 1) this.update(job, { resolvedPackage: added[0] });
    }

    this.update(job, { state: 'done', bytesDone: job.bytesTotal || job.bytesDone });
    this.onLog(`installed ${job.resolvedPackage ?? job.label} (${spec.source})`);
  }

  /**
   * Unpacks the APKs this guest needs from a bundle and installs them in one session, then copies
   * any game data files into place.
   *
   * The guest is asked for its processor types before anything is unpacked, so a bundle it cannot
   * run is turned away in a second rather than after minutes of extracting gigabytes. The scratch
   * directory goes whichever way the job ends: what is in it is a copy of a file the person still
   * has, and can be as large as that file.
   */
  private async runBundle(job: InstallJob, spec: DownloadSpec, bundlePath: string, bundle: AppBundle): Promise<void> {
    if (!this.openEmu.canInstallBundles) {
      this.fail(job, 'This kind of app file can only be installed on the built-in Android runtime.');
      return;
    }

    const abis = parseAbiList(await this.openEmu.getprop('ro.product.cpu.abilist', () => undefined));
    if (abis.length === 0) {
      this.fail(job, 'The device isn’t answering. Start it, then try again.');
      return;
    }

    let chosen: string[];
    try {
      chosen = selectApks(bundle.apks, bundle.manifest, abis).apks;
    } catch (err) {
      this.fail(job, (err as Error).message);
      return;
    }

    const members = chosen.map((name) => bundle.apks.find((entry) => entry.name === name)!);
    const manifestPackage = bundle.manifest?.packageName ?? null;
    const expansions = planExpansions(bundle, manifestPackage);
    const total = [...members, ...expansions.map((plan) => plan.entry)].reduce((sum, entry) => sum + entry.size, 0);
    const workDir = path.join(this.scratchDir, `bundle-${job.id}`);

    try {
      rmSync(workDir, { recursive: true, force: true });
      mkdirSync(workDir, { recursive: true });

      this.update(job, { state: 'unpacking', bytesDone: 0, bytesTotal: total });
      let lastEmit = 0;
      const progress = (bytes: number) => {
        job.bytesDone += bytes;
        if (this.now() - lastEmit < PROGRESS_INTERVAL_MS) return;
        lastEmit = this.now();
        this.emit(job);
      };

      // Numbered rather than named after the members: the names come from a downloaded file, and
      // only this directory's own scheme is ever joined onto a host path.
      const apkPaths: string[] = [];
      for (const [index, entry] of members.entries()) {
        const target = path.join(workDir, `${index}.apk`);
        await extractZipEntry(bundlePath, entry, target, progress);
        apkPaths.push(target);
      }
      const obbPaths: string[] = [];
      for (const [index, plan] of expansions.entries()) {
        const target = path.join(workDir, `${index}.obb`);
        await extractZipEntry(bundlePath, plan.entry, target, progress);
        obbPaths.push(target);
      }

      const before = await this.library.listPackageNames().catch((): string[] => []);
      this.update(job, { state: 'installing', bytesDone: total });

      const installBytes = members.reduce((sum, entry) => sum + entry.size, 0);
      const result = await this.openEmu.installMultiple(apkPaths, () => undefined, installTimeoutMs(installBytes));
      if (result.code !== 0) {
        this.fail(job, failureDetail(result, 'install-multiple'));
        return;
      }

      const after = await this.library.listPackageNames().catch((): string[] => []);
      const added = after.filter((pkg) => !before.includes(pkg));
      // The guest's answer first, as for a single APK. A reinstall adds nothing to the diff, and
      // then the manifest's name is the best there is — checked, since it came with the download.
      if (added.length === 1) this.update(job, { resolvedPackage: added[0] });
      else if (manifestPackage && PACKAGE_NAME.test(manifestPackage)) this.update(job, { resolvedPackage: manifestPackage });

      // The app is installed at this point and stays installed: a game whose data did not copy
      // can usually fetch it again itself, and undoing a good install would not help it.
      let warning: string | null = null;
      for (const [index, plan] of expansions.entries()) {
        const pushed = await this.openEmu.pushFile(obbPaths[index], plan.guestPath, () => undefined, installTimeoutMs(plan.entry.size));
        if (pushed.code !== 0) {
          this.onLog(`could not copy ${plan.guestPath}: ${failureDetail(pushed, 'adb push')}`);
          warning = 'Installed, but the game’s data files couldn’t be copied. It may download them again when it starts.';
          break;
        }
      }

      this.update(job, { state: 'done', bytesDone: total, error: warning });
      this.onLog(`installed ${job.resolvedPackage ?? job.label} (${spec.source}, ${members.length} APKs, ${expansions.length} OBBs)`);
    } catch (err) {
      this.fail(job, unpackFailure(err as Error));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private useLocalFile(job: InstallJob, spec: DownloadSpec): string {
    if (!existsSync(spec.location)) throw new Error('the APK file is no longer there');
    const size = statSync(spec.location).size;
    this.update(job, { bytesDone: size, bytesTotal: size, state: 'verifying' });
    return spec.location;
  }

  /**
   * Streams the APK to disk, hashing as it goes.
   *
   * The digest is checked before the file is offered to the guest, and a mismatch deletes it. An
   * APK is executable code: "downloaded from the right URL" is not the same claim as "is the
   * artefact the catalogue signed for", and only the second one is worth acting on.
   */
  private async download(job: InstallJob, spec: DownloadSpec): Promise<string> {
    if (!spec.sha256) throw new Error('refusing to install a network APK with no expected digest');
    if (new URL(spec.location).protocol !== 'https:') throw new Error('refusing a non-https download');

    mkdirSync(this.downloadDir, { recursive: true });
    const finalPath = path.join(this.downloadDir, `${spec.sha256}.apk`);

    // Already fetched and verified under its own digest — nothing to re-download.
    if (existsSync(finalPath)) {
      const size = statSync(finalPath).size;
      this.update(job, { state: 'verifying', bytesDone: size, bytesTotal: size });
      return finalPath;
    }

    this.update(job, { state: 'downloading', bytesDone: 0 });

    const response = await this.fetchImpl(spec.location, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      credentials: 'omit',
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('empty response');

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 0) this.update(job, { bytesTotal: declared });

    const tmpPath = `${finalPath}.part`;
    const sink = createWriteStream(tmpPath);
    const hash = createHash('sha256');
    let received = 0;

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_APK_BYTES) throw new Error('APK exceeds the size limit');
        hash.update(value);
        if (!sink.write(value)) {
          await new Promise<void>((resolve, reject) => {
            sink.once('drain', resolve);
            sink.once('error', reject);
          });
        }
        this.update(job, { bytesDone: received });
      }
      await new Promise<void>((resolve, reject) => {
        sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      sink.destroy();
      rmSync(tmpPath, { force: true });
      throw err;
    }

    this.update(job, { state: 'verifying' });

    const actual = hash.digest('hex');
    if (actual !== spec.sha256) {
      rmSync(tmpPath, { force: true });
      throw new Error(`digest mismatch — expected ${spec.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
    }

    // Rename only after the digest checks out, so the cache can never hold a bad artefact under a
    // name that says it is good.
    renameSync(tmpPath, finalPath);
    return finalPath;
  }
}

/**
 * A local file's bundle contents, or null to install it as a single APK.
 *
 * A file named `.apk` that turns out not to be a bundle goes to the guest as it is, even when it
 * could not be read as a zip: the guest's package manager is the authority on what an APK is, and
 * its own refusal says more than a guess from here. A file named `.xapk` or `.apks` has no such
 * fallback, so whatever is wrong with it is reported.
 */
function bundleIn(filePath: string): AppBundle | null {
  try {
    const found = inspectPackageFile(filePath);
    return found.kind === 'bundle' ? found : null;
  } catch (err) {
    if (path.extname(filePath).toLowerCase() === '.apk') return null;
    throw err;
  }
}

/**
 * The one line of adb's output worth showing.
 *
 * `fail` rather than `failure`: adb's own wording is "failed to install" and "INSTALL_FAILED_…",
 * and matching only the noun threw away the one line worth showing.
 */
function failureDetail(result: CommandResult, command: string): string {
  const detail = [...result.stderr, ...result.stdout]
    .filter((line) => /fail|error|not allowed|invalid|denied/i.test(line))
    .slice(-1)[0];
  return detail ?? `${command} exited ${result.code}`;
}

/** Unpacking errors, translated for the person who chose the file. */
function unpackFailure(err: Error): string {
  if (err instanceof PackageFileError) return err.message;
  if (err instanceof ZipError) return 'This file is damaged. Download it again, then try again.';
  if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
    return 'There isn’t enough free disk space to unpack this app.';
  }
  return err.message;
}
