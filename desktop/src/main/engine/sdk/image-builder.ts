import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { toWslMountPath } from '../../platform/win-paths';
import { decodeWindowsProcessOutput } from '../../platform/windows-text';
import type { EngineLogHandler } from '../types';
import type { SdkLayout } from './layout';

/**
 * Builds the `openemu` system image: our own Android, derived from the open-source one.
 *
 * See `design/custom-image.md` for the reasoning. In short: `system.img` is a dynamic-partition
 * container of four ext4 volumes that are deduplicated (`shared_blocks`) and nearly full, so they
 * cannot be mounted read-write. Two `debugfs` operations are still safe on them unmounted, and
 * they are all a tuned image needs:
 *
 *   unlink       removes a directory entry, freeing nothing — the app vanishes from the package
 *                manager's view and no block shared with another file is touched
 *   rm + write   replaces build.prop; the volumes have a few free blocks and inodes, enough for
 *                one small file, and the mode and SELinux label are put back by hand because
 *                `write` creates an unlabeled 0644 file and init would refuse an unlabeled one
 *
 * `debugfs` runs inside WSL. This is a build-time toolchain, like every ROM's; the image it
 * produces is what users get.
 */

export interface ProductIdentity {
  brand: string;
  manufacturer: string;
  model: string;
  name: string;
  device: string;
}

export interface ImageSpec {
  /** The image tag the result is installed under. */
  tag: string;
  /** The stock image it is derived from. */
  baseTag: string;
  /** Shown as `TagDisplay` and in the AVD's `tag.display`. */
  displayName: string;
  identity: ProductIdentity;
  /** `ro.build.display.id`: the string on the About screen. */
  displayId: string;
  /** Properties appended to `/system/build.prop`, the one volume with room to grow. */
  systemProps: Record<string, string>;
  /**
   * App directories to unlink, by name, from every `app/` and `priv-app/` on every partition.
   * Names, not package ids: the build works on the filesystem, before any package manager exists.
   */
  removeApps: string[];
}

export const OPENEMU_SPEC: ImageSpec = {
  tag: 'openemu',
  baseTag: 'default',
  displayName: 'open-emulator Android',
  identity: {
    brand: 'open-emulator',
    manufacturer: 'open-emulator',
    model: 'OpenEmulator One',
    name: 'openemu_x86_64',
    device: 'openemu',
  },
  displayId: 'open-emulator Android 11 (openemu) RSR1.210722.013.A2',
  systemProps: {
    'ro.openemu.image': '1',
    'ro.openemu.image.version': '1',
  },
  // Conservative on purpose. Nothing here is needed to boot, to launch apps, to type, to browse,
  // or by telephony's own services (TeleService, Telecom, the providers) which the framework
  // starts regardless. Kept: the launcher, Settings, SystemUI, LatinIME, webview, Browser2,
  // QuickSearchBox (the launcher's search bar binds to it), DocumentsUI, PackageInstaller.
  removeApps: [
    // product/app — the bundled phone apps
    'Calendar',
    'Camera2',
    'DeskClock',
    'Gallery2',
    'Music',
    'PhotoTable',
    'WallpaperPicker',
    'messaging',
    // product/priv-app
    'Contacts',
    'Dialer',
    // system/app
    'BasicDreams',
    'BookmarkProvider',
    'PartnerBookmarksProvider',
    'EasterEgg',
    'LiveWallpapersPicker',
    'PrintSpooler',
    'PrintRecommendationService',
    'Traceur',
    'Stk',
    'SimAppDialog',
    'RcsService',
    'PresencePolling',
    'NfcNci',
    'BluetoothMidiService',
    'WallpaperBackup',
    // system/priv-app
    'BuiltInPrintService',
    'MusicFX',
    'CellBroadcastLegacyApp',
    'Tag',
    'DynamicSystemInstallationService',
    'ONS',
    // system_ext/priv-app
    'WallpaperCropper',
    'EmergencyInfo',
  ],
};

export interface Ext4Volume {
  offset: number;
  size: number;
  /** The volume label, e.g. `system_ext`; empty for the system root. */
  label: string;
}

const EXT4_MAGIC = 0xef53;
const SUPERBLOCK_OFFSET = 1024;
const SCAN_STRIDE = 1024 * 1024;

