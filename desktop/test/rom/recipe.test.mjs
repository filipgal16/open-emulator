import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { OPENEMU_RECIPE, KEPT, BUILDER_REVISION, recipeHash, validateRecipe } = loadDist('rom/recipe.js');

const WALLPAPER = Buffer.from('\x89PNG\r\n\x1a\n not really a wallpaper', 'latin1');
const contents = { wallpaper: WALLPAPER };

/** A mutable copy: the real recipe is frozen. */
const copy = () => structuredClone(OPENEMU_RECIPE);

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

test('the openemu recipe validates', () => {
  assert.doesNotThrow(() => validateRecipe(OPENEMU_RECIPE));
});

test('the recipe carries exactly the plan\'s identity, props and files', () => {
  const r = OPENEMU_RECIPE;
  assert.equal(r.id, 'openemu');
  assert.equal(r.version, 1);
  assert.equal(r.displayName, 'open-emulator Android');
  assert.equal(r.baseTag, 'default');
  assert.equal(r.apiLevel, 30);
  assert.deepEqual(r.identity, {
    brand: 'open-emulator',
    manufacturer: 'open-emulator',
    model: 'OpenEmulator One',
    name: 'openemu_x86_64',
    device: 'openemu',
    displayId: 'open-emulator Android 11 (openemu 1)',
    description: 'openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys',
    buildProduct: 'openemu',
  });
  assert.deepEqual(r.buildPropPath, {
    system: '/system/build.prop', system_ext: '/build.prop', product: '/build.prop', vendor: '/build.prop',
  });
  assert.deepEqual(r.systemProps, {
    'ro.openemu.rom': '1',
    'ro.openemu.rom.version': '1',
    'ro.config.wallpaper': '/system/media/openemu/wallpaper.png',
  });
  assert.deepEqual(r.files, [
    { volume: 'system', path: '/system/media', kind: 'dir', mode: 0o755, selinux: 'u:object_r:system_file:s0' },
    { volume: 'system', path: '/system/media/openemu', kind: 'dir', mode: 0o755, selinux: 'u:object_r:system_file:s0' },
    {
      volume: 'system', path: '/system/media/openemu/wallpaper.png', kind: 'file', mode: 0o644,
      selinux: 'u:object_r:system_file:s0', source: 'wallpaper',
    },
  ]);
});

test('the build number and the version prop follow the version', () => {
  assert.ok(OPENEMU_RECIPE.identity.displayId.includes(`openemu ${OPENEMU_RECIPE.version}`));
  assert.equal(OPENEMU_RECIPE.systemProps['ro.openemu.rom.version'], String(OPENEMU_RECIPE.version));
});

test('debloat is the plan\'s table, as in-volume paths', () => {
  const d = OPENEMU_RECIPE.debloat;
  const sorted = (list) => [...list].sort();
  assert.deepEqual(sorted(d.system), sorted([
    ...['BasicDreams', 'BluetoothMidiService', 'EasterEgg', 'LiveWallpapersPicker', 'NfcNci',
      'PartnerBookmarksProvider', 'PresencePolling', 'PrintRecommendationService', 'RcsService',
      'SimAppDialog', 'Stk', 'Traceur'].map((n) => `/system/app/${n}`),
    ...['BuiltInPrintService', 'CallLogBackup', 'CellBroadcastLegacyApp', 'DynamicSystemInstallationService',
      'MusicFX', 'ONS', 'Tag'].map((n) => `/system/priv-app/${n}`),
  ]));
  assert.deepEqual(d.system_ext, ['/priv-app/EmergencyInfo']);
  assert.deepEqual(sorted(d.product), sorted([
    ...['Calendar', 'DeskClock', 'Gallery2', 'Music', 'PhotoTable', 'messaging'].map((n) => `/app/${n}`),
    '/priv-app/Contacts',
    '/priv-app/Dialer',
  ]));
  assert.deepEqual(d.vendor, []);
});

