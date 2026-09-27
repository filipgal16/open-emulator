import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'fs';
import path from 'path';
import {
  AVB_FLAG_HASHTREE_DISABLED,
  loadOrCreateSigningKey,
  parseAvbFooter,
  parseVbmetaHeader,
  resignVbmeta,
  upsertVerifiedBootParams,
  vbmetaDigest,
} from './avb';
import { rewriteIdentity, upsertProps } from './build-prop';
import { Ext4Volume, FileDisk, type RemoveReport } from './ext4';
import { findPartition, readGpt } from './gpt';
import { findLogical, readLpMetadata } from './lp';
import { BUILDER_REVISION, OPENEMU_RECIPE, recipeHash, validateRecipe, type RomRecipe, type VolumeName } from './recipe';
import { renderWallpaper } from './wallpaper';

/**
 * Builds the `openemu` ROM from the stock AOSP image, on the user's machine, in TypeScript.
 *
 * See `design/openemu-rom.md`. The short version: copy Google's `default` image aside, edit the
 * four ext4 volumes inside its `super` partition (debloat, identity, our own files), re-sign the
 * top-level vbmeta with our key and `HASHTREE_DISABLED` so the guest mounts `/system` without
 * dm-verity putting Google's bytes back, and swap the result into place. Nothing here needs WSL,
 * and nothing of Google's is redistributed — the user's machine downloaded the base.
 */

/** Everything the builder creates or changes carries this time. 2009-01-01, AOSP's own convention. */
export const ROM_EPOCH = 1230768000;

const MANIFEST = 'openemu-manifest.json';
const VOLUMES: VolumeName[] = ['system', 'system_ext', 'product', 'vendor'];

export interface RomPaths {
  baseDir: string;
  imageDir: string;
  stagingDir: string;
  prevDir: string;
}

/** Where the per-machine signing key lives: beside the SDK, not inside an image directory it would be copied with. */
export function romKeyDir(layout: { root: string }): string {
  return path.join(layout.root, 'rom');
}

export function romPaths(sdkRoot: string, recipe: RomRecipe = OPENEMU_RECIPE): RomPaths {
  const images = path.join(sdkRoot, 'system-images', `android-${recipe.apiLevel}`);
  const imageDir = path.join(images, recipe.id, 'x86_64');
  return {
    baseDir: path.join(images, recipe.baseTag, 'x86_64'),
    imageDir,
    stagingDir: `${imageDir}.staging`,
    prevDir: `${imageDir}.prev`,
  };
}

export interface VolumeReport {
  removed: string[];
  notPresent: string[];
  blocksFreed: number;
  inodesFreed: number;
  blocksStillShared: number;
  propsChanged: string[];
  created: string[];
  freeBlocks: number;
  freeInodes: number;
}

export interface RomManifest {
  builder: 'openemu-rom';
  builderRevision: number;
  recipeId: string;
  recipeVersion: number;
  recipeHash: string;
  /** SHA-256 over the stock top-level and chained `system` vbmeta: identifies the base image. */
  baseDigest: string;
  /** The same digest over ours. It is what the guest reports as `ro.boot.vbmeta.digest`. */
  romId: string;
  volumes: Record<VolumeName, VolumeReport>;
  /** Informational. Not part of the image, so it does not affect reproducibility. */
  builtAt: string;
}

export interface BuildOptions {
  sdkRoot: string;
  /** Where the per-machine signing key lives. See `loadOrCreateSigningKey`. */
  keyDir: string;
  recipe?: RomRecipe;
  force?: boolean;
  /** Whether the ROM's emulator is running. A running guest has `system.img` open. */
  isRunning?: () => boolean | Promise<boolean>;
  onLog?: (line: string) => void;
}

export interface BuildResult {
  manifest: RomManifest;
  imageDir: string;
  skipped: boolean;
}

// ── Reading the image's structure ───────────────────────────────────────────────────────────────

interface ImageLayout {
  vbmeta: { offset: number; size: number };
  superOffset: number;
  volumes: Record<VolumeName, { offset: number; size: number }>;
}