/**
 * Every ext4 filesystem inside a super image, found by its superblock.
 *
 * Scanned rather than hardcoded: the offsets differ between system images and API levels.
 * Partitions in a super image are aligned to 1 MiB, so the scan strides by that.
 */
export function findExt4Volumes(imagePath: string): Ext4Volume[] {
  const fd = openSync(imagePath, 'r');
  try {
    const total = statSync(imagePath).size;
    const block = Buffer.alloc(1024);
    const volumes: Ext4Volume[] = [];

    for (let offset = 0; offset + SUPERBLOCK_OFFSET + 1024 <= total; offset += SCAN_STRIDE) {
      readSync(fd, block, 0, 1024, offset + SUPERBLOCK_OFFSET);
      if (block.readUInt16LE(0x38) !== EXT4_MAGIC) continue;

      const blocks = block.readUInt32LE(0x04);
      const blockSize = 1024 << block.readUInt32LE(0x18);
      const label = block.subarray(0x78, 0x88).toString('utf8').replace(/\0.*$/, '');
      volumes.push({ offset, size: blocks * blockSize, label });
    }
    return volumes;
  } finally {
    closeSync(fd);
  }
}

const AVB_MAGIC = Buffer.from('AVB0', 'ascii');
const AVB_FLAGS_OFFSET = 120;
/** Size of the top-level vbmeta the emulator hashes into `androidboot.vbmeta.digest`. */
const AVB_VBMETA_SIZE = 6144;
/** `AVB_VBMETA_IMAGE_FLAGS_VERIFICATION_DISABLED` — the flag `libfs_avb` honours before anything else. */
const AVB_VERIFICATION_DISABLED = 0x0000_0002;

/**
 * Turns verified boot off for the image, so the edited system volume is what boots.
 *
 * The system partition is protected by AVB dm-verity **with forward error correction**. FEC is
 * built to repair a few corrupted blocks per stripe, and from its point of view an edited
 * directory block or a rewritten `build.prop` is exactly that: the first `openemu` boot served a
 * byte-perfect *stock* `/system` while `/product` — no verity — showed every change. Nothing
 * failed and nothing was logged; the modifications were simply corrected away.
 *
 * `libfs_avb` reads the top-level vbmeta first and, if `VERIFICATION_DISABLED` is set, stops
 * there: no digest comparison against `androidboot.vbmeta.digest`, no hashtree, plain mounts.
 * `HASHTREE_DISABLED` (what `adb disable-verity` sets) is not enough, because the digest check
 * still runs and the digest the emulator passes on the kernel command line is fixed at build
 * time. The vbmeta sits at 1 MiB in the super image, just after the partition table.
 *
 * Changing the flags changes the vbmeta bytes, so the SHA-256 in `VerifiedBootParams.textproto`
 * must be rewritten to match — see `syncVerifiedBootParams`. Leaving the stock digest in place
 * is what made the first edited image boot-loop: init logged `Failed to open AvbHandle` and
 * never mounted `/system`.
 */
export function disableVerifiedBoot(systemImg: string): { offset: number; previousFlags: number } {
  const fd = openSync(systemImg, 'r+');
  try {
    const offset = 1024 * 1024;
    const header = Buffer.alloc(256);
    readSync(fd, header, 0, 256, offset);
    if (!header.subarray(0, 4).equals(AVB_MAGIC)) {
      throw new Error(`no vbmeta at ${offset} in ${systemImg}: the image layout is not the one this build knows`);
    }
    const previousFlags = header.readUInt32BE(AVB_FLAGS_OFFSET);
    const flags = Buffer.alloc(4);
    flags.writeUInt32BE(previousFlags | AVB_VERIFICATION_DISABLED, 0);
    writeSync(fd, flags, 0, 4, offset + AVB_FLAGS_OFFSET);
    return { offset, previousFlags };
  } finally {
    closeSync(fd);
  }
}

/** SHA-256 of the 6144-byte vbmeta the emulator puts on the kernel command line. */
export function hashVbmeta(systemImg: string, offset = 1024 * 1024, size = AVB_VBMETA_SIZE): string {
  const fd = openSync(systemImg, 'r');
  try {
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, offset);
    if (n !== size) throw new Error(`vbmeta at ${offset} in ${systemImg} is ${n} bytes, expected ${size}`);
    return createHash('sha256').update(buf).digest('hex');
  } finally {
    closeSync(fd);
  }
}

