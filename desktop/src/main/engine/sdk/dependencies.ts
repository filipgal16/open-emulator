import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import path from 'path';
import { downloadAll, type DownloadProgress, type DownloadSpec } from '../download';
import type { GuestProfile } from '../env-file';
import type { EngineLogHandler } from '../types';
import { extractZip } from './unzip';
import type { SdkLayout } from './layout';
import {
  hostOsForPlatform,
  parseRepository,
  REPOSITORY_URL,
  sysImgManifestFor,
  type SdkArchive,
} from './repository';

/**
 * Everything the SDK engine needs on disk, acquired in one pass.
 *
 * Replaces `android/scripts/fetch_android.sh`, which downloaded a JDK and `cmdline-tools` in order
 * to run `sdkmanager`, which then downloaded the packages one at a time. Here the packages come
 * straight from the manifest, three at a time, resumable — and the JRE and command-line tools stop
 * being needed at all.
 */

export interface DependencyPlan {
  archives: SdkArchive[];
  /** Licence ids these packages require, for the acceptance step. */
  licenseIds: string[];
  totalBytes: number;
}

export interface ResolveOptions {
  profile: GuestProfile;
  apiLevel?: number;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
}

/**
 * Which packages this profile needs, with URLs and digests resolved.
 *
 * `platform-tools` carries adb; `emulator` is the emulator itself; the platform and the system
 * image are what the AVD is created against. The system image lives in a *different* manifest per
 * image tag, which is why two documents are fetched.
 */
export async function resolveDependencies(options: ResolveOptions): Promise<DependencyPlan> {
  const { profile, apiLevel = 30, fetchImpl = fetch, platform = process.platform } = options;
  const host = hostOsForPlatform(platform);
  // A derived image (`openemu`) is built here, not downloaded; what the repository has to supply
  // is the stock image it is built from.
  const imageTag = profile.baseImageTag ?? profile.imageTag;

  const [mainXml, sysXml] = await Promise.all([
    fetchImpl(REPOSITORY_URL).then((r) => r.text()),
    fetchImpl(sysImgManifestFor(imageTag)).then((r) => r.text()),
  ]);

  const main = parseRepository(mainXml, host, REPOSITORY_URL);
  const sys = parseRepository(sysXml, host, sysImgManifestFor(imageTag));

  const wanted: Array<[string, Map<string, SdkArchive>]> = [
    ['platform-tools', main.packages],
    ['emulator', main.packages],
    [`platforms;android-${apiLevel}`, main.packages],
    [`system-images;android-${apiLevel};${imageTag};x86_64`, sys.packages],
  ];

  const archives: SdkArchive[] = [];
  for (const [coordinate, source] of wanted) {
    const archive = source.get(coordinate);
    // Naming the missing coordinate matters: "the download failed" sends someone to check their
    // network, when the real cause is a manifest that no longer carries this API level.
    if (!archive) throw new Error(`the SDK manifest has no package "${coordinate}" for ${host}`);
    archives.push(archive);
  }

  const licenseIds = [...new Set(archives.map((a) => a.licenseId).filter((id): id is string => id !== null))];
  return { archives, licenseIds, totalBytes: archives.reduce((sum, a) => sum + a.sizeBytes, 0) };
}

export interface AcquireOptions {
  layout: SdkLayout;
  plan: DependencyPlan;
  onProgress?: (progress: DownloadProgress) => void;
  onLog?: EngineLogHandler;
  concurrency?: number;
  /** Keep the archives after extraction. Off by default — see `cleanup`. */
  keepArchives?: boolean;
}

/**
 * Where a package's zip lands, and the directory it must end up as.
 *
 * A package coordinate maps directly onto the SDK's directory layout: `platforms;android-30`
 * becomes `platforms/android-30`, and `system-images;android-30;default;x86_64` becomes the
 * matching four-deep path. `platform-tools` and `emulator` have a single segment and sit at the
 * root.
 */
function archivePaths(layout: SdkLayout, archive: SdkArchive): { zip: string; dest: string } {
  const zip = path.join(layout.root, 'downloads', archive.url.split('/').pop() ?? `${archive.path}.zip`);
  const dest = path.join(layout.sdkRoot, ...archive.path.split(';').map(sanitizeSegment));
  return { zip, dest };
}

function sanitizeSegment(segment: string): string {
  // Coordinates come from Google's manifest, but they become filesystem paths, so they are matched
  // rather than trusted.
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw new Error(`unsafe package segment: ${segment}`);
  return segment;
}

/**
 * Downloads and extracts everything in the plan.
 *
 * Downloads run in parallel; extraction is serial, because unzipping three archives at once on one
 * disk is slower than doing them in turn and makes progress meaningless.
 */
