import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../../helpers.mjs';

const { matchQemuPid } = loadDist('engine/sdk/find-process.js');

const LINES = [
  '25448|"C:\\sdk\\emulator\\qemu\\windows-x86_64\\qemu-system-x86_64.exe" -avd OpenEmulator_API30_fast -gpu host -accel on',
  '31000|"C:\\sdk\\emulator\\qemu\\windows-x86_64\\qemu-system-x86_64.exe" -avd OpenEmulator_API30_play -gpu host',
];

test('finds the QEMU process by the AVD on its command line', () => {
  assert.equal(matchQemuPid(LINES, 'OpenEmulator_API30_fast'), 25448);
  assert.equal(matchQemuPid(LINES, 'OpenEmulator_API30_play'), 31000);
});

test('a name that is a prefix of another AVD does not match it', () => {
  // `OpenEmulator_API30` must not adopt the `_fast` guest: `start` would then skip booting the
  // profile that was actually asked for.
  assert.equal(matchQemuPid(LINES, 'OpenEmulator_API30'), null);
});

test('no process, garbage lines, and empty output all read as not found', () => {
  assert.equal(matchQemuPid([], 'x'), null);
  assert.equal(matchQemuPid(['', '   ', 'not-a-pid|-avd x', '|-avd x'], 'x'), null);
});