function reader(fd: number) {
  return (offset: number, length: number): Buffer => {
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(fd, out, done, length - done, offset + done);
      if (n <= 0) throw new Error(`short read at ${offset + done}`);
      done += n;
    }
    return out;
  };
}

function layoutOf(fd: number): ImageLayout {
  const read = reader(fd);
  const gpt = readGpt(read);
  const vbmeta = findPartition(gpt, 'vbmeta');
  const superPart = findPartition(gpt, 'super');
  const lp = readLpMetadata((offset, length) => read(superPart.offset + offset, length), superPart.size);
  const volumes = {} as ImageLayout['volumes'];
  for (const name of VOLUMES) {
    const part = findLogical(lp.partitions, name);
    volumes[name] = { offset: superPart.offset + part.offset, size: part.size };
  }
  return { vbmeta: { offset: vbmeta.offset, size: vbmeta.size }, superOffset: superPart.offset, volumes };
}

/** The top-level vbmeta, trimmed to its real size, and the chained one from `system`'s footer. */
function readVbmetas(fd: number, layout: ImageLayout): { top: Buffer; chained: Buffer } {
  const read = reader(fd);
  // The parser checks the claimed size against the bytes it is given, so it gets the whole
  // partition and the image is trimmed to what the header says afterwards.
  const partition = read(layout.vbmeta.offset, layout.vbmeta.size);
  const top = Buffer.from(partition.subarray(0, parseVbmetaHeader(partition).totalSize));

  const system = layout.volumes.system;
  const footer = parseAvbFooter(read(system.offset + system.size - 64, 64), system.size);
  if (!footer) throw new Error('the system partition has no AVB footer — this is not the image layout the ROM is built for');
  const chainedRegion = read(system.offset + footer.vbmetaOffset, footer.vbmetaSize);
  const chained = Buffer.from(chainedRegion.subarray(0, parseVbmetaHeader(chainedRegion).totalSize));
  return { top, chained };
}

/** The params the emulator copies onto the kernel command line, as a map. */
function bootParams(text: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const match of text.matchAll(/^param:\s*"([^"=]+)=([^"]*)"\s*$/gm)) params.set(match[1], match[2]);
  return params;
}

/**
 * Identifies a base image by the digest the emulator puts on the command line, recomputed from
 * the bytes and checked against Google's own `VerifiedBootParams.textproto`.
 *
 * Cheap — two small reads, never the 3 GB image — and it changes whenever Google republishes the
 * image, which is exactly when a rebuild is needed. The cross-check doubles as proof that the
 * builder reads this layout the way the emulator does.
 */
export function baseDigest(baseDir: string): string {
  const fd = openSync(path.join(baseDir, 'system.img'), 'r');
  try {
    const { top, chained } = readVbmetas(fd, layoutOf(fd));
    const digest = vbmetaDigest([top, chained]);
    const params = bootParams(readFileSync(path.join(baseDir, 'VerifiedBootParams.textproto'), 'utf8'));
    const expected = params.get('androidboot.vbmeta.digest');
    if (expected && expected.toLowerCase() !== digest) {
      throw new Error(`the ${path.basename(path.dirname(baseDir))} image's vbmeta does not match its VerifiedBootParams digest`);
    }
    const size = Number(params.get('androidboot.vbmeta.size'));
    if (size && size !== top.length + chained.length) {
      throw new Error(`vbmeta size ${top.length + chained.length} does not match VerifiedBootParams (${size})`);
    }
    return digest;
  } finally {
    closeSync(fd);
  }
}

// ── State of the built ROM ────────────────────────────────────────────────────────────────────

export function readManifest(imageDir: string): RomManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(imageDir, MANIFEST), 'utf8')) as Partial<RomManifest>;
    // A manifest from the old debugfs builder has no `builder` field and never counts as ours.
    return manifest.builder === 'openemu-rom' ? (manifest as RomManifest) : null;
  } catch {
    return null;
  }
}

/**
 * A crash between the two renames of a swap leaves `x86_64` missing and `x86_64.prev` holding the
 * last good ROM. Put it back before anything looks for the image.
 */
