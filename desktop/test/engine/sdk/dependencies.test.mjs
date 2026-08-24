import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../../helpers.mjs';

const { cleanup, formatBytes, resolveDependencies } = loadDist('engine/sdk/dependencies.js');
const { extractZip, isExtractorAvailable } = loadDist('engine/sdk/unzip.js');
const { createSdkLayout } = loadDist('engine/sdk/layout.js');

const opts = { timeout: 60_000 };

test('the extractor this platform needs is present', opts, async () => {
  // A preflight worth having: without it, setup downloads two gigabytes and then discovers it
  // cannot unpack any of it.
  assert.equal(await isExtractorAvailable(), true);
});

/**
 * Builds a genuine PKZIP archive, stored (method 0) so no deflate is involved.
 *
 * Written out by hand rather than shelling to a zip tool, for two reasons. The obvious one is that
 * the fixture then depends on nothing. The real one is that `tar -a -cf out.zip` does **not**
 * produce a zip — it writes a tar with a .zip name, and bsdtar reads it back happily by
 * auto-detection. A test built that way passes while proving nothing about whether the extractor
 * can read Google's actual archives.
 */
function makeZip(entries) {
  const files = entries.map(([name, text]) => {
    const data = Buffer.from(text, 'utf8');
    return { name: Buffer.from(name, 'utf8'), data, crc: zlib.crc32(data) >>> 0 };
  });

  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); // "PK\x03\x04"
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 6);
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt32LE(file.crc, 14);
    head.writeUInt32LE(file.data.length, 18);
    head.writeUInt32LE(file.data.length, 22);
    head.writeUInt16LE(file.name.length, 26);
    const chunk = Buffer.concat([head, file.name, file.data]);
    local.push(chunk);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // "PK\x01\x02"
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt32LE(file.crc, 16);
    dir.writeUInt32LE(file.data.length, 20);
    dir.writeUInt32LE(file.data.length, 24);
    dir.writeUInt16LE(file.name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, file.name]));

    offset += chunk.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // "PK\x05\x06"
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, centralBuf, end]);
}

test('a real zip round-trips through the extractor', opts, async () => {
  await withTempDir(async (dir) => {
    const zip = path.join(dir, 'archive.zip');
    writeFileSync(zip, makeZip([['top.txt', 'top level'], ['nested/deep.txt', 'nested content']]));

    // Guard the fixture itself: 'PK' is what makes this a zip rather than a tar in disguise.
    assert.equal(readFileSync(zip).subarray(0, 2).toString('ascii'), 'PK');

    const out = path.join(dir, 'out');
    await extractZip(zip, out);

    assert.equal(readFileSync(path.join(out, 'top.txt'), 'utf8'), 'top level');
    assert.equal(
      readFileSync(path.join(out, 'nested', 'deep.txt'), 'utf8'),
      'nested content',
      'nested paths must survive — the SDK archives are all nested',
    );
  });
});

test('extracting a missing archive fails clearly', opts, async () => {
  await assert.rejects(() => extractZip('C:/nope/absent.zip', 'C:/nope/out'), /archive not found/);
});

test('cleanup removes archives, scratch dirs, and orphaned part files', opts, async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);
    mkdirSync(path.join(dir, 'downloads'), { recursive: true });
    mkdirSync(path.join(layout.sdkRoot, '.temp'), { recursive: true });
    mkdirSync(path.join(layout.sdkRoot, 'platform-tools'), { recursive: true });

    writeFileSync(path.join(dir, 'downloads', 'emulator.zip'), Buffer.alloc(2048));
    writeFileSync(path.join(layout.sdkRoot, '.temp', 'junk'), Buffer.alloc(1024));
    writeFileSync(path.join(dir, 'downloads', 'half.zip.part'), Buffer.alloc(512));
    // The extracted product must survive — this is the whole point of the operation.
    writeFileSync(path.join(layout.sdkRoot, 'platform-tools', 'adb.exe'), Buffer.alloc(64));

    const report = cleanup(layout);

    assert.ok(!existsSync(path.join(dir, 'downloads')), 'archives removed');
    assert.ok(!existsSync(path.join(layout.sdkRoot, '.temp')), 'scratch removed');
    assert.ok(existsSync(path.join(layout.sdkRoot, 'platform-tools', 'adb.exe')), 'extracted SDK kept');
    assert.ok(report.bytesFreed >= 2048 + 1024, `freed ${report.bytesFreed} bytes`);
  });
});