/**
 * Rewrites `VerifiedBootParams.textproto` so `androidboot.vbmeta.digest` matches the image.
 *
 * The emulator does not hash vbmeta itself: it copies this file onto the kernel command line.
 * After `disableVerifiedBoot` the stock digest is stale, and first-stage init refuses to mount
 * `/system`. Returns whether the file changed.
 */
export function syncVerifiedBootParams(imageDir: string, digest: string): boolean {
  const file = path.join(imageDir, 'VerifiedBootParams.textproto');
  if (!existsSync(file)) {
    throw new Error(`no VerifiedBootParams.textproto in ${imageDir} — the emulator would pass no vbmeta digest`);
  }
  const original = readFileSync(file, 'utf8');
  const next = original.replace(/androidboot\.vbmeta\.digest=[0-9a-fA-F]+/g, `androidboot.vbmeta.digest=${digest}`);
  if (!next.includes(`androidboot.vbmeta.digest=${digest}`)) {
    throw new Error(`${file} has no androidboot.vbmeta.digest line to rewrite`);
  }
  if (next === original) return false;
  writeFileSync(file, next, 'utf8');
  return true;
}

/**
 * Puts the stock vbmeta and `VerifiedBootParams.textproto` back, copying both from the base image.
 *
 * Patching vbmeta in place (even just the flags) invalidates its signature. This ramdisk then
 * logs `ERROR_VERIFICATION / PUBLIC_KEY_REJECTED isn't allowed` and never mounts `/system`.
 * The edits stay in the ext4 volumes; verity is turned off at runtime with `-writable-system`.
 *
 * Returns whether anything changed.
 */
export function restoreStockVbmeta(imageDir: string, baseDir: string): boolean {
  const destImg = path.join(imageDir, 'system.img');
  const srcImg = path.join(baseDir, 'system.img');
  const offset = 1024 * 1024;

  const src = Buffer.alloc(AVB_VBMETA_SIZE);
  const dest = Buffer.alloc(AVB_VBMETA_SIZE);
  const srcFd = openSync(srcImg, 'r');
  try {
    if (readSync(srcFd, src, 0, AVB_VBMETA_SIZE, offset) !== AVB_VBMETA_SIZE) {
      throw new Error(`stock vbmeta in ${srcImg} is shorter than ${AVB_VBMETA_SIZE} bytes`);
    }
  } finally {
    closeSync(srcFd);
  }
  const destFd = openSync(destImg, 'r+');
  try {
    readSync(destFd, dest, 0, AVB_VBMETA_SIZE, offset);
    const sameVbmeta = src.equals(dest);
    if (!sameVbmeta) writeSync(destFd, src, 0, AVB_VBMETA_SIZE, offset);
    const srcParams = path.join(baseDir, 'VerifiedBootParams.textproto');
    const destParams = path.join(imageDir, 'VerifiedBootParams.textproto');
    const srcText = existsSync(srcParams) ? readFileSync(srcParams, 'utf8') : '';
    const destText = existsSync(destParams) ? readFileSync(destParams, 'utf8') : '';
    if (srcText && srcText !== destText) writeFileSync(destParams, srcText, 'utf8');
    return !sameVbmeta || srcText !== destText;
  } finally {
    closeSync(destFd);
  }
}

/**
 * Rewrites the product identity in one `build.prop`.
 *
 * Every `ro.product.<partition>.<key>` line is rewritten in place — read-only properties keep
 * their *first* definition, so appending would change nothing. Fingerprints are rebuilt from the
 * new identity with the original build id and tags. `ro.build.display.id` is replaced where
 * present. `extra` is appended; callers only pass it for the volume that has room.
 *
 * Pure, so the rewrite can be tested against the real files without an image.
 */
export function patchBuildProp(
  text: string,
  identity: ProductIdentity,
  displayId: string,
  extra: Record<string, string> = {},
): string {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const out: string[] = [];
  for (const line of lines) {
    const ident = line.match(/^(ro\.product\.(?:[a-z_]+\.)?)(brand|manufacturer|model|name|device)=(.*)$/);
    if (ident) {
      out.push(`${ident[1]}${ident[2]}=${identity[ident[2] as keyof ProductIdentity]}`);
      continue;
    }

    const fingerprint = line.match(/^(ro\.[a-z_.]*build\.fingerprint)=(.*)$/);
    if (fingerprint) {
      out.push(`${fingerprint[1]}=${rewriteFingerprint(fingerprint[2], identity)}`);
      continue;
    }

    if (line.startsWith('ro.build.display.id=')) {
      out.push(`ro.build.display.id=${displayId}`);
      continue;
    }
    // `ro.build.product` is the legacy device name; the modern one is rewritten above.
    if (line.startsWith('ro.build.product=')) {
      out.push(`ro.build.product=${identity.device}`);
      continue;
    }
    out.push(line);
  }

  for (const [key, value] of Object.entries(extra)) {
    out.push(`${key}=${value}`);
  }

  return `${out.join('\n')}\n`;
}

