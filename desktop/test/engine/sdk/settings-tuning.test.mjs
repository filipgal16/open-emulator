import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDist, REPO_ROOT, withTempDir } from '../../helpers.mjs';

const { loadProfile } = loadDist('engine/env-file.js');
const { createAvd } = loadDist('engine/sdk/avd.js');
const { tuneForHost } = loadDist('engine/sdk/host.js');
const { createSdkLayout, avdDir, avdState } = loadDist('engine/sdk/layout.js');
const { SdkEngine } = loadDist('engine/sdk/sdk-engine.js');

const ANDROID_ROOT = path.join(REPO_ROOT, 'android');
const openemu = () => loadProfile(ANDROID_ROOT, 'openemu');
const compat = () => loadProfile(ANDROID_ROOT, 'openemu-compat');

/** What the engine itself would decide on the machine running the test, with nothing set. */
const facts = { cpus: os.cpus().length, totalRamMb: Math.round(os.totalmem() / 1048576), accelerated: true, hasWindow: true };
const measured = tuneForHost(facts);

function engineIn(dir, settings = {}) {
  return new SdkEngine({
    layout: createSdkLayout(dir),
    androidRoot: ANDROID_ROOT,
    profile: 'openemu',
    accelerated: () => true,
    windowed: true,
    device: () => settings.device ?? 'generic',
    performance: () => ({ cores: settings.cores ?? null, ramMb: settings.ramMb ?? null }),
    display: () => ({ density: settings.density ?? null }),
  });
}

/** An AVD that has started before: it has userdata, a snapshot, and the marker that vouches for it. */
function bootedAvd(dir, engine, profile) {
  const layout = createSdkLayout(dir);
  createAvd({
    layout,
    androidRoot: ANDROID_ROOT,
    profile,
    device: engine.device(),
    tuning: engine.guestTuning(profile),
    snapshotName: 'default_boot',
  });
  const avd = avdDir(layout, profile.avdName);
  writeFileSync(path.join(avd, 'userdata-qemu.img'), '');
  mkdirSync(path.join(avd, 'snapshots', 'default_boot'), { recursive: true });
  const state = avdState(layout, profile.avdName);
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'provisioned_at'), new Date().toISOString());
  return { avd, state };
}

// ── What a start uses ─────────────────────────────────────────────────────────────────────────

test('with nothing set, a start uses the measured defaults', async () => {
  await withTempDir(async (dir) => {
    const tuning = engineIn(dir).guestTuning(openemu());
    assert.equal(tuning.cores, measured.cores);
    assert.equal(tuning.ramMb, measured.ramMb);
  });
});

test('cores and memory from Settings reach the guest', async () => {
  await withTempDir(async (dir) => {
    const tuning = engineIn(dir, { cores: 3, ramMb: 5120 }).guestTuning(openemu());
    assert.equal(tuning.cores, 3);
    assert.equal(tuning.ramMb, 5120);
  });
});

test("the user's memory wins over a profile's hint, and the hint wins over the default", async () => {
  await withTempDir(async (dir) => {
    assert.equal(compat().ramMb, 4096, 'the shipped compat profile asks for 4 GB');
    assert.equal(engineIn(dir).guestTuning(compat()).ramMb, 4096);
    assert.equal(engineIn(dir, { ramMb: 6144 }).guestTuning(compat()).ramMb, 6144);
    assert.equal(engineIn(dir, { cores: 2 }).guestTuning(compat()).ramMb, 4096, 'setting cores leaves memory to the hint');
  });
});

test('Automatic is what a start would use if nothing were set, whatever is set', async () => {
  await withTempDir(async (dir) => {
    const engine = engineIn(dir, { cores: 2, ramMb: 8192 });
    assert.equal(engine.automaticTuning(openemu()).cores, measured.cores);
    assert.equal(engine.automaticTuning(openemu()).ramMb, measured.ramMb);
    assert.equal(engine.automaticTuning(compat()).ramMb, 4096);
  });
});

test("the interface size replaces the device's density and nothing else about it", async () => {
  await withTempDir(async (dir) => {
    const stock = engineIn(dir).device();
    const larger = engineIn(dir, { density: 320 }).device();
    assert.equal(stock.lcdDensity, 240, 'the generic device ships at 240 dpi');
    assert.equal(larger.lcdDensity, 320);
    assert.equal(larger.lcdWidth, stock.lcdWidth);
    assert.equal(larger.lcdHeight, stock.lcdHeight);
    assert.deepEqual(larger.props, stock.props);
  });
});

// ── A snapshot does not outlive the hardware it was taken on ──────────────────────────────────

test('a start on the same hardware keeps the snapshot', async () => {
  await withTempDir(async (dir) => {
    const engine = engineIn(dir);
    const profile = openemu();
    const { avd, state } = bootedAvd(dir, engine, profile);

    assert.equal(engine.forgetOtherHardware(profile, engine.guestTuning(profile)), false);
    assert.ok(existsSync(path.join(avd, 'snapshots', 'default_boot')));
    assert.ok(existsSync(path.join(state, 'provisioned_at')));
  });
});

for (const [what, change] of [
  ['more cores', { cores: 2 }],
  ['more memory', { ramMb: 6144 }],
  ['another interface size', { density: 320 }],
]) {
  test(`${what} drops the snapshot and the marker, and keeps the user's data`, async () => {
    await withTempDir(async (dir) => {
      const profile = openemu();
      const { avd, state } = bootedAvd(dir, engineIn(dir), profile);

      const changed = engineIn(dir, change);
      assert.equal(changed.forgetOtherHardware(profile, changed.guestTuning(profile)), true);
      assert.ok(!existsSync(path.join(avd, 'snapshots')), 'the snapshot would be refused on this hardware');
      assert.ok(!existsSync(path.join(state, 'provisioned_at')), 'so the start provisions again and saves a new one');
      assert.ok(existsSync(path.join(avd, 'userdata-qemu.img')), 'apps and files are not hardware');
    });
  });
}

test('an AVD that has never started has nothing to forget', async () => {
  await withTempDir(async (dir) => {
    const profile = openemu();
    const layout = createSdkLayout(dir);
    const first = engineIn(dir);
    createAvd({
      layout, androidRoot: ANDROID_ROOT, profile, device: first.device(), tuning: first.guestTuning(profile), snapshotName: 'default_boot',
    });
    const changed = engineIn(dir, { cores: 2 });
    assert.equal(changed.forgetOtherHardware(profile, changed.guestTuning(profile)), false);
    assert.equal(engineIn(dir, { cores: 2 }).forgetOtherHardware(loadProfile(ANDROID_ROOT, 'fast'), measured), false, 'nor does one that does not exist');
  });
});

test('the comparison is on hardware alone: the snapshot keys in config.ini do not count as a change', async () => {
  await withTempDir(async (dir) => {
    const engine = engineIn(dir);
    const profile = openemu();
    const { avd } = bootedAvd(dir, engine, profile);
    const config = path.join(avd, 'config.ini');
    // What a start writes once a snapshot exists.
    writeFileSync(
      config,
      readFileSync(config, 'utf8')
        .replace(/^fastboot\.forceColdBoot=.*$/m, 'fastboot.forceColdBoot=no')
        .replace(/^fastboot\.forceFastBoot=.*$/m, 'fastboot.forceFastBoot=yes'),
    );
    assert.equal(engine.forgetOtherHardware(profile, engine.guestTuning(profile)), false);
  });
});
