import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { OPENEMU_RECIPE, BUILDER_REVISION, MAX_ARM_CPU_CORES, recipeHash, usedParams, validateRecipe } = loadDist('rom/recipe.js');
const { OPENEMU_COMPAT_RECIPE, COMPAT_KEPT } = loadDist('rom/recipe-compat.js');
const { ROM_RECIPES, recipeById } = loadDist('rom/recipes.js');

const WALLPAPER = Buffer.from('\x89PNG\r\n\x1a\n not really a wallpaper', 'latin1');

/** A mutable copy: the real recipe is frozen. */
const copy = () => structuredClone(OPENEMU_COMPAT_RECIPE);
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const removed = () => Object.values(OPENEMU_COMPAT_RECIPE.debloat).flat().map(basename);

test('the compat recipe validates', () => {
  assert.doesNotThrow(() => validateRecipe(OPENEMU_COMPAT_RECIPE));
});

test('it is built from the Google APIs image, the one that carries the ARM translator', () => {
  const r = OPENEMU_COMPAT_RECIPE;
  assert.equal(r.id, 'openemu-compat');
  assert.equal(r.baseTag, 'google_apis');
  assert.equal(r.apiLevel, 34);
  assert.equal(r.version, 1);
});

test("Google's identity is left alone: Play services signs a device in by its fingerprint", () => {
  assert.equal(OPENEMU_COMPAT_RECIPE.identity, null);
  // The only identity-looking prop it sets is display text.
  const props = Object.keys(OPENEMU_COMPAT_RECIPE.systemProps);
  assert.deepEqual(props.filter((key) => /fingerprint|ro\.product\./.test(key)), []);
  assert.ok(OPENEMU_COMPAT_RECIPE.systemProps['ro.build.display.id'].includes(`openemu-compat ${OPENEMU_COMPAT_RECIPE.version}`));
  assert.equal(OPENEMU_COMPAT_RECIPE.systemProps['ro.openemu.rom.version'], String(OPENEMU_COMPAT_RECIPE.version));
  assert.equal(OPENEMU_COMPAT_RECIPE.systemProps['ro.openemu.rom.recipe'], OPENEMU_COMPAT_RECIPE.id);
});

test("both of the translator's cpuinfo files are rewritten, and nothing else is", () => {
  assert.deepEqual(OPENEMU_COMPAT_RECIPE.edits, [
    { volume: 'system', path: '/system/etc/cpuinfo.arm64.txt', transform: 'arm-cpuinfo' },
    { volume: 'system', path: '/system/etc/cpuinfo.arm.txt', transform: 'arm-cpuinfo' },
  ]);
  assert.deepEqual(OPENEMU_COMPAT_RECIPE.files, []);
});

test('nothing on the kept list is removed, and each keep says why', () => {
  const gone = removed();
  for (const [name, reason] of Object.entries(COMPAT_KEPT)) {
    assert.ok(!gone.includes(name), `${name} is kept on purpose: ${reason}`);
    assert.ok(reason.length > 10, `${name} needs a reason`);
  }
  // What a game reaches by API: Play services and its framework, WebView and what it is built on,
  // Chrome for custom tabs, the keyboard.
  for (const name of ['PrebuiltGmsCore', 'GoogleServicesFramework', 'WebViewGoogle', 'TrichromeLibrary', 'Chrome',
    'LatinIMEGooglePrebuilt', 'GoogleSdkSetup', 'NetworkStackGoogle', 'DownloadProvider']) {
    assert.ok(name in COMPAT_KEPT, `${name} is on the kept list`);
  }
});

test('every provider stays, except the partner bookmarks one', () => {
  assert.deepEqual(removed().filter((name) => name.endsWith('Provider')), ['PartnerBookmarksProvider']);
});

test('nothing is removed from vendor, which holds the HALs', () => {
  assert.deepEqual(OPENEMU_COMPAT_RECIPE.debloat.vendor, []);
});

test('the heavy background Google services are what goes from product', () => {
  const gone = OPENEMU_COMPAT_RECIPE.debloat.product;
  for (const app of ['/priv-app/Velvet', '/priv-app/WellbeingPrebuilt', '/priv-app/DevicePersonalizationPrebuiltPixel2021',
    '/priv-app/GoogleDialer', '/priv-app/PrebuiltBugle', '/app/YouTube', '/app/Maps', '/app/PrebuiltGmail', '/app/Photos']) {
    assert.ok(gone.includes(app), `${app} is removed`);
  }
});

test('the shared recipe cannot be changed by a caller', () => {
  assert.throws(() => OPENEMU_COMPAT_RECIPE.debloat.product.push('/app/X'), TypeError);
  assert.throws(() => OPENEMU_COMPAT_RECIPE.edits.pop(), TypeError);
});

// ── The registry ──────────────────────────────────────────────────────────────────────────────

test('a recipe is found by its id, which is also its image tag', () => {
  assert.equal(recipeById('openemu'), OPENEMU_RECIPE);
  assert.equal(recipeById('openemu-compat'), OPENEMU_COMPAT_RECIPE);
  assert.deepEqual(Object.keys(ROM_RECIPES).sort(), ['openemu', 'openemu-compat']);
  for (const [id, recipe] of Object.entries(ROM_RECIPES)) assert.equal(recipe.id, id);
});

