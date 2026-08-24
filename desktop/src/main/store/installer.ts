import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs';
import path from 'path';
import type { InstallJob } from '../../shared/store-types';
import type { AppLibrary } from '../app-library';
import type { OpenEmuClient } from '../open-emu-client';
import type { DownloadSpec } from './sources/source';

const MAX_APK_BYTES = 1_500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface InstallerOptions {
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
  now?: () => number;
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

  constructor(
    private readonly openEmu: OpenEmuClient,
    private readonly library: AppLibrary,
    private readonly downloadDir: string,
    options: InstallerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onLog = options.onLog ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
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
    try {
      apkPath = spec.kind === 'file' ? this.useLocalFile(job, spec) : await this.download(job, spec);
    } catch (err) {
      this.fail(job, (err as Error).message);
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
        // `fail` rather than `failure`: adb's own wording is "failed to install" and
        // "INSTALL_FAILED_…", and matching only the noun threw away the one line worth showing.
        const detail = [...result.stderr, ...result.stdout]
          .filter((line) => /fail|error|not allowed|invalid|denied/i.test(line))
          .slice(-1)[0];
        this.fail(job, detail ?? `open-emu install exited ${result.code}`);
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
