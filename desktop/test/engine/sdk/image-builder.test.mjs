import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../../helpers.mjs';

const {
  OPENEMU_SPEC,
  patchBuildProp,
  rewriteFingerprint,
  parseLsP,
  findExt4Volumes,
  disableVerifiedBoot,
  syncVerifiedBootParams,
  restoreStockVbmeta,
} = loadDist('engine/sdk/image-builder.js');

const IDENTITY = OPENEMU_SPEC.identity;

test('the fingerprint keeps the build and only rewrites the three identity fields', () => {
  const stock = 'Android/sdk_phone_x86_64/generic_x86_64:11/RSR1.210722.013.A2/10067904:userdebug/test-keys';
  const rewritten = rewriteFingerprint(stock, IDENTITY);

  assert.equal(
    rewritten,
    'open-emulator/openemu_x86_64/openemu:11/RSR1.210722.013.A2/10067904:userdebug/test-keys',
  );
});

test('an unrecognised fingerprint is left alone rather than mangled', () => {
  assert.equal(rewriteFingerprint('not-a-fingerprint', IDENTITY), 'not-a-fingerprint');
});

test('patchBuildProp rewrites identity in place and never appends a duplicate', () => {
  const src = [
    'ro.product.brand=Android',
    'ro.product.system.brand=Android',
    'ro.product.model=mainline',
    'ro.build.fingerprint=Android/sdk_phone_x86_64/generic_x86_64:11/RSR1/1:userdebug/test-keys',
    'ro.build.display.id=sdk_phone_x86_64-userdebug 11 RSR1 1',
    'ro.build.product=generic_x86_64',
    'ro.something.else=kept',
    '',
  ].join('\n');

  const out = patchBuildProp(src, IDENTITY, OPENEMU_SPEC.displayId, { 'ro.openemu.image': '1' });

  assert.match(out, /^ro\.product\.brand=open-emulator$/m);
  assert.match(out, /^ro\.product\.system\.brand=open-emulator$/m);
  assert.match(out, /^ro\.product\.model=OpenEmulator One$/m);
  assert.match(out, /^ro\.build\.product=openemu$/m);
  assert.match(out, /^ro\.build\.display\.id=open-emulator Android 11 \(openemu\) RSR1\.210722\.013\.A2$/m);
  assert.match(out, /fingerprint=open-emulator\/openemu_x86_64\/openemu:11\//);
  assert.match(out, /^ro\.something\.else=kept$/m);
  assert.match(out, /^ro\.openemu\.image=1$/m);
  assert.equal((out.match(/^ro\.product\.brand=/gm) || []).length, 1, 'must rewrite, not append');
});

test('parseLsP reads debugfs -R "ls -p" names and drops . and ..', () => {
  const sample = [
    '/123/40755/0/0/./0/',
    '/124/40755/0/0/../0/',
    '/200/40755/0/0/Calendar/0/',
    '/201/40755/0/0/Settings/0/',
    '',
  ].join('\n');

  assert.deepEqual(parseLsP(sample), ['Calendar', 'Settings']);
});

test('findExt4Volumes locates a superblock by its magic, not by a hardcoded offset', async () => {
  await withTempDir(async (dir) => {
    const image = path.join(dir, 'system.img');
    const buf = Buffer.alloc(2 * 1024 * 1024);
    // Superblock at byte 1024 of the volume, volume at offset 0.
    buf.writeUInt32LE(256, 1024 + 0x04); // blocks
    buf.writeUInt32LE(0, 1024 + 0x18); // log2(block size) − 10 → 1024-byte blocks
    buf.writeUInt16LE(0xef53, 1024 + 0x38);
    buf.write('product\0', 1024 + 0x78);
    writeFileSync(image, buf);

    const volumes = findExt4Volumes(image);
    assert.equal(volumes.length, 1);
    assert.equal(volumes[0].offset, 0);
    assert.equal(volumes[0].size, 256 * 1024);
    assert.equal(volumes[0].label, 'product');
  });
});

test('syncVerifiedBootParams rewrites every digest occurrence and is a no-op when current', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'VerifiedBootParams.textproto');
    writeFileSync(
      file,
      [
        '# androidboot.vbmeta.size=6144 androidboot.vbmeta.hash_alg=sha256 androidboot.vbmeta.digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'major_version: 2',
        'param: "androidboot.vbmeta.size=6144"',
        'param: "androidboot.vbmeta.hash_alg=sha256"',
        'param: "androidboot.vbmeta.digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        '',
      ].join('\n'),
    );

    const digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    assert.equal(syncVerifiedBootParams(dir, digest), true);
    const once = readFileSync(file, 'utf8');
    assert.equal((once.match(/androidboot\.vbmeta\.digest=/g) || []).length, 2);
    assert.equal((once.match(new RegExp(digest, 'g')) || []).length, 2);
    assert.doesNotMatch(once, /aaaaaaaa/);

    assert.equal(syncVerifiedBootParams(dir, digest), false);
  });
});