test('system paths live under /system/, the other volumes at their own root', () => {
  // The system volume is system-as-root; the others are mounted at /product etc. and have no
  // such prefix inside. Getting this backwards removes nothing and still reports success.
  for (const p of OPENEMU_RECIPE.debloat.system) assert.match(p, /^\/system\/(app|priv-app)\/[^/]+$/);
  for (const volume of ['system_ext', 'product', 'vendor']) {
    for (const p of OPENEMU_RECIPE.debloat[volume]) assert.match(p, /^\/(app|priv-app)\/[^/]+$/, `${volume}: ${p}`);
  }
});

test('nothing on the kept list is removed, and each keep says why', () => {
  const removed = Object.values(OPENEMU_RECIPE.debloat).flat().map(basename);
  for (const [name, reason] of Object.entries(KEPT)) {
    assert.ok(!removed.includes(name), `${name} is kept on purpose: ${reason}`);
    assert.ok(reason.length > 10, `${name} needs a reason`);
  }
  for (const name of ['BookmarkProvider', 'PrintSpooler', 'Camera2', 'WallpaperPicker', 'WallpaperCropper',
    'WallpaperBackup', 'CalendarProvider', 'ContactsProvider', 'TelephonyProvider', 'TeleService', 'Telecom']) {
    assert.ok(name in KEPT, `${name} is on the kept list`);
  }
  // Every provider stays, except the partner bookmarks one, which serves nothing on this image.
  assert.deepEqual(removed.filter((n) => n.endsWith('Provider')), ['PartnerBookmarksProvider']);
});

test('the shared recipe cannot be changed by a caller', () => {
  assert.throws(() => OPENEMU_RECIPE.debloat.system.push('/system/app/X'), TypeError);
  assert.throws(() => { OPENEMU_RECIPE.identity.model = 'x'; }, TypeError);
});

// ── recipeHash ────────────────────────────────────────────────────────────────────────────────

test('the hash is stable: same recipe, same content, same hash', () => {
  const a = recipeHash(OPENEMU_RECIPE, contents);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(recipeHash(OPENEMU_RECIPE, contents), a);
  assert.equal(recipeHash(copy(), { wallpaper: Buffer.from(WALLPAPER) }), a, 'a copy with equal bytes hashes the same');
  assert.equal(recipeHash(OPENEMU_RECIPE, contents, BUILDER_REVISION), a, 'the default is BUILDER_REVISION');
});

test('the hash ignores key order but not the order of files', () => {
  const r = copy();
  const reordered = { ...r, identity: Object.fromEntries(Object.entries(r.identity).reverse()) };
  const reversedKeys = Object.fromEntries(Object.entries(reordered).reverse());
  assert.equal(recipeHash(reversedKeys, contents), recipeHash(r, contents));

  const swapped = copy();
  swapped.files.reverse();
  assert.notEqual(recipeHash(swapped, contents), recipeHash(r, contents), 'files are created in order');
});

test('the hash changes with a debloat entry', () => {
  const base = recipeHash(OPENEMU_RECIPE, contents);

  const fewer = copy();
  fewer.debloat.product.pop();
  assert.notEqual(recipeHash(fewer, contents), base);

  const renamed = copy();
  renamed.debloat.system[0] = '/system/app/SomethingElse';
  assert.notEqual(recipeHash(renamed, contents), base);

  const moved = copy();
  moved.debloat.vendor.push(moved.debloat.product.pop());
  assert.notEqual(recipeHash(moved, contents), base, 'the same path on another volume is another file');
});

test('the hash changes with the version, the builder revision and the wallpaper bytes', () => {
  const base = recipeHash(OPENEMU_RECIPE, contents);

  const bumped = copy();
  bumped.version += 1;
  assert.notEqual(recipeHash(bumped, contents), base);

  assert.notEqual(recipeHash(OPENEMU_RECIPE, contents, BUILDER_REVISION + 1), base);

  const repainted = Buffer.from(WALLPAPER);
  repainted[repainted.length - 1] ^= 1;
  assert.notEqual(recipeHash(OPENEMU_RECIPE, { wallpaper: repainted }), base);
});

test('content the recipe does not use does not change the hash', () => {
  assert.equal(
    recipeHash(OPENEMU_RECIPE, { ...contents, bootanimation: Buffer.from('x') }),
    recipeHash(OPENEMU_RECIPE, contents),
  );
});