test('a stock image tag, or a name from the prototype, is not a recipe', () => {
  for (const tag of ['default', 'google_apis', 'google_apis_playstore', '', 'toString', 'constructor', '__proto__']) {
    assert.equal(recipeById(tag), null, tag);
  }
});

test('no two recipes build into the same image directory', () => {
  const dirs = Object.values(ROM_RECIPES).map((r) => `android-${r.apiLevel}/${r.id}`);
  assert.equal(new Set(dirs).size, dirs.length);
});

// ── Params ────────────────────────────────────────────────────────────────────────────────────

test('the core count is part of the hash: another count is another image', () => {
  const six = recipeHash(OPENEMU_COMPAT_RECIPE, {}, BUILDER_REVISION, { armCpuCores: 6 });
  assert.match(six, /^[0-9a-f]{64}$/);
  assert.equal(recipeHash(OPENEMU_COMPAT_RECIPE, {}, BUILDER_REVISION, { armCpuCores: 6 }), six);
  assert.notEqual(recipeHash(OPENEMU_COMPAT_RECIPE, {}, BUILDER_REVISION, { armCpuCores: 12 }), six);
});

test('a recipe that rewrites cpuinfo cannot be hashed, or built, without the core count', () => {
  assert.throws(() => recipeHash(OPENEMU_COMPAT_RECIPE, {}), /how many cores the guest has/);
  assert.throws(() => usedParams(OPENEMU_COMPAT_RECIPE, {}), /how many cores the guest has/);
});

test('a core count the emulator could not start a guest with is refused', () => {
  for (const bad of [0, -2, 2.5, MAX_ARM_CPU_CORES + 1, Number.NaN]) {
    assert.throws(() => usedParams(OPENEMU_COMPAT_RECIPE, { armCpuCores: bad }), /not a whole number from 1 to/);
  }
  assert.deepEqual(usedParams(OPENEMU_COMPAT_RECIPE, { armCpuCores: MAX_ARM_CPU_CORES }), { armCpuCores: MAX_ARM_CPU_CORES });
});

test('a recipe that reads no params hashes the same whatever it is given — its built image stays current', () => {
  const contents = { wallpaper: WALLPAPER };
  const plain = recipeHash(OPENEMU_RECIPE, contents);
  assert.equal(recipeHash(OPENEMU_RECIPE, contents, BUILDER_REVISION, { armCpuCores: 6 }), plain);
  assert.equal(recipeHash(OPENEMU_RECIPE, contents, BUILDER_REVISION, {}), plain);
  assert.equal(usedParams(OPENEMU_RECIPE, { armCpuCores: 6 }), undefined);
});

// ── validateRecipe: what the generalisation added ─────────────────────────────────────────────

const refuses = (mutate, message) => {
  const r = copy();
  mutate(r);
  assert.throws(() => validateRecipe(r), message);
};

test('an id or base tag that could not be a directory name is refused', () => {
  refuses((r) => { r.id = '../escape'; }, /not a safe name/);
  refuses((r) => { r.id = 'Has Space'; }, /not a safe name/);
  refuses((r) => { r.baseTag = 'google apis'; }, /base tag .* is not a safe name/);
  refuses((r) => { r.baseTag = r.id; }, /cannot be built from itself/);
});

test('an API level no emulator image has is refused', () => {
  refuses((r) => { r.apiLevel = 3; }, /API level 3/);
  refuses((r) => { r.apiLevel = 34.5; }, /API level 34.5/);
});

test('an edit is held to the same path rules as everything else', () => {
  refuses((r) => { r.edits[0].path = 'system/etc/cpuinfo.arm64.txt'; }, /is not absolute/);
  refuses((r) => { r.edits[0].path = '/etc/cpuinfo.arm64.txt'; }, /outside \/system\//);
  refuses((r) => { r.edits.push({ ...r.edits[0] }); }, /listed twice/);
  refuses((r) => { r.edits[0].transform = 'rot13'; }, /unknown transform 'rot13'/);
  refuses((r) => { r.edits[0].volume = 'boot'; }, /unknown volume/);
});

test('an edit under a directory debloat removes is refused', () => {
  refuses((r) => {
    r.debloat.system.push('/system/etc');
  }, /is edited, but debloat removes \/system\/etc/);
});

test("an edit cannot target a volume's build.prop, which is rewritten on its own", () => {
  refuses((r) => { r.edits[0].path = '/system/build.prop'; }, /is the volume's build\.prop/);
});

test('a file cannot be both edited in place and created', () => {
  refuses((r) => {
    r.files.push({ volume: 'system', path: '/system/etc', kind: 'dir', mode: 0o755, selinux: 'u:object_r:system_file:s0' });
    r.files.push({
      volume: 'system', path: '/system/etc/cpuinfo.arm64.txt', kind: 'file', mode: 0o644, selinux: 'u:object_r:system_file:s0',
    });
  }, /both edited in place and created/);
});
