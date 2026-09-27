import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { resolveEngineId } = loadDist('engine/factory.js');

test('native is the default on Windows', () => {
  // The native runtime is the only one with a window to embed, and therefore the only one that
  // shows the guest at the emulator's own frame rate rather than a ~3fps screencap poll.
  assert.equal(resolveEngineId(undefined, 'win32'), 'sdk');
  assert.equal(resolveEngineId('', 'win32'), 'sdk');
});

test('WSL is the default off Windows, where there is no emulator.exe to run', () => {
  assert.equal(resolveEngineId(undefined, 'linux'), 'wsl');
});

test('an explicit engine always wins', () => {
  assert.equal(resolveEngineId('wsl', 'win32'), 'wsl');
  assert.equal(resolveEngineId('sdk', 'linux'), 'sdk');
  assert.equal(resolveEngineId('qemu', 'win32'), 'qemu');
});

test('an unknown value falls back to the platform default rather than throwing', () => {
  assert.equal(resolveEngineId('nonsense', 'win32'), 'sdk');
});