export function recoverInterruptedSwap(paths: RomPaths): boolean {
  if (!existsSync(paths.imageDir) && existsSync(paths.prevDir)) {
    renameSync(paths.prevDir, paths.imageDir);
    return true;
  }
  if (existsSync(paths.imageDir) && existsSync(paths.prevDir)) {
    rmSync(paths.prevDir, { recursive: true, force: true });
  }
  return false;
}

export interface RomState {
  built: boolean;
  upToDate: boolean;
  reason: string;
  manifest: RomManifest | null;
}

/**
 * Rendered once per process. The wallpaper is drawn, not stored, and deterministic, so its bytes
 * cannot change within a run — while `romState` is asked on every launch and every cold start.
 */
let wallpaper: Buffer | null = null;

function contentsFor(recipe: RomRecipe): Record<string, Buffer> {
  const needsWallpaper = recipe.files.some((f) => f.source === 'wallpaper');
  if (!needsWallpaper) return {};
  wallpaper ??= renderWallpaper();
  return { wallpaper };
}

/**
 * Whether the ROM on disk is the one this build of the app would produce: written by this builder,
 * from this recipe, over this base. Anything else — including the old builder's image — rebuilds.
 */
export function romState(sdkRoot: string, recipe: RomRecipe = OPENEMU_RECIPE, contents?: Record<string, Buffer>): RomState {
  const paths = romPaths(sdkRoot, recipe);
  recoverInterruptedSwap(paths);
  if (!existsSync(path.join(paths.imageDir, 'system.img'))) {
    return { built: false, upToDate: false, reason: 'not built', manifest: null };
  }
  const manifest = readManifest(paths.imageDir);
  if (!manifest) return { built: true, upToDate: false, reason: 'built by an older builder', manifest: null };
  if (manifest.builderRevision !== BUILDER_REVISION) return { built: true, upToDate: false, reason: 'builder changed', manifest };
  const hash = recipeHash(recipe, contents ?? contentsFor(recipe));
  if (manifest.recipeHash !== hash) return { built: true, upToDate: false, reason: 'recipe changed', manifest };
  if (!existsSync(path.join(paths.baseDir, 'system.img'))) {
    // The base may be cleaned up later; the ROM stands on its own once built.
    return { built: true, upToDate: true, reason: 'up to date (base not present to compare)', manifest };
  }
  if (manifest.baseDigest !== baseDigest(paths.baseDir)) return { built: true, upToDate: false, reason: 'base image changed', manifest };
  return { built: true, upToDate: true, reason: 'up to date', manifest };
}

// ── The build ────────────────────────────────────────────────────────────────────────────────

