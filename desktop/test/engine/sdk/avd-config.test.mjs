import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../../helpers.mjs';

const { applyAvdConfig, avdConfigOverrides, emulatorArgs } = loadDist('engine/sdk/avd-config.js');

const profile = (over = {}) => ({
  name: 'fast',
  description: '',
  systemImage: 'system-images;android-30;default;x86_64',
  imageTag: 'default',
  playStore: false,
  avdName: 'OpenEmulator_API30_fast',
  ...over,
});

const device = (over = {}) => ({ name: 'generic', props: {}, lcdWidth: null, lcdHeight: null, lcdDensity: null, ...over });
const tuning = (over = {}) => ({ cores: 12, ramMb: 3072, gpuMode: 'host', accel: 'on', ...over });

const input = (over = {}) => ({
  profile: profile(),
  device: device(),
  tuning: tuning(),
  hasSnapshot: false,
  snapshotName: 'booted',
  ...over,
});

// ── config.ini rewriting ───────────────────────────────────────────────────────────────────────

test('only the keys we decide are touched; the rest of the template survives', () => {
  const template = ['# a comment', 'hw.ramSize=3072', 'hw.device.hash2=MD5:abc', 'hw.sdCard=yes'].join('\n');
  const out = applyAvdConfig(template, { 'hw.ramSize': '2048' });

  assert.match(out, /^# a comment$/m, 'comments survive');
  assert.match(out, /^hw\.device\.hash2=MD5:abc$/m, 'untouched keys survive verbatim');
  assert.match(out, /^hw\.ramSize=2048$/m);
});

test('an override for a key the template omits is appended, not dropped', () => {
  // Silently doing nothing here is how PlayStore.enabled ends up unset on a template that never
  // mentioned it.
  const out = applyAvdConfig('hw.ramSize=3072', { 'PlayStore.enabled': 'true' });

  assert.match(out, /^PlayStore\.enabled=true$/m);
});

test('the file ends with exactly one newline', () => {
  const out = applyAvdConfig('a=1\nb=2', { a: '9' });

  assert.ok(out.endsWith('\n'));
  assert.ok(!out.endsWith('\n\n'));
});

// ── The overrides themselves ───────────────────────────────────────────────────────────────────

test('the image directory and tag follow the profile, not the default', () => {
  const play = avdConfigOverrides(input({ profile: profile({ imageTag: 'google_apis_playstore', playStore: true }) }));

  assert.equal(play['image.sysdir.1'], 'system-images/android-30/google_apis_playstore/x86_64/');
  assert.equal(play['tag.id'], 'google_apis_playstore');
  assert.equal(play['PlayStore.enabled'], 'true');
});

test('a profile without Play does not claim to have it', () => {
  assert.equal(avdConfigOverrides(input()).PlayStore?.enabled, undefined);
  assert.equal(avdConfigOverrides(input())['PlayStore.enabled'], 'false');
});

test('hw.gpu.mode comes from the same tuning object as the -gpu flag', () => {
  // The invariant: if these two disagree, the snapshot records one renderer and config.ini claims
  // another, and the next warm start dies with "cannot load snapshot".
  const t = tuning({ gpuMode: 'swiftshader_indirect' });
  const config = avdConfigOverrides(input({ tuning: t }));
  const args = emulatorArgs({ avdName: 'A', tuning: t, device: device(), useSnapshot: null, headless: true });

  assert.equal(config['hw.gpu.mode'], 'swiftshader_indirect');
  assert.equal(args[args.indexOf('-gpu') + 1], 'swiftshader_indirect');
});

test('the first start is forced cold, because there is no snapshot to restore yet', () => {
  const fresh = avdConfigOverrides(input({ hasSnapshot: false }));

  assert.equal(fresh['fastboot.forceColdBoot'], 'yes');
  assert.equal(fresh['fastboot.forceChosenSnapshotBoot'], 'no');
});

test('once provisioned, the AVD points at the snapshot by name', () => {
  const ready = avdConfigOverrides(input({ hasSnapshot: true, snapshotName: 'booted' }));

  assert.equal(ready['fastboot.forceFastBoot'], 'yes');
  assert.equal(ready['fastboot.chosenSnapshotFile'], 'booted');
});

test('panel geometry is written only when the device profile states it', () => {
  assert.equal(avdConfigOverrides(input())['hw.lcd.width'], undefined, 'generic leaves the template alone');

  const pixel = avdConfigOverrides(
    input({ device: device({ lcdWidth: 1080, lcdHeight: 2340, lcdDensity: 440 }) }),
  );
  assert.equal(pixel['hw.lcd.width'], '1080');
  assert.equal(pixel['hw.lcd.density'], '440');
});

// ── The emulator command line ──────────────────────────────────────────────────────────────────

test('auto is never passed as the GPU mode', () => {
  const args = emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: null, headless: false });

  assert.notEqual(args[args.indexOf('-gpu') + 1], 'auto');
});

test('a cold boot refuses to save a snapshot on the way out', () => {
  // Without this the emulator writes default_boot while quitting; a kill arriving shortly after
  // lands mid-write and corrupts the snapshot store.
  const args = emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: null, headless: true });

  assert.ok(args.includes('-no-snapshot-load'));
  assert.ok(args.includes('-no-snapshot-save'));
});

test('a warm start passes no snapshot flags, so Quick Boot restores its own', () => {
  // `-snapshot <name>` is silently ignored by this emulator — it logs nothing and cold-boots, which
  // is why every warm start used to cost a full ~32s. Left alone, Quick Boot restores in ~2.8s.
  const args = emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: 'default_boot', headless: true });

  assert.ok(!args.includes('-snapshot'), 'naming a snapshot is what broke the warm path');
  assert.ok(!args.includes('-no-snapshot-load'), 'loading must stay enabled or there is no warm start');
  assert.ok(
    !args.includes('-no-snapshot-save'),
    'saving on exit is what keeps default_boot current; stop() protects the write by exiting cleanly',
  );
});

test('an explicit cold boot neither loads nor overwrites the saved snapshot', () => {
  // Asking for a clean boot must not cost the user their fast start next time.
  const args = emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: null, headless: true });

  assert.ok(args.includes('-no-snapshot-load'));
  assert.ok(args.includes('-no-snapshot-save'));
});

test('a headless run drops the window and the audio subsystem that has no sink', () => {
  const head = emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: null, headless: true });
  const windowed = emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: null, headless: false });

  assert.ok(head.includes('-no-window') && head.includes('-no-audio'));
  assert.ok(!windowed.includes('-no-window'), 'a native run has a real window to embed');
});

test('a writable system is an explicit flag, not the default', () => {
  const stock = emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: null, headless: true });
  const custom = emulatorArgs({
    avdName: 'A',
    tuning: tuning(),
    device: device(),
    useSnapshot: null,
    headless: true,
    writableSystem: true,
  });
  assert.ok(!stock.includes('-writable-system'));
  assert.ok(custom.includes('-writable-system'));
});

test('device identity is passed as -prop pairs, and generic passes none', () => {
  assert.equal(
    emulatorArgs({ avdName: 'A', tuning: tuning(), device: device(), useSnapshot: null, headless: true }).includes('-prop'),
    false,
  );

  const pixel = emulatorArgs({
    avdName: 'A',
    tuning: tuning(),
    device: device({ props: { 'ro.product.model': 'Pixel 5', 'ro.product.brand': 'google' } }),
    useSnapshot: null,
    headless: true,
  });
  assert.ok(pixel.includes('-prop'));
  assert.ok(pixel.includes('ro.product.model=Pixel 5'));
});
