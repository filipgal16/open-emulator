import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { createSdkLayout, avdState, avdDir, snapshotDir, systemImagePath } = loadDist('engine/sdk/layout.js');
const { tuneForHost } = loadDist('engine/sdk/host.js');

const ROOT = 'C:\\Users\\x\\AppData\\Local\\open-emulator';
const win = () => createSdkLayout(ROOT, 'win32');

test('every SDK entry point gets a Windows extension', () => {
  const layout = win();

  assert.ok(layout.emulator.endsWith('emulator.exe'));
  assert.ok(layout.adb.endsWith('adb.exe'));
  // sdkmanager and avdmanager ship as .bat wrappers around the Java program, not .exe.
  assert.ok(layout.sdkManager.endsWith('sdkmanager.bat'));
  assert.ok(layout.avdManager.endsWith('avdmanager.bat'));
});

test('the same layout resolves bare names off Windows', () => {
  const layout = createSdkLayout('/home/x/.open-emulator', 'linux');

  assert.ok(layout.emulator.endsWith('emulator'));
  assert.ok(!layout.emulator.endsWith('.exe'));
  assert.ok(layout.sdkManager.endsWith('sdkmanager'));
});

test('the install root carries no spaces, which the SDK has historically mishandled', () => {
  assert.ok(!win().sdkRoot.includes(' '), win().sdkRoot);
});

test('AVD state is per-AVD, so one guest cannot vouch for another', () => {
  const layout = win();

  assert.notEqual(avdState(layout, 'OpenEmulator_API30_fast'), avdState(layout, 'OpenEmulator_API30_play'));
});

test('snapshots live inside the AVD they belong to', () => {
  const layout = win();

  assert.ok(snapshotDir(layout, 'A', 'booted').startsWith(avdDir(layout, 'A')));
});

test('the system image path is per image tag, not per profile name', () => {
  const layout = win();
  const aosp = systemImagePath(layout, 'default');
  const play = systemImagePath(layout, 'google_apis_playstore');

  assert.notEqual(aosp, play);
  assert.ok(aosp.endsWith('system.img'));
  assert.ok(aosp.includes('android-30'));
});

// ── Host tuning ────────────────────────────────────────────────────────────────────────────────

const facts = (over = {}) => ({ cpus: 16, totalRamMb: 15_700, accelerated: true, hasWindow: true, ...over });

test('a core is left for the host, and the count is capped where returns flatten', () => {
  assert.equal(tuneForHost(facts({ cpus: 16 })).cores, 12, 'capped at 12');
  assert.equal(tuneForHost(facts({ cpus: 8 })).cores, 7);
  assert.equal(tuneForHost(facts({ cpus: 1 })).cores, 1, 'never zero');
});

test('without acceleration, two cores beat oversubscribing a software CPU', () => {
  assert.equal(tuneForHost(facts({ accelerated: false, cpus: 16 })).cores, 2);
  assert.equal(tuneForHost(facts({ accelerated: false })).accel, 'off');
});

test('guest RAM is a measured constant, not a share of the host', () => {
  // Bigger host, same guest: warm start is dominated by restoring the snapshot's ram.bin, which
  // grows with this number, so scaling it up made large machines slower.
  assert.equal(tuneForHost(facts({ totalRamMb: 15_700 })).ramMb, 3072);
  assert.equal(tuneForHost(facts({ totalRamMb: 65_536 })).ramMb, 3072);
  assert.equal(tuneForHost(facts({ totalRamMb: 3_500 })).ramMb, 2048, 'small host steps down');
});

test('a real window and acceleration earn the real GPU', () => {
  assert.equal(tuneForHost(facts()).gpuMode, 'host');
});

test('headless falls back to software rendering, because -gpu host needs a window', () => {
  assert.equal(tuneForHost(facts({ hasWindow: false })).gpuMode, 'swiftshader_indirect');
  assert.equal(tuneForHost(facts({ accelerated: false })).gpuMode, 'swiftshader_indirect');
});

test('auto is never chosen — a snapshot records the resolved renderer and must match config.ini', () => {
  for (const f of [facts(), facts({ hasWindow: false }), facts({ accelerated: false })]) {
    assert.notEqual(tuneForHost(f).gpuMode, 'auto');
  }
});

test('overrides win, but are clamped rather than trusted', () => {
  assert.equal(tuneForHost(facts(), { cores: 4 }).cores, 4);
  assert.equal(tuneForHost(facts(), { cores: 9999 }).cores, 32);
  assert.equal(tuneForHost(facts(), { cores: 0 }).cores, 1);
  assert.equal(tuneForHost(facts(), { ramMb: 100 }).ramMb, 512);
  assert.equal(tuneForHost(facts(), { gpuMode: 'angle_indirect' }).gpuMode, 'angle_indirect');
});
