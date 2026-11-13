import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../helpers.mjs';
import { fakeApk, makeZip } from './zip-fixture.mjs';

const {
  inspectPackageFile,
  parseBundleManifest,
  splitAbi,
  parseAbiList,
  findBase,
  selectApks,
  planExpansions,
  installTimeoutMs,
  packageFileLabel,
  PackageFileError,
} = loadDist('store/bundle.js');
const { installMultipleArgs } = loadDist('engine/sdk/adb.js');
const { PROFILES } = loadDist('../shared/device-types.js');

const XAPK_MANIFEST = {
  xapk_version: 2,
  package_name: 'com.example.game',
  name: 'Example Game',
  version_code: '160',
  version_name: '1.6.0',
  split_apks: [
    { file: 'com.example.game.apk', id: 'base' },
    { file: 'config.arm64_v8a.apk', id: 'config.arm64_v8a' },
  ],
  expansions: [
    {
      file: 'Android/obb/com.example.game/main.160.com.example.game.obb',
      install_location: 'EXTERNAL_STORAGE',
      install_path: 'Android/obb/com.example.game/main.160.com.example.game.obb',
    },
  ],
};

function named(...names) {
  return names.map((name, index) => ({ name, size: 100 + index }));
}

// ── Detection ────────────────────────────────────────────────────────────────────────────────

test('a plain APK is recognised by the manifest at its root', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'app.apk');
    writeFileSync(file, fakeApk('app'));
    assert.deepEqual(inspectPackageFile(file), { kind: 'apk' });
  });
});

test('an XAPK is a bundle, and its manifest is read', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'game.xapk');
    writeFileSync(
      file,
      makeZip([
        ['com.example.game.apk', fakeApk('base')],
        ['config.arm64_v8a.apk', fakeApk('arm64')],
        ['manifest.json', JSON.stringify(XAPK_MANIFEST)],
        ['icon.png', 'png'],
        ['Android/obb/com.example.game/main.160.com.example.game.obb', 'obb data'],
      ]),
    );

    const found = inspectPackageFile(file);

    assert.equal(found.kind, 'bundle');
    assert.deepEqual(found.apks.map((entry) => entry.name), ['com.example.game.apk', 'config.arm64_v8a.apk']);
    assert.equal(found.manifest.packageName, 'com.example.game');
    assert.equal(found.entries.length, 5, 'every member is kept, for finding the OBB later');
  });
});

test('an .apks from SAI is a bundle with no manifest', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'app.apks');
    writeFileSync(file, makeZip([['base.apk', fakeApk('base')], ['split_config.x86_64.apk', fakeApk('x86_64')], ['meta.sai_v2.json', '{}']]));

    const found = inspectPackageFile(file);

    assert.equal(found.kind, 'bundle');
    assert.equal(found.manifest, null);
    assert.equal(found.apks.length, 2);
  });
});

test('the contents decide, not the name: a bundle renamed to .apk is still a bundle', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'renamed.apk');
    writeFileSync(file, makeZip([['base.apk', fakeApk('base')]]));
    assert.equal(inspectPackageFile(file).kind, 'bundle');

    const apkAsXapk = path.join(dir, 'plain.xapk');
    writeFileSync(apkAsXapk, fakeApk('plain'));
    assert.equal(inspectPackageFile(apkAsXapk).kind, 'apk');
  });
});

test('junk is refused with a sentence a person can read', async () => {
  await withTempDir(async (dir) => {
    const text = path.join(dir, 'notes.xapk');
    writeFileSync(text, 'not a zip at all');
    assert.throws(() => inspectPackageFile(text), (err) => err instanceof PackageFileError && /isn’t an Android app/.test(err.message));

    const zipOfPhotos = path.join(dir, 'photos.apks');
    writeFileSync(zipOfPhotos, makeZip([['one.jpg', 'x'], ['nested/inner.apk', 'not top level']]));
    assert.throws(() => inspectPackageFile(zipOfPhotos), PackageFileError, 'an APK in a subfolder does not make a bundle');

    const wrongType = path.join(dir, 'setup.exe');
    writeFileSync(wrongType, makeZip([['base.apk', fakeApk('base')]]));
    assert.throws(() => inspectPackageFile(wrongType), /Only Android app files/);

    assert.throws(() => inspectPackageFile(path.join(dir, 'missing.apk')), PackageFileError);
  });
});

test('a file label drops whichever app extension it has', () => {
  assert.equal(packageFileLabel('C:\\Downloads\\My Game.xapk'), 'My Game');
  assert.equal(packageFileLabel('/tmp/thing.APKS'), 'thing');
  assert.equal(packageFileLabel('/tmp/plain.apk'), 'plain');
  assert.equal(packageFileLabel('/tmp/archive.zip'), 'archive.zip');
});