test('a missing content is an error, not a hash of nothing', () => {
  assert.throws(() => recipeHash(OPENEMU_RECIPE, {}), /wallpaper\.png is built from 'wallpaper'/);
  assert.throws(() => recipeHash(OPENEMU_RECIPE, { wallpaper: 'not a buffer' }), /no content/);
});

// ── validateRecipe refusals ───────────────────────────────────────────────────────────────────

const refuses = (mutate, message) => {
  const r = copy();
  mutate(r);
  assert.throws(() => validateRecipe(r), message);
};

test('a relative path is refused', () => {
  refuses((r) => r.debloat.product.push('app/Foo'), /not absolute/);
  refuses((r) => { r.files[0].path = 'system/media/openemu'; }, /not absolute/);
});

test('a path that is not normalised is refused', () => {
  for (const p of ['/system/app/../priv-app/X', '/system/app//X', '/system/app/X/', '/system/./app/X']) {
    refuses((r) => r.debloat.system.push(p), /not normalised/);
  }
});

test('a system-volume path outside /system/ is refused', () => {
  refuses((r) => r.debloat.system.push('/app/Calendar'), /outside \/system\//);
  refuses((r) => r.debloat.system.push('/system'), /outside \/system\//);
  refuses((r) => { r.buildPropPath.system = '/build.prop'; }, /outside \/system\//);
});

test('a /system/ path on another volume is refused', () => {
  refuses((r) => r.debloat.product.push('/system/app/Calendar'), /mounted at its own root/);
  refuses((r) => { r.buildPropPath.vendor = '/system/build.prop'; }, /mounted at its own root/);
});

test('a debloat path that is also a file path is refused', () => {
  refuses((r) => r.debloat.system.push('/system/media/openemu/wallpaper.png'), /both removed by debloat and created/);
  refuses((r) => r.debloat.system.push('/system/media/openemu'), /both removed by debloat and created/);
  refuses((r) => r.debloat.system.push('/system/media'), /both removed by debloat and created/);  refuses((r) => r.debloat.product.push('/build.prop'), /is rewritten, but debloat removes/);
});

test('a file whose parent is neither a stock directory nor declared first is refused', () => {
  refuses((r) => r.files.shift(), /parent \/system\/media is neither/);
  refuses((r) => r.files.reverse(), /parent \/system\/media\/openemu is neither/);
  refuses((r) => { r.files[2].path = '/system/fonts/openemu.png'; }, /parent \/system\/fonts is neither/);
  refuses((r) => { r.files[0].kind = 'file'; }, /parent \/system\/media is neither/);
});

test('duplicate paths are refused', () => {
  refuses((r) => r.debloat.system.push(r.debloat.system[0]), /listed twice/);
  refuses((r) => r.files.push({ ...r.files[1] }), /listed twice/);
});

test('the same in-volume path on two different volumes is not a duplicate', () => {
  const r = copy();
  r.debloat.system_ext.push('/priv-app/Contacts');
  assert.doesNotThrow(() => validateRecipe(r));
});

test('identity values that would break a fingerprint are refused', () => {
  refuses((r) => { r.identity.brand = 'open/emulator'; }, /identity\.brand/);
  refuses((r) => { r.identity.name = 'openemu:x86_64'; }, /identity\.name/);
  refuses((r) => { r.identity.device = 'open emu'; }, /identity\.device/);
  refuses((r) => { r.identity.model = 'One\nTwo'; }, /identity\.model/);
});

test('modes with type bits, content on a directory and a missing label are refused', () => {
  refuses((r) => { r.files[1].mode = 0o100644; }, /not permission bits/);
  refuses((r) => { r.files[0].source = 'wallpaper'; }, /directory and cannot have content/);
  refuses((r) => { r.files[1].selinux = ''; }, /not an SELinux file label/);
});

test('a system prop that cannot be written as a line is refused', () => {
  refuses((r) => { r.systemProps['ro.bad key'] = '1'; }, /property name/);
  refuses((r) => { r.systemProps['ro.openemu.rom'] = '1\nro.debuggable=1'; }, /line break/);
});
