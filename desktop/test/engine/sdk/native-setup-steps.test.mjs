import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../../helpers.mjs';

const { buildNativeSteps } = loadDist('engine/sdk/setup-steps.js');
const { createSdkLayout, systemImagePath } = loadDist('engine/sdk/layout.js');

const PROFILE = {
  name: 'fast', description: '', systemImage: 'system-images;android-30;default;x86_64',
  imageTag: 'default', playStore: false, avdName: 'OpenEmulator_API30_fast',
};

const fakeClient = (lines = []) => ({ async status() { return { code: 0, stdout: lines, stderr: [] }; } });

function steps(layout, client = fakeClient()) {
  return buildNativeSteps({ layout, openEmu: client, profile: () => PROFILE });
}

test('the native wizard has no WSL, distro, or apt steps left', async () => {
  await withTempDir(async (dir) => {
    const ids = steps(createSdkLayout(dir)).map((s) => s.id);

    // The whole point of the port: installing a Linux distribution, apt-getting a JDK, and syncing
    // a shell backend into it are simply gone.
    for (const gone of ['wsl', 'distro', 'deps', 'backend']) {
      assert.ok(!ids.includes(gone), `"${gone}" should not survive the native port`);
    }
    assert.deepEqual(ids, ['acceleration', 'extractor', 'sdk', 'provisioned']);
  });
});

test('acceleration is not blocking — a slow guest beats no guest', async () => {
  await withTempDir(async (dir) => {
    const accel = steps(createSdkLayout(dir)).find((s) => s.id === 'acceleration');
    assert.equal(accel.blocking, false);
  });
});

test('the SDK check wants the profile image, not just the emulator binary', async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);
    const sdk = steps(layout).find((s) => s.id === 'sdk');

    assert.equal((await sdk.check()).pass, false, 'nothing installed');

    // Emulator and adb present, image absent — the case that used to sail through and fail later.
    for (const bin of [layout.emulator, layout.adb]) {
      mkdirSync(path.dirname(bin), { recursive: true });
      writeFileSync(bin, 'x');
    }
    const partial = await sdk.check();
    assert.equal(partial.pass, false);
    assert.match(partial.detail, /system image is not downloaded/);

    const image = systemImagePath(layout, 'default');
    mkdirSync(path.dirname(image), { recursive: true });
    writeFileSync(image, 'x');
    assert.equal((await sdk.check()).pass, true);
  });
});

test('a derived image with its base present still reports as not built', async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);
    const derived = {
      name: 'openemu',
      description: '',
      systemImage: 'system-images;android-30;openemu;x86_64',
      imageTag: 'openemu',
      baseImageTag: 'default',
      playStore: false,
      avdName: 'OpenEmulator_API30_openemu',
    };
    const sdk = buildNativeSteps({
      layout,
      openEmu: fakeClient(),
      profile: () => derived,
    }).find((s) => s.id === 'sdk');

    for (const bin of [layout.emulator, layout.adb]) {
      mkdirSync(path.dirname(bin), { recursive: true });
      writeFileSync(bin, 'x');
    }
    const base = systemImagePath(layout, 'default');
    mkdirSync(path.dirname(base), { recursive: true });
    writeFileSync(base, 'x');

    const pending = await sdk.check();
    assert.equal(pending.pass, false);
    assert.match(pending.detail, /not been built/);

    const built = systemImagePath(layout, 'openemu');
    mkdirSync(path.dirname(built), { recursive: true });
    writeFileSync(built, 'x');
    assert.equal((await sdk.check()).pass, true);
  });
});

test('provisioning is judged by the marker the engine reports', async () => {
  await withTempDir(async (dir) => {
    const layout = createSdkLayout(dir);

    const unprovisioned = steps(layout, fakeClient(['avd=x', 'emulator=stopped']))
      .find((s) => s.id === 'provisioned');
    assert.equal((await unprovisioned.check()).pass, false);

    const ready = steps(layout, fakeClient(['avd=x', 'provisioned_at=2026-08-24T00:00:00Z']))
      .find((s) => s.id === 'provisioned');
    assert.equal((await ready.check()).pass, true);
  });
});

test('every step that can fail itself offers a fix, and blocking steps are marked', async () => {
  await withTempDir(async (dir) => {
    const all = steps(createSdkLayout(dir));
    const byId = Object.fromEntries(all.map((s) => [s.id, s]));

    assert.equal(byId.sdk.blocking, true);
    assert.equal(byId.extractor.blocking, true);
    // Preparing the device is deliberately NOT blocking. It is the only step that needs a
    // hypervisor, so blocking on it would gate the whole several-gigabyte setup behind a restart —
    // this way everything downloads, and the restart is something the user does when convenient.
    assert.equal(byId.provisioned.blocking, false);
    // The extractor ships with Windows; there is nothing this app can do to install it.
    assert.equal(typeof byId.extractor.fix, 'undefined');
    assert.equal(typeof byId.sdk.fix, 'function');
  });
});