export async function buildRom(options: BuildOptions): Promise<BuildResult> {
  const recipe = options.recipe ?? OPENEMU_RECIPE;
  const log = (line: string) => options.onLog?.(`[rom] ${line}`);
  validateRecipe(recipe);

  const paths = romPaths(options.sdkRoot, recipe);
  if (recoverInterruptedSwap(paths)) log('restored the previous ROM after an interrupted build');
  if (!existsSync(path.join(paths.baseDir, 'system.img'))) {
    throw new Error(`the ${recipe.baseTag} system image is not downloaded — there is nothing to build ${recipe.id} from`);
  }

  const contents = contentsFor(recipe);
  const hash = recipeHash(recipe, contents);
  const base = baseDigest(paths.baseDir);

  const existing = readManifest(paths.imageDir);
  if (
    !options.force &&
    existing &&
    existing.builderRevision === BUILDER_REVISION &&
    existing.recipeHash === hash &&
    existing.baseDigest === base &&
    existsSync(path.join(paths.imageDir, 'system.img'))
  ) {
    log(`${recipe.displayName} ${recipe.version} is up to date`);
    return { manifest: existing, imageDir: paths.imageDir, skipped: true };
  }

  if (await options.isRunning?.()) {
    throw new Error(`${recipe.displayName} is running — stop Android before its system image is rebuilt`);
  }

  log(`copying the ${recipe.baseTag} image (about 3 GB, once per build)`);
  rmSync(paths.stagingDir, { recursive: true, force: true });
  mkdirSync(path.dirname(paths.stagingDir), { recursive: true });
  cpSync(paths.baseDir, paths.stagingDir, { recursive: true });
  // The base's manifest-less copy must never pass for a finished build if we stop half way.
  rmSync(path.join(paths.stagingDir, MANIFEST), { force: true });

  const volumes = {} as Record<VolumeName, VolumeReport>;
  let romId: string;

  const systemImg = path.join(paths.stagingDir, 'system.img');
  const fd = openSync(systemImg, 'r+');
  try {
    const layout = layoutOf(fd);
    const before = readVbmetas(fd, layout);
    if (vbmetaDigest([before.top, before.chained]) !== base) throw new Error('the staged copy does not match the base image');

    for (const name of VOLUMES) {
      volumes[name] = editVolume(fd, layout, name, recipe, contents, log);
    }

    // The chained `system` vbmeta sits past the filesystem, in the part of the partition the ext4
    // editor cannot reach. Confirm that rather than assume it.
    const after = readVbmetas(fd, layout);
    if (!after.chained.equals(before.chained)) throw new Error('the chained system vbmeta changed during the edit');

    const key = loadOrCreateSigningKey(options.keyDir);
    const signed = resignVbmeta(before.top, key, AVB_FLAG_HASHTREE_DISABLED);
    writeAll(fd, signed, layout.vbmeta.offset);
    romId = vbmetaDigest([signed, before.chained]);

    const params = path.join(paths.stagingDir, 'VerifiedBootParams.textproto');
    writeFileSync(
      params,
      upsertVerifiedBootParams(
        readFileSync(params, 'utf8'),
        {
          'androidboot.vbmeta.size': String(signed.length + before.chained.length),
          'androidboot.vbmeta.hash_alg': 'sha256',
          'androidboot.vbmeta.digest': romId,
        },
        // Neither is needed with a validly signed vbmeta, and orange would tell every app the
        // bootloader is unlocked.
        ['androidboot.verifiedbootstate', 'androidboot.vbmeta.device_state'],
      ),
      'utf8',
    );
    log(`signed vbmeta with HASHTREE_DISABLED; ROM id ${romId.slice(0, 16)}`);
  } finally {
    closeSync(fd);
  }

  // The SDK keeps a copy of /system/build.prop beside the image for tools that never boot it.
  const sideProp = path.join(paths.stagingDir, 'build.prop');
  if (existsSync(sideProp)) {
    const rewritten = rewriteIdentity(readFileSync(sideProp, 'utf8'), recipe.identity).text;
    writeFileSync(sideProp, upsertProps(rewritten, recipe.systemProps), 'utf8');
  }

  const sourceProps = path.join(paths.stagingDir, 'source.properties');
  if (existsSync(sourceProps)) {
    const text = readFileSync(sourceProps, 'utf8')
      .replace(/^SystemImage\.TagId=.*$/m, `SystemImage.TagId=${recipe.id}`)
      .replace(/^SystemImage\.TagDisplay=.*$/m, `SystemImage.TagDisplay=${recipe.displayName}`)
      .replace(/^Pkg\.Desc=.*$/m, `Pkg.Desc=${recipe.displayName} ${recipe.version} (built from ${recipe.baseTag})`);
    writeFileSync(sourceProps, text, 'utf8');
  }

  const manifest: RomManifest = {
    builder: 'openemu-rom',
    builderRevision: BUILDER_REVISION,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    recipeHash: hash,
    baseDigest: base,
    romId,
    volumes,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(paths.stagingDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Windows will not rename over a non-empty directory, so the old ROM steps aside first. A crash
  // between the two renames is repaired by `recoverInterruptedSwap` on the next run.
  if (existsSync(paths.imageDir)) renameSync(paths.imageDir, paths.prevDir);
  renameSync(paths.stagingDir, paths.imageDir);
  rmSync(paths.prevDir, { recursive: true, force: true });

  log(`${recipe.displayName} ${recipe.version} built at ${paths.imageDir}`);
  return { manifest, imageDir: paths.imageDir, skipped: false };
}

function writeAll(fd: number, data: Buffer, offset: number): void {
  let done = 0;
  while (done < data.length) {
    const n = writeSync(fd, data, done, data.length - done, offset + done);
    if (n <= 0) throw new Error(`short write at ${offset + done}`);
    done += n;
  }
}

/**
 * One volume, in the order the plan fixes: removals first (they return inodes and blocks), then
 * identity, then our own files. Verified through a fresh reader afterwards, and every file this
 * wrote is read back.
 */
function editVolume(
  fd: number,
  layout: ImageLayout,
  name: VolumeName,
  recipe: RomRecipe,
  contents: Record<string, Buffer>,
  log: (line: string) => void,
): VolumeReport {
  const window = layout.volumes[name];
  const volume = Ext4Volume.open(new FileDisk(fd, window.offset, window.size, true), { writable: true, epoch: ROM_EPOCH });
  const report: VolumeReport = {
    removed: [],
    notPresent: [],
    blocksFreed: 0,
    inodesFreed: 0,
    blocksStillShared: 0,
    propsChanged: [],
    created: [],
    freeBlocks: 0,
    freeInodes: 0,
  };
  const written = new Map<string, Buffer>();

  for (const target of recipe.debloat[name]) {
    if (!volume.exists(target)) {
      report.notPresent.push(target);
      continue;
    }
    const removed: RemoveReport = volume.removeTree(target);
    report.removed.push(target);
    report.blocksFreed += removed.blocksFreed;
    report.inodesFreed += removed.inodesFreed;
    report.blocksStillShared += removed.blocksStillShared;
  }
  if (report.removed.length > 0) {
    log(`${name}: removed ${report.removed.length} apps, freed ${report.blocksFreed} blocks (${report.blocksStillShared} stayed, shared with other files)`);
  }
  if (report.notPresent.length > 0) log(`${name}: not in this image, skipped: ${report.notPresent.join(', ')}`);

  const propPath = recipe.buildPropPath[name];
  if (volume.exists(propPath)) {
    const original = volume.readFile(propPath).toString('utf8');
    const identity = rewriteIdentity(original, recipe.identity);
    let text = identity.text;
    report.propsChanged.push(...identity.changed);
    if (name === 'system') {
      text = upsertProps(text, recipe.systemProps);
      report.propsChanged.push(...Object.keys(recipe.systemProps));
    }
    if (text !== original) {
      const data = Buffer.from(text, 'utf8');
      volume.replaceFile(propPath, data);
      written.set(propPath, data);
    }
    log(`${name}: ${propPath} — ${identity.changed.length} identity keys rewritten`);
  } else {
    log(`${name}: no ${propPath}`);
  }

  for (const file of recipe.files.filter((f) => f.volume === name)) {
    if (file.kind === 'dir') {
      if (!volume.exists(file.path)) volume.mkdir(file.path, { mode: file.mode, selinux: file.selinux });
    } else {
      const data = file.source ? contents[file.source] : Buffer.alloc(0);
      if (!data) throw new Error(`no content for ${file.path}`);
      if (volume.exists(file.path)) volume.replaceFile(file.path, data);
      else volume.createFile(file.path, data, { mode: file.mode, selinux: file.selinux });
      written.set(file.path, data);
    }
    report.created.push(file.path);
  }
  if (report.created.length > 0) log(`${name}: added ${report.created.join(', ')}`);

  volume.flush();

  const check = Ext4Volume.open(new FileDisk(fd, window.offset, window.size, false));
  const verified = check.verify();
  if (!verified.ok) {
    throw new Error(`${name}: the edited filesystem failed verification — ${verified.problems.slice(0, 5).join('; ')}`);
  }
  for (const [file, data] of written) {
    if (!check.readFile(file).equals(data)) throw new Error(`${name}: ${file} did not read back as written`);
  }
  report.freeBlocks = check.freeBlocks;
  report.freeInodes = check.freeInodes;
  return report;
}