// ── Manifest ─────────────────────────────────────────────────────────────────────────────────

test('an XAPK v2 manifest is parsed into what the installer needs', () => {
  const manifest = parseBundleManifest(JSON.stringify(XAPK_MANIFEST));
  assert.deepEqual(manifest, {
    packageName: 'com.example.game',
    name: 'Example Game',
    versionName: '1.6.0',
    versionCode: 160,
    splits: [
      { file: 'com.example.game.apk', id: 'base' },
      { file: 'config.arm64_v8a.apk', id: 'config.arm64_v8a' },
    ],
    expansions: [
      {
        file: 'Android/obb/com.example.game/main.160.com.example.game.obb',
        installPath: 'Android/obb/com.example.game/main.160.com.example.game.obb',
      },
    ],
  });
});

test('a manifest is read tolerantly: a byte-order mark, missing fields and wrong types', () => {
  const sparse = parseBundleManifest('\uFEFF{"package_name": "com.a.b", "split_apks": [{"file": 3}, null, {"file": "x.apk", "id": "base"}], "expansions": "no"}');
  assert.equal(sparse.packageName, 'com.a.b');
  assert.equal(sparse.versionCode, null);
  assert.deepEqual(sparse.splits, [{ file: 'x.apk', id: 'base' }]);
  assert.deepEqual(sparse.expansions, []);

  assert.equal(parseBundleManifest('{not json'), null);
  assert.equal(parseBundleManifest('[1, 2]'), null);
});

// ── Split selection ──────────────────────────────────────────────────────────────────────────

test('native-code splits are recognised under both prefixes; others are not', () => {
  assert.equal(splitAbi('config.arm64_v8a.apk'), 'arm64-v8a');
  assert.equal(splitAbi('split_config.armeabi_v7a.apk'), 'armeabi-v7a');
  assert.equal(splitAbi('config.x86_64.apk'), 'x86_64');
  assert.equal(splitAbi('config.x86.apk'), 'x86');
  assert.equal(splitAbi('config.en.apk'), null);
  assert.equal(splitAbi('config.xxhdpi.apk'), null);
  assert.equal(splitAbi('base.apk'), null);
});

test('the guest’s processor list is read in its own order', () => {
  assert.deepEqual(parseAbiList('x86_64,x86,arm64-v8a,armeabi-v7a,armeabi\r'), ['x86_64', 'x86', 'arm64-v8a', 'armeabi-v7a', 'armeabi']);
  assert.deepEqual(parseAbiList(null), []);
  assert.deepEqual(parseAbiList(''), []);
});

const UNIVERSAL = named(
  'com.example.game.apk',
  'config.arm64_v8a.apk',
  'config.armeabi_v7a.apk',
  'config.x86_64.apk',
  'config.en.apk',
  'config.xxhdpi.apk',
  'asset_pack_levels.apk',
);

test('x86_64,arm64-v8a: the native x86_64 code wins, and every other split comes along', () => {
  const picked = selectApks(UNIVERSAL, null, ['x86_64', 'arm64-v8a']);
  assert.equal(picked.base, 'com.example.game.apk');
  assert.equal(picked.abi, 'x86_64');
  assert.deepEqual(picked.apks, [
    'com.example.game.apk',
    'asset_pack_levels.apk',
    'config.en.apk',
    'config.xxhdpi.apk',
    'config.x86_64.apk',
  ]);
});

const ARM_ONLY = named('base.apk', 'split_config.armeabi_v7a.apk', 'split_config.arm64_v8a.apk', 'split_config.ja.apk');

test('x86_64,x86,arm64-v8a,armeabi-v7a,armeabi: an ARM-only bundle gets the translator’s first choice', () => {
  const picked = selectApks(ARM_ONLY, null, ['x86_64', 'x86', 'arm64-v8a', 'armeabi-v7a', 'armeabi']);
  assert.equal(picked.abi, 'arm64-v8a');
  assert.deepEqual(picked.apks, ['base.apk', 'split_config.ja.apk', 'split_config.arm64_v8a.apk'], 'only one processor type');
});

test('x86_64,x86: an ARM-only bundle is refused before anything is unpacked, naming the fix', () => {
  assert.throws(
    () => selectApks(ARM_ONLY, null, ['x86_64', 'x86']),
    (err) =>
      err instanceof PackageFileError &&
      err.message.includes('ARM phones') &&
      err.message.includes(`“${PROFILES['openemu-compat'].label}”`) &&
      !/abi|split|adb/i.test(err.message),
  );
});

test('a bundle with no native code installs on any guest', () => {
  const picked = selectApks(named('base.apk', 'config.de.apk'), null, ['x86_64']);
  assert.equal(picked.abi, null);
  assert.deepEqual(picked.apks, ['base.apk', 'config.de.apk']);
});