/**
 * `Android/sdk_phone_x86_64/generic_x86_64:11/RSR1…/10067904:userdebug/test-keys`
 *   → `open-emulator/openemu_x86_64/openemu:11/RSR1…/10067904:userdebug/test-keys`
 *
 * Only the three identity fields change; the release, build id, incremental, type and tags are
 * kept so the fingerprint still describes the build it is stamped on.
 */
export function rewriteFingerprint(fingerprint: string, identity: ProductIdentity): string {
  const match = fingerprint.match(/^[^/]*\/[^/]*\/[^:]*:(.*)$/);
  if (!match) return fingerprint;
  return `${identity.brand}/${identity.name}/${identity.device}:${match[1]}`;
}

/** Parses `debugfs -R "ls -p <dir>"`: `/inode/mode/uid/gid/name/size/` per entry. */
export function parseLsP(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split('/');
    // Leading empty (the line starts with '/'), inode, mode, uid, gid, name, size, trailing empty.
    if (parts.length < 7) continue;
    const name = parts[5];
    if (name && name !== '.' && name !== '..') names.push(name);
  }
  return names;
}

// ── Running debugfs ─────────────────────────────────────────────────────────────────────────────

export interface ShellRunner {
  /** Runs a POSIX shell script and returns its combined output and exit code. */
  run(script: string): Promise<{ code: number | null; output: string }>;
}

/**
 * Runs scripts in the default WSL distribution.
 *
 * Every script is written to a file and executed by path, never passed on the command line.
 * `wsl.exe` re-parses its arguments and the quoting for a `debugfs -R "…" "img?offset=N"`
 * command does not survive it; a file has no quoting problem.
 */
export class WslShellRunner implements ShellRunner {
  constructor(private readonly distro: string | null = null) {}

