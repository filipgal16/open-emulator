import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { formatBytes, installBlockedReason, SOURCES, SOURCE_IDS } = loadDist('../shared/store-types.js');

const app = (overrides = {}) => ({ minSdk: 21, ...overrides });

test('an app the guest can run is not blocked', () => {
  assert.equal(installBlockedReason(app({ minSdk: 30 }), 30), null);
  assert.equal(installBlockedReason(app({ minSdk: 21 }), 30), null);
});

test('an app that needs a newer Android says so instead of failing after a download', () => {
  const reason = installBlockedReason(app({ minSdk: 33 }), 30);
  assert.match(reason, /33/);
  assert.match(reason, /30/);
});

test('nothing is installable while the guest is unknown', () => {
  assert.match(installBlockedReason(app(), null), /Waiting/);
});

test('a local file is never blocked on our guess about compatibility', () => {
  // LocalSource reports minSdk 0 precisely so the guest's package manager stays the authority.
  assert.equal(installBlockedReason(app({ minSdk: 0 }), 30), null);
});

test('sizes render for humans', () => {
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(11 * 1024 * 1024), '11 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
});

test('every declared source id has a spec', () => {
  for (const id of SOURCE_IDS) {
    assert.equal(SOURCES[id].id, id);
    assert.ok(SOURCES[id].label, `${id} has no label`);
    assert.ok(SOURCES[id].emptyHint, `${id} has no empty-state hint`);
  }
});