test('a bundle built for a non-ARM processor the guest lacks gets a different sentence', () => {
  assert.throws(() => selectApks(named('base.apk', 'config.mips.apk'), null, ['x86_64']), /different kind of phone/);
});

test('the base is found by manifest, then <package>.apk, then base.apk, then by elimination', () => {
  const manifest = parseBundleManifest(JSON.stringify({ package_name: 'com.p', split_apks: [{ file: 'odd-name.apk', id: 'base' }] }));
  assert.equal(findBase(named('odd-name.apk', 'com.p.apk', 'base.apk'), manifest), 'odd-name.apk');

  const byPackage = parseBundleManifest(JSON.stringify({ package_name: 'com.p' }));
  assert.equal(findBase(named('base.apk', 'com.p.apk'), byPackage), 'com.p.apk');

  assert.equal(findBase(named('extra.apk', 'base.apk'), null), 'base.apk');

  // Neither convention: whatever is not a config split, preferring a package-shaped name, then a
  // name without split_.
  assert.equal(findBase(named('config.arm64_v8a.apk', 'split_assets.apk', 'game.apk'), null), 'game.apk');
  assert.equal(
    findBase([{ name: 'com.studio.game.apk', size: 10 }, { name: 'asset_pack.apk', size: 9000 }], null),
    'com.studio.game.apk',
  );
  assert.equal(
    findBase([{ name: 'small.apk', size: 10 }, { name: 'large.apk', size: 9000 }, { name: 'config.en.apk', size: 1 }], null),
    'large.apk',
    'the largest when several remain',
  );

  // A manifest naming a file the archive does not have is ignored rather than trusted.
  const stale = parseBundleManifest(JSON.stringify({ split_apks: [{ file: 'gone.apk', id: 'base' }] }));
  assert.equal(findBase(named('base.apk'), stale), 'base.apk');

  assert.equal(findBase(named('config.arm64_v8a.apk', 'config.en.apk'), null), null);
  assert.throws(() => selectApks(named('config.arm64_v8a.apk'), null, ['arm64-v8a']), /doesn’t contain the app itself/);
});

// ── Install plumbing ─────────────────────────────────────────────────────────────────────────

test('install-multiple is one call: replace, grant permissions, every file', () => {
  assert.deepEqual(installMultipleArgs(['C:\\x\\0.apk', 'C:\\x y\\1.apk']), [
    'install-multiple',
    '-r',
    '-g',
    'C:\\x\\0.apk',
    'C:\\x y\\1.apk',
  ]);
});

test('the install timeout grows with size, between a floor and a ceiling', () => {
  assert.equal(installTimeoutMs(5 * 1024 * 1024), 10 * 60_000, 'a small app gets the floor');
  const huge = installTimeoutMs(60 * 1024 ** 3);
  assert.equal(huge, 60 * 60_000, 'capped');
  const mid = installTimeoutMs(8 * 1024 ** 3);
  assert.ok(mid > 10 * 60_000 && mid < 60 * 60_000, `proportional in between (got ${mid})`);
  assert.ok(installTimeoutMs(2.7 * 1024 ** 3) >= 4 * 76_000, 'well clear of the 76 s a 2.7 GB push measured');
});

test('OBB destinations are built only from names that pass a strict check', async () => {
  await withTempDir(async (dir) => {
    const manifest = {
      package_name: 'com.example.game',
      expansions: [
        { file: 'Android/obb/com.example.game/main.1.com.example.game.obb', install_path: 'Android/obb/com.example.game/main.1.com.example.game.obb' },
        { file: 'Android/obb/x/patch.obb', install_path: 'Android/obb/x/../../evil;rm -rf.obb' },
        { file: 'not-in-archive.obb', install_path: 'Android/obb/com.example.game/missing.obb' },
      ],
    };
    const file = path.join(dir, 'game.xapk');
    writeFileSync(
      file,
      makeZip([
        ['com.example.game.apk', fakeApk('base')],
        ['manifest.json', JSON.stringify(manifest)],
        ['Android/obb/com.example.game/main.1.com.example.game.obb', 'main'],
        ['Android/obb/x/patch.obb', 'patch'],
      ]),
    );
    const bundle = inspectPackageFile(file);

    const plans = planExpansions(bundle, 'com.example.game');
    assert.deepEqual(
      plans.map((plan) => plan.guestPath),
      ['/sdcard/Android/obb/com.example.game/main.1.com.example.game.obb'],
    );
    assert.deepEqual(planExpansions(bundle, 'not a package; reboot'), []);
    assert.deepEqual(planExpansions(bundle, null), []);
  });
});
