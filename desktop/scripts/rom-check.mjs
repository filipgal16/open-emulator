#!/usr/bin/env node
// Checks a built open-emulator Android image with tools that did not write it. See
// design/openemu-rom.md, "Definition of done".
//
//   npm run rom:check               the built ROM: e2fsck -fn on all four volumes, fsck-lite,
//                                   the vbmeta flags, and the digest the guest will be told
//   npm run rom:check -- --fixtures the ext4 editor's test edits, each through e2fsck -fn
//
// `e2fsck` runs in WSL, which is a development requirement only: the app itself never needs it.
// This is the merge bar the plan sets — an image that fsck-lite passes but e2fsck does not is a
// bug in the editor, and fsck-lite cannot be the judge of the code that shares its assumptions.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => require(path.join(here, '..', 'dist', 'main', rel));

const { toWslMountPath } = dist('platform/win-paths.js');
const { Ext4Volume, BufferDisk, FileDisk } = dist('rom/ext4.js');

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL ${message}`);
};
const pass = (message) => console.log(`  ok   ${message}`);

/**
 * `wsl -e` runs the program without a login shell, so `/usr/sbin` is not on its PATH and a bare
 * `e2fsck` is not found. The path is spelled out; `/sbin` covers distributions without merged /usr.
 */
function e2fsck(target) {
  let last = null;
  for (const binary of ['/usr/sbin/e2fsck', '/sbin/e2fsck']) {
    const result = spawnSync('wsl.exe', ['-e', binary, '-fn', target], { encoding: 'utf8', windowsHide: true });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\0/g, '');
    last = { code: result.status, output };
    if (!/execvpe\(.*\) failed/.test(output)) return last;
  }
  return last;
}

function checkFixtures() {
  const LABEL = 'u:object_r:system_file:s0';
  const fixture = gunzipSync(readFileSync(path.join(here, '..', 'test', 'fixtures', 'rom', 'ext4-fixture.img.gz')));
  const cases = {
    'remove a tree that shares a block': (v) => v.removeTree('/system/app/Bloat'),
    'remove both sharers': (v) => {
      v.removeTree('/system/app/Bloat');
      v.removeTree('/system/app/Keep/Shared.apk');
    },
    'remove from a hashed directory': (v) =>
      v.removeTree('/system/etc/many/a-deliberately-long-file-name-to-fill-directory-blocks-150.txt'),
    'create a directory and a file': (v) => {
      v.mkdir('/system/media/openemu', { mode: 0o755, selinux: LABEL });
      v.createFile('/system/media/openemu/wallpaper.png', Buffer.alloc(3 * 4096 + 4, 'W'), { mode: 0o644, selinux: LABEL });
    },
    'allocate from uninitialised groups': (v) => {
      v.createFile('/system/media/big.bin', Buffer.alloc(1015 * 4096, 'Z'), { mode: 0o644, selinux: LABEL });
      v.mkdir('/system/media/lots', { mode: 0o755, selinux: LABEL });
      for (let i = 0; i < 60; i += 1) v.createFile(`/system/media/lots/f${i}`, Buffer.alloc(0), { mode: 0o644, selinux: LABEL });
    },
    'grow a directory': (v) => {
      v.mkdir('/system/media/wide', { mode: 0o755, selinux: LABEL });
      for (let i = 0; i < 40; i += 1) {
        v.createFile(`/system/media/wide/${String(i).padStart(3, '0')}-${'n'.repeat(190)}`, Buffer.from(`${i}`), { mode: 0o644, selinux: LABEL });
      }
    },
    'replace in place': (v) => v.replaceFile('/system/build.prop', Buffer.from('ro.build.display.id=openemu\n')),
    'replace by reallocating, including a shared file': (v) => {
      v.replaceFile('/system/build.prop', Buffer.alloc(3 * 4096 + 10, 'g'));
      v.replaceFile('/system/app/Keep/Shared.apk', Buffer.alloc(2 * 4096, 'R'));
    },
  };

  const dir = mkdtempSync(path.join(os.tmpdir(), 'oe-rom-check-'));
  try {
    for (const [name, edit] of Object.entries(cases)) {
      const buffer = Buffer.from(fixture);
      const volume = Ext4Volume.open(new BufferDisk(buffer), { writable: true });
      edit(volume);
      volume.flush();
      const file = path.join(dir, 'case.img');
      writeFileSync(file, buffer);
      const { code, output } = e2fsck(toWslMountPath(file));
      if (code === 0) pass(`e2fsck: ${name}`);
      else fail(`e2fsck (exit ${code}): ${name}\n${output.trim().split('\n').slice(0, 20).join('\n')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkRom() {
  const { createSdkLayout } = dist('engine/sdk/layout.js');
  const { nativeRoot } = dist('engine/factory.js');
  const { readGpt, findPartition } = dist('rom/gpt.js');
  const { readLpMetadata, findLogical } = dist('rom/lp.js');
  const { parseVbmetaHeader, parseAvbFooter, vbmetaDigest } = dist('rom/avb.js');
  const { romPaths, readManifest } = dist('rom/builder.js');

  const layout = createSdkLayout(nativeRoot(process.env.OPEN_EMULATOR_DOWNLOAD_ROOT ?? null));
  const { imageDir } = romPaths(layout.sdkRoot);
  const manifest = readManifest(imageDir);
  if (!manifest) {
    fail(`no ROM built by this builder at ${imageDir} — run npm run rom:build`);
    return;
  }
  console.log(`${manifest.recipeId} ${manifest.recipeVersion}, built ${manifest.builtAt}`);

  const image = path.join(imageDir, 'system.img');
  const fd = openSync(image, 'r');
  try {
    const read = (offset, length) => {
      const out = Buffer.alloc(length);
      readSync(fd, out, 0, length, offset);
      return out;
    };
    const gpt = readGpt(read);
    const vbmeta = findPartition(gpt, 'vbmeta');
    const superPart = findPartition(gpt, 'super');
    const lp = readLpMetadata((offset, length) => read(superPart.offset + offset, length), superPart.size);

    for (const name of ['system', 'system_ext', 'product', 'vendor']) {
      const part = findLogical(lp.partitions, name);
      const offset = superPart.offset + part.offset;
      const volume = Ext4Volume.open(new FileDisk(fd, offset, part.size, false));
      const lite = volume.verify();
      if (lite.ok) pass(`${name}: fsck-lite (${volume.freeBlocks} blocks, ${volume.freeInodes} inodes free)`);
      else fail(`${name}: fsck-lite — ${lite.problems.slice(0, 5).join('; ')}`);
      const { code, output } = e2fsck(`${toWslMountPath(image)}?offset=${offset}`);
      if (code === 0) pass(`${name}: e2fsck -fn`);
      else fail(`${name}: e2fsck -fn exited ${code}\n${output.trim().split('\n').slice(0, 20).join('\n')}`);
    }

    const vbmetaPartition = read(vbmeta.offset, vbmeta.size);
    const header = parseVbmetaHeader(vbmetaPartition);
    const top = vbmetaPartition.subarray(0, header.totalSize);
    if (header.flags === 1) pass('vbmeta flags: HASHTREE_DISABLED only');
    else fail(`vbmeta flags are ${header.flags}, expected 1`);

    const system = findLogical(lp.partitions, 'system');
    const systemOffset = superPart.offset + system.offset;
    const footer = parseAvbFooter(read(systemOffset + system.size - 64, 64), system.size);
    const chainedRegion = read(systemOffset + footer.vbmetaOffset, footer.vbmetaSize);
    const chained = chainedRegion.subarray(0, parseVbmetaHeader(chainedRegion).totalSize);
    const digest = vbmetaDigest([top, chained]);
    if (digest === manifest.vbmetaDigest) pass(`vbmeta digest matches the manifest (${digest.slice(0, 16)}…)`);
    else fail(`vbmeta digest ${digest} is not the manifest's ${manifest.vbmetaDigest}`);

    const params = readFileSync(path.join(imageDir, 'VerifiedBootParams.textproto'), 'utf8');
    if (params.includes(`androidboot.vbmeta.digest=${digest}"`)) pass('VerifiedBootParams carries that digest');
    else fail('VerifiedBootParams.textproto does not carry the image digest');
    if (/verifiedbootstate|device_state/.test(params)) fail('VerifiedBootParams declares an unlocked device');
    else pass('no unlocked/orange state on the command line');
    const size = top.length + chained.length;
    if (params.includes(`androidboot.vbmeta.size=${size}"`)) pass(`vbmeta size ${size}`);
    else fail(`VerifiedBootParams size is not ${size}`);
  } finally {
    closeSync(fd);
  }
}

if (process.argv.includes('--fixtures')) {
  console.log('ext4 editor edits through e2fsck -fn');
  checkFixtures();
} else {
  checkRom();
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
