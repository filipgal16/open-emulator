import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { AttributionStore } = loadDist('ads/attribution.js');

const NOW = new Date(2026, 7, 21, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;
const CONVERSION = 'https://track.example.test/install?c=c1';

function fakeFetch(behaviour = 'ok') {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (behaviour === 'fail') throw new Error('network down');
    if (behaviour === '500') return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };
  impl.calls = calls;
  return impl;
}

test('an install that matches a pending click fires the postback once', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch();
    const store = new AttributionStore(path.join(dir, 'a.json'), { fetchImpl });

    store.recordClick('c1', 'com.example.game', CONVERSION, NOW);
    assert.deepEqual(await store.reconcile(['com.example.game'], NOW + 60_000), ['c1']);
    assert.deepEqual(fetchImpl.calls, [CONVERSION]);

    // A reinstall must not be billed a second time.
    assert.deepEqual(await store.reconcile(['com.example.game'], NOW + 120_000), []);
    assert.equal(fetchImpl.calls.length, 1);
  });
});

test('nothing fires until the package actually appears', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch();
    const store = new AttributionStore(path.join(dir, 'a.json'), { fetchImpl });

    store.recordClick('c1', 'com.example.game', CONVERSION, NOW);
    assert.deepEqual(await store.reconcile(['com.other.app'], NOW + 60_000), []);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a failed postback stays pending and retries', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.json');
    const failing = fakeFetch('fail');
    const store = new AttributionStore(file, { fetchImpl: failing });

    store.recordClick('c1', 'com.example.game', CONVERSION, NOW);
    assert.deepEqual(await store.reconcile(['com.example.game'], NOW + 1000), []);
    assert.deepEqual(store.pendingPackages(NOW + 1000), ['com.example.game']);

    // A later launch, with the network back.
    const working = fakeFetch();
    const reloaded = new AttributionStore(file, { fetchImpl: working });
    assert.deepEqual(await reloaded.reconcile(['com.example.game'], NOW + 2000), ['c1']);
    assert.deepEqual(working.calls, [CONVERSION]);
  });
});

test('an HTTP error is a failure, not a silent success', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch('500');
    const store = new AttributionStore(path.join(dir, 'a.json'), { fetchImpl });
    store.recordClick('c1', 'com.example.game', CONVERSION, NOW);
    assert.deepEqual(await store.reconcile(['com.example.game'], NOW), []);
  });
});

test('the attribution window expires', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch();
    const store = new AttributionStore(path.join(dir, 'a.json'), { fetchImpl });

    store.recordClick('c1', 'com.example.game', CONVERSION, NOW);
    // Eight days later, past any network's payable window.
    assert.deepEqual(await store.reconcile(['com.example.game'], NOW + 8 * DAY), []);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('campaigns without an install target are ignored', async () => {
  await withTempDir(async (dir) => {
    const store = new AttributionStore(path.join(dir, 'a.json'), { fetchImpl: fakeFetch() });
    store.recordClick('c1', null, CONVERSION, NOW);
    store.recordClick('c2', 'com.example.game', null, NOW);
    assert.deepEqual(store.pendingPackages(NOW), []);
  });
});

test('a non-https postback is refused', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch();
    const store = new AttributionStore(path.join(dir, 'a.json'), { fetchImpl });
    store.recordClick('c1', 'com.example.game', 'http://track.example.test/install', NOW);
    assert.deepEqual(await store.reconcile(['com.example.game'], NOW), []);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('pending state survives a restart', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.json');
    new AttributionStore(file, { fetchImpl: fakeFetch() }).recordClick('c1', 'com.example.game', CONVERSION, NOW);

    const reloaded = new AttributionStore(file, { fetchImpl: fakeFetch() });
    assert.deepEqual(reloaded.pendingPackages(NOW), ['com.example.game']);
  });
});
