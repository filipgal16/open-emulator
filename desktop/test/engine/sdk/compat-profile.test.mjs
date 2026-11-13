import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, REPO_ROOT, withTempDir } from '../../helpers.mjs';

const { loadProfile } = loadDist('engine/env-file.js');
const { avdConfigOverrides } = loadDist('engine/sdk/avd-config.js');
const { ADVANCED_FEATURES, avdPaths, createAvd, syncAdvancedFeatures } = loadDist('engine/sdk/avd.js');
const { resolveDependencies } = loadDist('engine/sdk/dependencies.js');
const { createSdkLayout, systemImagePath } = loadDist('engine/sdk/layout.js');
const { recipeForProfile, romParams } = loadDist('engine/sdk/rom-profile.js');
const { OPENEMU_COMPAT_RECIPE } = loadDist('rom/recipe-compat.js');
const { OPENEMU_RECIPE } = loadDist('rom/recipe.js');
const { isProfileId, PROFILES, PROFILE_IDS } = loadDist('../shared/device-types.js');

// The shipped files, so a change to them that the engine would misread fails here.
const ANDROID_ROOT = path.join(REPO_ROOT, 'android');
const compat = () => loadProfile(ANDROID_ROOT, 'openemu-compat');

const device = { name: 'generic', props: {}, lcdWidth: null, lcdHeight: null, lcdDensity: null };
const tuning = { cores: 7, ramMb: 4096, gpuMode: 'host', accel: 'on' };

// ── The AVD ────────────────────────────────────────────────────────────────────────────────────

test('an API 34 profile points its AVD at the API 34 image, under the recipe display name', () => {
  const config = avdConfigOverrides({ profile: compat(), device, tuning, hasSnapshot: false, snapshotName: 'default_boot' });

  assert.equal(config['image.sysdir.1'], 'system-images/android-34/openemu-compat/x86_64/');
  assert.equal(config['tag.id'], 'openemu-compat');
  assert.equal(config['tag.display'], OPENEMU_COMPAT_RECIPE.displayName);
  assert.equal(config['hw.cpu.ncore'], '7');
  assert.equal(config['hw.ramSize'], '4096');
});

test('openemu keeps the display name it always had', () => {
  const config = avdConfigOverrides({
    profile: loadProfile(ANDROID_ROOT, 'openemu'),
    device,
    tuning,
    hasSnapshot: false,
    snapshotName: 'default_boot',
  });
  assert.equal(config['image.sysdir.1'], 'system-images/android-30/openemu/x86_64/');
  assert.equal(config['tag.display'], 'open-emulator Android');
});

test('a created AVD targets its own API level and boots with GLES negotiated', async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);
    const profile = compat();
    const paths = createAvd({ layout, androidRoot: ANDROID_ROOT, profile, device, tuning, snapshotName: 'default_boot' });

    assert.match(readFileSync(paths.pointerIni, 'utf8'), /^target=android-34$/m);
    assert.match(readFileSync(paths.configIni, 'utf8'), /^image\.sysdir\.1=system-images\/android-34\/openemu-compat\/x86_64\/$/m);
    assert.equal(readFileSync(path.join(paths.dir, 'advancedFeatures.ini'), 'utf8'), ADVANCED_FEATURES);
  });
});

test('advancedFeatures.ini asks for dynamic GLES and keeps Vulkan off', () => {
  // Without GLESDynamicVersion the guest reports OpenGL ES 2.0 on -gpu host, and Unity needs 3.
  const lines = ADVANCED_FEATURES.split('\n');
  for (const line of ['GLESDynamicVersion = on', 'Vulkan = off', 'GLDirectMem = on', 'LogcatPipe = on']) {
    assert.ok(lines.includes(line), line);
  }
});

test('an AVD from an older build is brought up to date once, and then left alone', async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);
    const file = path.join(avdPaths(layout, 'Old').dir, 'advancedFeatures.ini');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, ['GLDirectMem = on', 'Vulkan = off', 'LogcatPipe = on', ''].join('\n'));

    assert.equal(syncAdvancedFeatures(layout, 'Old'), true, 'the old feature set is a change the engine must act on');
    assert.equal(readFileSync(file, 'utf8'), ADVANCED_FEATURES);
    assert.equal(syncAdvancedFeatures(layout, 'Old'), false, 'an unchanged file must not cost the snapshot again');
  });
});

