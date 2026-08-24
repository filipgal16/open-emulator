import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs';
import path from 'path';

export interface DownloadSpec {
  url: string;
  /** Absolute destination. The file is only created here once it has verified. */
  target: string;
  /** Expected digest, lowercase hex. Google's SDK manifest publishes SHA-1. */
  digest?: string;
  algorithm?: 'sha1' | 'sha256';
  /** Declared size, used for progress before any bytes arrive. */
  sizeBytes?: number;
}

export interface DownloadProgress {
  url: string;
  bytesDone: number;
  bytesTotal: number;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  onProgress?: (progress: DownloadProgress) => void;
  onLog?: (message: string) => void;
  /** Refuse anything larger, so a wrong URL cannot fill the disk. */
  maxBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export class DownloadError extends Error {
  constructor(
    message: string,
    /** True when retrying could plausibly work — a network drop rather than a bad digest. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Hashes a file that is already on disk. Used to decide whether it needs downloading at all. */
export async function digestOf(file: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  const { createReadStream } = await import('fs');
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Downloads one file, resuming a partial one and verifying before it counts.
 *
 * Three properties, each earning its complexity:
 *
 *   **Resume.** Bytes already in the `.part` file are requested with `Range: bytes=N-`. Without
 *   this, a dropped connection at 90% of a 1.5 GB system image costs the entire download — which
 *   is the single most demoralising way first-run setup fails.
 *
 *   **Verify before rename.** The real file appears only after its digest matches. Nothing
 *   downstream ever sees a half-written or corrupt archive, so "does this file exist?" is a
 *   sufficient completeness check everywhere else.
 *
 *   **Skip what is already right.** A target that exists and matches is returned immediately. That
 *   is what makes the whole setup step idempotent, and it is why "Try again" after a failure costs
 *   seconds rather than starting from nothing.
 */
export async function downloadFile(spec: DownloadSpec, options: DownloadOptions = {}): Promise<string> {
  const {
    fetchImpl = fetch,
    onProgress = () => undefined,
    onLog = () => undefined,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
  } = options;

  const algorithm = spec.algorithm ?? 'sha1';
  const part = `${spec.target}.part`;
  mkdirSync(path.dirname(spec.target), { recursive: true });

  if (existsSync(spec.target)) {
    if (!spec.digest) return spec.target;
    if ((await digestOf(spec.target, algorithm)) === spec.digest.toLowerCase()) {
      onLog(`already downloaded: ${path.basename(spec.target)}`);
      onProgress({ url: spec.url, bytesDone: statSync(spec.target).size, bytesTotal: statSync(spec.target).size });
      return spec.target;
    }
    // Present but wrong — a truncated or superseded file. Start over rather than resuming onto it.
    onLog(`re-downloading ${path.basename(spec.target)}: digest did not match`);
    rmSync(spec.target, { force: true });
  }

  let existingBytes = 0;
  if (existsSync(part)) {
    existingBytes = statSync(part).size;
    if (existingBytes > 0) onLog(`resuming ${path.basename(spec.target)} at ${existingBytes} bytes`);
  }

  const headers: Record<string, string> = {};
  if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;

  let response: Response;
  try {
    response = await fetchImpl(spec.url, { headers, signal });
  } catch (err) {
    throw new DownloadError(`could not reach ${spec.url}: ${(err as Error).message}`, true);
  }

  // A server that ignores Range answers 200 with the whole file; honouring it answers 206. Trusting
  // a 200 while appending would silently produce a file with the first N bytes duplicated.
  if (existingBytes > 0 && response.status === 200) {
    onLog('the server ignored the resume request — starting over');
    rmSync(part, { force: true });
    existingBytes = 0;
  } else if (existingBytes > 0 && response.status !== 206) {
    throw new DownloadError(`resume refused with status ${response.status}`, true);
  }

  if (!response.ok) {
    // 4xx is a wrong URL or an expired manifest; retrying will not help. 5xx might.
    throw new DownloadError(`download failed with status ${response.status}`, response.status >= 500);
  }
  if (!response.body) throw new DownloadError('the response carried no body', true);

  const declared = Number(response.headers.get('content-length') ?? 0);
  const total = spec.sizeBytes ?? (declared > 0 ? declared + existingBytes : 0);
  if (total > maxBytes) throw new DownloadError(`refusing a ${total}-byte download`, false);

  const sink = createWriteStream(part, { flags: existingBytes > 0 ? 'a' : 'w' });
  let done = existingBytes;

  try {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (!value) continue;

      done += value.byteLength;
      if (done > maxBytes) throw new DownloadError('the download exceeded its size limit', false);

      if (!sink.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => sink.once('drain', resolve));
      }
      onProgress({ url: spec.url, bytesDone: done, bytesTotal: Math.max(total, done) });
    }
  } catch (err) {
    // Closed, not destroyed. `destroy()` discards whatever is still buffered, which threw away the
    // very bytes this is meant to keep — the partial file is the entire point of resuming, so an
    // interrupted download has to flush what it has before giving up.
    await new Promise<void>((resolve) => sink.end(() => resolve())).catch(() => undefined);
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(`the download was interrupted: ${(err as Error).message}`, true);
  }

  await new Promise<void>((resolve, reject) => {
    sink.end(() => resolve());
    sink.on('error', reject);
  });

  if (spec.digest) {
    const actual = await digestOf(part, algorithm);
    if (actual !== spec.digest.toLowerCase()) {
      // A mismatch after a resume usually means the remote file changed under us, so the partial
      // bytes are worthless — keeping them would make every retry fail the same way.
      rmSync(part, { force: true });
      throw new DownloadError(`${path.basename(spec.target)} failed verification (${algorithm})`, true);
    }
  }

  renameSync(part, spec.target);
  onLog(`downloaded ${path.basename(spec.target)}`);
  return spec.target;
}

export interface ParallelResult {
  files: string[];
  failures: Array<{ url: string; error: DownloadError }>;
}

/**
 * Downloads several files at once, with a ceiling on concurrency.
 *
 * The point is overlap, not raw parallelism: the emulator, the platform tools, and a 1.5 GB system
 * image queueing one behind another is what makes first run feel like it has stalled. Three at a
 * time keeps a domestic link busy without turning progress reporting into noise.
 *
 * Failures are collected rather than thrown, so one bad package does not discard the other two
 * gigabytes that downloaded successfully — the caller retries only what failed.
 */
export async function downloadAll(
  specs: DownloadSpec[],
  options: DownloadOptions & { concurrency?: number } = {},
): Promise<ParallelResult> {
  const { concurrency = 3, ...rest } = options;

  // One shared view of overall progress, so the UI can show a single meaningful bar rather than
  // three bars that each jump around independently.
  const perUrl = new Map<string, DownloadProgress>();
  for (const spec of specs) {
    perUrl.set(spec.url, { url: spec.url, bytesDone: 0, bytesTotal: spec.sizeBytes ?? 0 });
  }

  const report = (progress: DownloadProgress) => {
    perUrl.set(progress.url, progress);
    let bytesDone = 0;
    let bytesTotal = 0;
    for (const entry of perUrl.values()) {
      bytesDone += entry.bytesDone;
      bytesTotal += entry.bytesTotal;
    }
    rest.onProgress?.({ url: progress.url, bytesDone, bytesTotal });
  };

  const files: string[] = [];
  const failures: ParallelResult['failures'] = [];
  const queue = [...specs];

  const worker = async (): Promise<void> => {
    for (;;) {
      const spec = queue.shift();
      if (!spec) return;
      try {
        files.push(await downloadFile(spec, { ...rest, onProgress: report }));
      } catch (err) {
        const error = err instanceof DownloadError ? err : new DownloadError(String(err), true);
        failures.push({ url: spec.url, error });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, worker));
  return { files, failures };
}