export async function acquireDependencies(options: AcquireOptions): Promise<void> {
  const { layout, plan, onProgress, onLog = () => undefined, concurrency = 3, keepArchives = false } = options;

  const specs: DownloadSpec[] = plan.archives.map((archive) => ({
    url: archive.url,
    target: archivePaths(layout, archive).zip,
    digest: archive.sha1,
    algorithm: 'sha1',
    sizeBytes: archive.sizeBytes,
  }));

  onLog('stdout', `downloading ${specs.length} packages (${formatBytes(plan.totalBytes)})`);

  const result = await downloadAll(specs, {
    concurrency,
    onProgress,
    onLog: (message) => onLog('stdout', message),
  });

  if (result.failures.length > 0) {
    const detail = result.failures.map((f) => `${f.url.split('/').pop()}: ${f.error.message}`).join('; ');
    throw new Error(`could not download ${result.failures.length} package(s) — ${detail}`);
  }

  for (const archive of plan.archives) {
    const { zip, dest } = archivePaths(layout, archive);
    onLog('stdout', `extracting ${archive.displayName}`);
    await extractInto(zip, dest);

    // Only after the extraction it belongs to has succeeded. Deleting eagerly would mean a failure
    // here costs the whole download again.
    if (!keepArchives) rmSync(zip, { force: true });
  }

  // The archives are gone; the directory that held them is just clutter.
  const downloads = path.join(layout.root, 'downloads');
  if (!keepArchives && existsSync(downloads) && readdirSync(downloads).length === 0) {
    rmSync(downloads, { recursive: true, force: true });
  }
}

/**
 * Unpacks an SDK archive and puts it exactly where the SDK layout requires.
 *
 * Every one of these zips already contains a single top-level directory, and its name is **not**
 * always the name the destination needs:
 *
 *   platform-tools                            zip has `platform-tools/`  → platform-tools
 *   emulator                                  zip has `emulator/`        → emulator
 *   platforms;android-30                      zip has `android-11/`      → platforms/android-30
 *   system-images;android-30;default;x86_64   zip has `x86_64/`          → …/default/x86_64
 *
 * So extracting straight into the destination is wrong twice over: it nests a redundant level
 * (`…/default/x86_64/x86_64/system.img`, which is where a real run actually put it) and it leaves
 * the platform under its version name rather than its API level. `sdkmanager` handles this by
 * extracting aside and renaming, and so does this.
 */
export async function extractInto(zip: string, dest: string): Promise<void> {
  const staging = `${dest}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    await extractZip(zip, staging);

    const entries = readdirSync(staging, { withFileTypes: true });
    const roots = entries.filter((entry) => entry.isDirectory());
    // One directory and nothing else is the shape every SDK archive has. Anything else means the
    // packaging changed, and guessing which part to promote would put files somewhere arbitrary.
    const source = roots.length === 1 && entries.length === 1 ? path.join(staging, roots[0].name) : staging;

    rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(source, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface CleanupReport {
  removed: string[];
  bytesFreed: number;
}

/**
 * Removes what setup no longer needs.
 *
 * Nothing in the previous implementation ever deleted anything, so a finished install left roughly
 * two gigabytes of archives on disk that would never be read again. Every path here is safe to
 * remove at any time: the archives have already been extracted, `.part` files belong to downloads
 * that either completed or were abandoned, and the SDK's own scratch directories are rebuilt on
 * demand.
 *
 * Exposed to the UI as "free up space" as well as running automatically, so the same code path
 * serves both and cannot rot from disuse.
 */
export function cleanup(layout: SdkLayout, options: { dropJre?: boolean } = {}): CleanupReport {
  const targets = [
    path.join(layout.root, 'downloads'),
    // The SDK tooling leaves these behind; they are caches, not state.
    path.join(layout.sdkRoot, '.temp'),
    path.join(layout.sdkRoot, '.downloadIntermediates'),
  ];

  // The JRE is only needed while `sdkmanager` is, which is no longer at all — but it is removed
  // explicitly rather than silently, because an installation that predates the direct-download
  // path may still have one.
  if (options.dropJre) targets.push(layout.jreRoot);

  const removed: string[] = [];
  let bytesFreed = 0;

  for (const target of targets) {
    if (!existsSync(target)) continue;
    bytesFreed += sizeOf(target);
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }

  // Orphaned partial downloads anywhere under the root — a `.part` whose download was abandoned
  // long ago is not a head start, it is dead weight.
  for (const stale of findByExtension(layout.root, '.part')) {
    bytesFreed += sizeOf(stale);
    rmSync(stale, { force: true });
    removed.push(stale);
  }

  return { removed, bytesFreed };
}

function sizeOf(target: string): number {
  try {
    const stat = statSync(target);
    if (stat.isFile()) return stat.size;
    let total = 0;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      total += sizeOf(path.join(target, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function findByExtension(root: string, extension: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(root)) return [];
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findByExtension(full, extension, depth - 1));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