// ── The download ───────────────────────────────────────────────────────────────────────────────

function remotePackage(coordinate) {
  return `<remotePackage path="${coordinate}"><archives><archive><complete>
    <size>100</size><checksum type="sha1">${'a'.repeat(40)}</checksum><url>${coordinate.replace(/;/g, '-')}.zip</url>
  </complete></archive></archives></remotePackage>`;
}

test('openemu-compat downloads the API 34 Google APIs image it is built from', async () => {
  const main = ['platform-tools', 'emulator', 'platforms;android-30', 'platforms;android-34'].map(remotePackage).join('');
  const images = ['system-images;android-30;google_apis;x86_64', 'system-images;android-34;google_apis;x86_64'].map(remotePackage).join('');
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return { text: async () => (url.includes('/sys-img/') ? images : main) };
  };

  const plan = await resolveDependencies({ profile: compat(), fetchImpl, platform: 'win32' });

  assert.deepEqual(
    plan.archives.map((a) => a.path),
    ['platform-tools', 'emulator', 'platforms;android-34', 'system-images;android-34;google_apis;x86_64'],
  );
  assert.ok(asked.some((url) => url.includes('/sys-img/google_apis/')), 'the base comes from the Google APIs manifest');
});

test('the base and the built image sit side by side under the same API level', async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);
    const profile = compat();
    const base = systemImagePath(layout, profile.baseImageTag, profile.apiLevel);
    assert.ok(base.includes(path.join('android-34', 'google_apis', 'x86_64')));
    assert.ok(!existsSync(base));
  });
});

// ── Which recipe a profile runs ────────────────────────────────────────────────────────────────

test('each shipped profile finds its recipe, and a stock one finds none', () => {
  assert.equal(recipeForProfile(compat()), OPENEMU_COMPAT_RECIPE);
  assert.equal(recipeForProfile(loadProfile(ANDROID_ROOT, 'openemu')), OPENEMU_RECIPE);
  for (const name of ['fast', 'full', 'play']) assert.equal(recipeForProfile(loadProfile(ANDROID_ROOT, name)), null, name);
});

test('a profile that disagrees with its recipe fails, naming both', () => {
  assert.throws(
    () => recipeForProfile({ ...compat(), apiLevel: 30 }),
    /says openemu-compat is API 30 built from google_apis, but its recipe is API 34 built from google_apis/,
  );
  assert.throws(
    () => recipeForProfile({ ...compat(), baseImageTag: 'default' }),
    /API 34 built from default, but its recipe is API 34 built from google_apis/,
  );
  assert.throws(() => recipeForProfile({ ...compat(), baseImageTag: null }), /built from nothing/);
});

test('a derived profile with no recipe of that name is an error, not a stock image', () => {
  assert.throws(
    () => recipeForProfile({ ...compat(), imageTag: 'openemu-nope' }),
    /built from the google_apis image, but no ROM recipe is called 'openemu-nope'/,
  );
});

test('the ROM is told the same core count the AVD is given', () => {
  assert.deepEqual(romParams(tuning), { armCpuCores: 7 });
  const config = avdConfigOverrides({ profile: compat(), device, tuning, hasSnapshot: false, snapshotName: 'default_boot' });
  assert.equal(String(romParams(tuning).armCpuCores), config['hw.cpu.ncore']);
});

// ── The picker ─────────────────────────────────────────────────────────────────────────────────

test('openemu-compat is a profile the UI can select, marked as carrying Google software', () => {
  assert.ok(isProfileId('openemu-compat'));
  assert.ok(PROFILE_IDS.includes('openemu-compat'));
  const spec = PROFILES['openemu-compat'];
  assert.equal(spec.id, 'openemu-compat');
  assert.equal(spec.proprietary, true, 'it keeps Google Play services, as full does');
  assert.equal(spec.playStore, false);
  assert.equal(spec.playStore, compat().playStore, 'the picker and the profile file agree');
});