test('restoreStockVbmeta copies the base vbmeta bytes and the digest file', async () => {
  await withTempDir(async (dir) => {
    const base = path.join(dir, 'base');
    const image = path.join(dir, 'image');
    mkdirSync(base);
    mkdirSync(image);

    const srcImg = path.join(base, 'system.img');
    const destImg = path.join(image, 'system.img');
    const srcFd = openSync(srcImg, 'w');
    try {
      const buf = Buffer.alloc(1024 * 1024 + 6144, 0x11);
      buf.write('AVB0', 1024 * 1024);
      buf.writeUInt32BE(0, 1024 * 1024 + 120);
      writeSync(srcFd, buf);
    } finally {
      closeSync(srcFd);
    }
    const destFd = openSync(destImg, 'w');
    try {
      const buf = Buffer.alloc(1024 * 1024 + 6144, 0x22);
      buf.write('AVB0', 1024 * 1024);
      buf.writeUInt32BE(2, 1024 * 1024 + 120);
      writeSync(destFd, buf);
    } finally {
      closeSync(destFd);
    }
    writeFileSync(path.join(base, 'VerifiedBootParams.textproto'), 'param: "androidboot.vbmeta.digest=stock"\n');
    writeFileSync(path.join(image, 'VerifiedBootParams.textproto'), 'param: "androidboot.vbmeta.digest=patched"\n');

    assert.equal(restoreStockVbmeta(image, base), true);
    const check = openSync(destImg, 'r');
    try {
      const flags = Buffer.alloc(4);
      readSync(check, flags, 0, 4, 1024 * 1024 + 120);
      assert.equal(flags.readUInt32BE(0), 0);
      const marker = Buffer.alloc(1);
      readSync(check, marker, 0, 1, 1024 * 1024 + 200);
      assert.equal(marker[0], 0x11);
    } finally {
      closeSync(check);
    }
    assert.match(readFileSync(path.join(image, 'VerifiedBootParams.textproto'), 'utf8'), /digest=stock/);
    assert.equal(restoreStockVbmeta(image, base), false);
  });
});

test('disableVerifiedBoot sets VERIFICATION_DISABLED on the vbmeta at 1 MiB', async () => {
  await withTempDir(async (dir) => {
    const image = path.join(dir, 'system.img');
    const fd = openSync(image, 'w');
    try {
      writeSync(fd, Buffer.alloc(1024 * 1024 + 256));
    } finally {
      closeSync(fd);
    }
    const patch = openSync(image, 'r+');
    try {
      writeSync(patch, Buffer.from('AVB0', 'ascii'), 0, 4, 1024 * 1024);
    } finally {
      closeSync(patch);
    }

    const result = disableVerifiedBoot(image);
    assert.equal(result.offset, 1024 * 1024);
    assert.equal(result.previousFlags, 0);

    const check = openSync(image, 'r');
    try {
      const flags = Buffer.alloc(4);
      readSync(check, flags, 0, 4, 1024 * 1024 + 120);
      assert.equal(flags.readUInt32BE(0), 0x0000_0002);
    } finally {
      closeSync(check);
    }
  });
});

test('the remove list is conservative — the launcher, Settings and SystemUI stay', () => {
  for (const keep of ['Launcher3', 'Settings', 'SystemUI', 'LatinIME', 'WebViewGoogle', 'Browser2', 'DocumentsUI']) {
    assert.ok(!OPENEMU_SPEC.removeApps.includes(keep), `${keep} must stay`);
  }
  assert.ok(OPENEMU_SPEC.removeApps.includes('Calendar'));
  assert.ok(OPENEMU_SPEC.removeApps.includes('Dialer'));
  assert.equal(OPENEMU_SPEC.tag, 'openemu');
  assert.equal(OPENEMU_SPEC.baseTag, 'default');
});