test('cleanup on an untouched root is a no-op, not an error', opts, async () => {
  await withTempDir(async (dir) => {
    const report = cleanup(createSdkLayout(dir));
    assert.deepEqual(report.removed, []);
    assert.equal(report.bytesFreed, 0);
  });
});

test('the JRE is only removed when explicitly asked for', opts, async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);
    mkdirSync(layout.jreRoot, { recursive: true });
    writeFileSync(path.join(layout.jreRoot, 'java.exe'), Buffer.alloc(16));

    cleanup(layout);
    assert.ok(existsSync(layout.jreRoot), 'kept by default');

    cleanup(layout, { dropJre: true });
    assert.ok(!existsSync(layout.jreRoot), 'removed on request');
  });
});

test('a missing package names the coordinate rather than blaming the network', opts, async () => {
  const emptyManifest = '<?xml version="1.0"?><sdk:sdk-repository></sdk:sdk-repository>';
  const fetchImpl = async () => ({ text: async () => emptyManifest });

  await assert.rejects(
    () =>
      resolveDependencies({
        profile: { imageTag: 'default', avdName: 'x', name: 'fast', description: '', systemImage: '', playStore: false },
        fetchImpl,
        platform: 'win32',
      }),
    /has no package "platform-tools"/,
  );
});

test('byte sizes read for humans', () => {
  assert.equal(formatBytes(676 * 1024 * 1024), '676 MB');
  assert.equal(formatBytes(1.2 * 1024 ** 3), '1.2 GB');
});

test('a zip whose top-level directory has a different name is renamed into place', opts, async () => {
  await withTempDir(async (dir) => {
    const { extractInto } = loadDist('engine/sdk/dependencies.js');

    // Exactly the shape of the platform archive: the zip contains `android-11/`, but the SDK
    // layout requires `platforms/android-30/`. A real run put it at platforms/android-30/android-11
    // and the emulator would never have found it.
    const zip = path.join(dir, 'platform.zip');
    writeFileSync(zip, makeZip([['android-11/android.jar', 'classes'], ['android-11/source.properties', 'k=v']]));

    const dest = path.join(dir, 'sdk', 'platforms', 'android-30');
    await extractInto(zip, dest);

    assert.equal(readFileSync(path.join(dest, 'android.jar'), 'utf8'), 'classes');
    assert.ok(!existsSync(path.join(dest, 'android-11')), 'the redundant level must not survive');
  });
});

test('a system image lands at the path the emulator looks for, not one level deeper', opts, async () => {
  await withTempDir(async (dir) => {
    const { extractInto } = loadDist('engine/sdk/dependencies.js');
    const { createSdkLayout, systemImagePath } = loadDist('engine/sdk/layout.js');

    const zip = path.join(dir, 'image.zip');
    writeFileSync(zip, makeZip([['x86_64/system.img', 'IMG'], ['x86_64/build.prop', 'ro.x=1']]));

    const layout = createSdkLayout(dir);
    await extractInto(zip, path.join(layout.sdkRoot, 'system-images', 'android-30', 'default', 'x86_64'));

    // The doubled x86_64/x86_64 this guards against is what a real acquisition actually produced.
    assert.ok(existsSync(systemImagePath(layout, 'default')), 'system.img is not where the code looks for it');
  });
});

test('extraction leaves no staging directory behind, even on failure', opts, async () => {
  await withTempDir(async (dir) => {
    const { extractInto } = loadDist('engine/sdk/dependencies.js');
    const dest = path.join(dir, 'out');

    await assert.rejects(() => extractInto(path.join(dir, 'missing.zip'), dest));
    assert.ok(!existsSync(`${dest}.staging`), 'a failed extraction must not leave scratch behind');
  });
});