  async run(script: string): Promise<{ code: number | null; output: string }> {
    const dir = path.join(os.tmpdir(), 'open-emulator-image');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `step-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
    // LF only: bash reads CRLF as `bash\r` and the script dies on line one.
    writeFileSync(file, script.replace(/\r\n/g, '\n'), 'utf8');

    try {
      const args = [...(this.distro ? ['-d', this.distro] : []), '-e', 'sh', toWslMountPath(file)];
      return await new Promise((resolve) => {
        const child = spawn('wsl.exe', args, { windowsHide: true });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.stderr.on('data', (c: Buffer) => chunks.push(c));
        child.on('error', (err) => resolve({ code: null, output: `wsl.exe could not be started: ${err.message}` }));
        child.on('close', (code) => resolve({ code, output: decodeWindowsProcessOutput(Buffer.concat(chunks)) }));
      });
    } finally {
      rmSync(file, { force: true });
    }
  }
}

export async function isWslAvailable(runner: ShellRunner): Promise<boolean> {
  const result = await runner.run('command -v debugfs >/dev/null 2>&1 && echo yes');
  return result.code === 0 && /yes/.test(result.output);
}

// ── The build ───────────────────────────────────────────────────────────────────────────────────

export interface BuildImageOptions {
  layout: SdkLayout;
  spec?: ImageSpec;
  apiLevel?: number;
  runner?: ShellRunner;
  onLog?: EngineLogHandler;
  /** Rebuild even if the derived image already exists. */
  force?: boolean;
}

export interface BuildReport {
  imageDir: string;
  verifiedBootDisabled: boolean;
  volumes: Ext4Volume[];
  removed: string[];
  patchedProps: string[];
  skipped: boolean;
}

const SELINUX_SYSTEM_FILE = 'u:object_r:system_file:s0';

export async function buildImage(options: BuildImageOptions): Promise<BuildReport> {
  const { layout, spec = OPENEMU_SPEC, apiLevel = 30, runner = new WslShellRunner(), onLog = () => undefined } = options;
  const log = (line: string) => onLog('stdout', `[image] ${line}`);

  const imagesRoot = path.join(layout.sdkRoot, 'system-images', `android-${apiLevel}`);
  const baseDir = path.join(imagesRoot, spec.baseTag, 'x86_64');
  const imageDir = path.join(imagesRoot, spec.tag, 'x86_64');
  const systemImg = path.join(imageDir, 'system.img');

  if (!existsSync(path.join(baseDir, 'system.img'))) {
    throw new Error(`the ${spec.baseTag} system image is not downloaded — nothing to derive from`);
  }
  if (existsSync(path.join(imageDir, 'openemu-manifest.json')) && !options.force) {
    log(`${spec.tag} image already built at ${imageDir}`);
    if (restoreStockVbmeta(imageDir, baseDir)) {
      log('restored stock vbmeta — verity is disabled at runtime with -writable-system, not by patching the image');
    }
    const manifest = JSON.parse(readFileSync(path.join(imageDir, 'openemu-manifest.json'), 'utf8')) as BuildReport;
    return { ...manifest, imageDir, verifiedBootDisabled: false, skipped: true };
  }

  if (!(await isWslAvailable(runner))) {
    throw new Error('building the image needs WSL with e2fsprogs (debugfs) installed');
  }

  log(`copying the ${spec.baseTag} image (~3 GB, once)`);
  rmSync(imageDir, { recursive: true, force: true });
  mkdirSync(path.dirname(imageDir), { recursive: true });
  cpSync(baseDir, imageDir, { recursive: true });

  // Do not patch vbmeta. This ramdisk rejects a modified vbmeta even with VERIFICATION_DISABLED
  // set (`PUBLIC_KEY_REJECTED isn't allowed`). The emulator's `-writable-system` is what turns
  // verity off so the debugfs edits below actually boot.

  const volumes = findExt4Volumes(systemImg);
  if (volumes.length === 0) throw new Error('no ext4 filesystems found inside system.img');
  log(`found ${volumes.length} filesystems: ${volumes.map((v) => (v.label === '' || v.label === '/' ? 'system' : v.label)).join(', ')}`);

  const wslImg = toWslMountPath(systemImg);
  const work = path.join(os.tmpdir(), 'open-emulator-image');
  mkdirSync(work, { recursive: true });
  const labelFile = path.join(work, 'selinux-system_file');
  // The label carries its terminating NUL, exactly as the original xattr does (26 bytes).
  writeFileSync(labelFile, Buffer.concat([Buffer.from(SELINUX_SYSTEM_FILE, 'utf8'), Buffer.from([0])]));

  const removed: string[] = [];
  const patchedProps: string[] = [];

  for (const volume of volumes) {
    const fs = `${wslImg}?offset=${volume.offset}`;
    // The system volume is labelled "/" (it is mounted as the root); the others carry their
    // partition name.
    const isSystem = volume.label === '' || volume.label === '/';
    const name = isSystem ? 'system' : volume.label;

    // Where apps live on this volume, and where build.prop is. The system volume has its content
    // under /system; the others are mounted as partitions and hold theirs at the root.
    const appDirs = isSystem ? ['/system/app', '/system/priv-app'] : ['/app', '/priv-app'];
    const propPath = isSystem ? '/system/build.prop' : '/build.prop';

    // ── Debloat ──
    const listing = await runner.run(appDirs.map((d) => `echo "== ${d}"; debugfs -R "ls -p ${d}" "${fs}" 2>/dev/null`).join('\n'));
    const present = new Map<string, string[]>();
    let current: string | null = null;
    for (const line of listing.output.split(/\r?\n/)) {
      const header = line.match(/^== (.*)$/);
      if (header) {
        current = header[1];
        present.set(current, []);
        continue;
      }
      if (current) present.get(current)!.push(...parseLsP(line));
    }

    const unlinks: string[] = [];
    for (const [dir, names] of present) {
      for (const app of names) {
        if (spec.removeApps.includes(app)) unlinks.push(`${dir}/${app}`);
      }
    }
    if (unlinks.length > 0) {
      const script = unlinks.map((p) => `unlink ${p}`).join('\n');
      const cmdFile = path.join(work, `unlink-${name}.cmds`);
      writeFileSync(cmdFile, `${script}\n`, 'utf8');
      const result = await runner.run(`debugfs -w -f "${toWslMountPath(cmdFile)}" "${fs}" 2>&1`);
      rmSync(cmdFile, { force: true });
      if (result.code !== 0) throw new Error(`debugfs failed on ${name}: ${result.output.trim()}`);
      removed.push(...unlinks.map((p) => `${name}:${p}`));
      log(`${name}: unlinked ${unlinks.length} app(s)`);
    }

    // ── Rebrand ──
    const dumped = path.join(work, `${name}.build.prop`);
    rmSync(dumped, { force: true });
    await runner.run(`debugfs -R "dump ${propPath} ${toWslMountPath(dumped)}" "${fs}" 2>/dev/null`);
    if (!existsSync(dumped)) {
      log(`${name}: no build.prop at ${propPath}`);
      continue;
    }

    const original = readFileSync(dumped, 'utf8');
    const patched = patchBuildProp(original, spec.identity, spec.displayId, isSystem ? spec.systemProps : {});
    // One block is what a freed build.prop gives back on a full volume; never ask for more.
    if (Buffer.byteLength(patched) > 4096) {
      throw new Error(`${name}: patched build.prop is ${Buffer.byteLength(patched)} bytes, over one block`);
    }
    const replacement = path.join(work, `${name}.build.prop.new`);
    writeFileSync(replacement, patched, 'utf8');

    const cmdFile = path.join(work, `prop-${name}.cmds`);
    writeFileSync(
      cmdFile,
      [
        // `write` links its destination *name* into the current directory as given — a name with a
        // slash in it becomes a file literally called "system/build.prop" in the root. So: cd first.
        `cd ${path.posix.dirname(propPath)}`,
        'rm build.prop',
        `write ${toWslMountPath(replacement)} build.prop`,
        // `write` makes a 0644 file owned by whoever ran debugfs and with no security label. The
        // original is 0600 root:root, labelled system_file; init reads it as such.
        'set_inode_field build.prop mode 0100600',
        'set_inode_field build.prop uid 0',
        'set_inode_field build.prop gid 0',
        `ea_set -f ${toWslMountPath(labelFile)} build.prop security.selinux`,
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await runner.run(`debugfs -w -f "${toWslMountPath(cmdFile)}" "${fs}" 2>&1`);
    rmSync(cmdFile, { force: true });
    rmSync(replacement, { force: true });
    rmSync(dumped, { force: true });
    if (result.code !== 0) throw new Error(`debugfs failed rewriting ${name}${propPath}: ${result.output.trim()}`);

    // Read it back: a rewrite that did not land would boot with the stock identity and nothing
    // would say so.
    await runner.run(`debugfs -R "dump ${propPath} ${toWslMountPath(dumped)}" "${fs}" 2>/dev/null`);
    const readback = existsSync(dumped) ? readFileSync(dumped, 'utf8') : '';
    rmSync(dumped, { force: true });
    if (readback !== patched) throw new Error(`${name}${propPath} did not read back as written`);
    patchedProps.push(`${name}:${propPath}`);
    log(`${name}: rebranded ${propPath}`);
  }

  // The copy of build.prop the SDK keeps beside the image, for tools that read it without booting.
  const sideProp = path.join(imageDir, 'build.prop');
  if (existsSync(sideProp)) {
    writeFileSync(sideProp, patchBuildProp(readFileSync(sideProp, 'utf8'), spec.identity, spec.displayId, spec.systemProps));
  }

  // Tell the SDK what this is.
  const sourceProps = path.join(imageDir, 'source.properties');
  if (existsSync(sourceProps)) {
    const text = readFileSync(sourceProps, 'utf8')
      .replace(/^SystemImage\.TagId=.*$/m, `SystemImage.TagId=${spec.tag}`)
      .replace(/^SystemImage\.TagDisplay=.*$/m, `SystemImage.TagDisplay=${spec.displayName}`)
      .replace(/^Pkg\.Desc=.*$/m, `Pkg.Desc=${spec.displayName} (derived from ${spec.baseTag})`);
    writeFileSync(sourceProps, text, 'utf8');
  }

  const report: BuildReport = { imageDir, verifiedBootDisabled: false, volumes, removed, patchedProps, skipped: false };
  writeFileSync(
    path.join(imageDir, 'openemu-manifest.json'),
    JSON.stringify({ ...report, spec, builtAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  log(`${spec.tag} image ready: ${removed.length} apps removed, ${patchedProps.length} build.prop files rebranded`);
  return report;
}
