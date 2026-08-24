import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../../helpers.mjs';

const { parseDevices, isBootComplete } = loadDist('engine/sdk/adb.js');

test('only serials in the device state are usable', () => {
  const serials = parseDevices([
    'List of devices attached',
    'emulator-5554\tdevice',
    'emulator-5556\toffline',
    'emulator-5558\tunauthorized',
    '',
  ]);

  // offline and unauthorized accept a connection and then fail every command against them, which
  // reads as a broken guest rather than one that is not ready yet.
  assert.deepEqual(serials, ['emulator-5554']);
});

test('an empty list is empty, not a phantom device', () => {
  assert.deepEqual(parseDevices(['List of devices attached', '']), []);
});

test('a TCP serial is accepted — the FOSS runtime reaches the guest that way', () => {
  assert.deepEqual(parseDevices(['List of devices attached', 'localhost:5555\tdevice']), ['localhost:5555']);
});

test('boot needs the property AND a package manager that answers', () => {
  // sys.boot_completed flips before pm is ready, so an install fired on the property alone fails
  // against a package manager that is not up yet.
  assert.equal(isBootComplete('1', true), true);
  assert.equal(isBootComplete('1', false), false, 'property high but pm silent is not booted');
  assert.equal(isBootComplete('0', true), false);
  assert.equal(isBootComplete(null, true), false);
});

test('carriage returns from the guest do not defeat the comparison', () => {
  assert.equal(isBootComplete('1\r', true), true);
});
