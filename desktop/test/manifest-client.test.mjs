import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { ManifestClient } = loadDist('ads/manifest-client.js');

const URL_ = 'https://ads.example.test/v1/manifest.json';
const NOW = new Date(2026, 7, 21, 12, 0, 0).getTime();

const campaign = (id) => ({
  id,
  slots: ['rail'],
  advertiser: 'A',
  headline: 'H',
  cta: 'Go',
  clickUrl: 'https://example.com/x',
});

/** Fake fetch that serves `bodies` one call at a time; an Error entry rejects. */
function fakeFetch(...bodies) {
  const queue = [...bodies];
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return { ok: false, status: next, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  impl.calls = calls;
  return impl;
}

test('no configured URL means no offer inventory and no requests', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch({ campaigns: [campaign('c1')] });
    const client = new ManifestClient(null, path.join(dir, 'm.json'), { fetchImpl, now: () => NOW });
    await client.refresh();
    assert.deepEqual(client.campaigns(), []);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a refresh populates campaigns and writes the cache', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'm.json');
    const client = new ManifestClient(URL_, file, {
      fetchImpl: fakeFetch({ ttlSeconds: 3600, campaigns: [campaign('c1'), campaign('c2')] }),
      now: () => NOW,
    });
    await client.refresh();
    assert.deepEqual(client.campaigns().map((c) => c.id), ['c1', 'c2']);

    // A fresh client with no network at all must still serve from that cache.
    const offline = new ManifestClient(URL_, file, {
      fetchImpl: fakeFetch(new Error('offline')),
      now: () => NOW,
    });
    assert.deepEqual(offline.campaigns().map((c) => c.id), ['c1', 'c2']);
  });
});

test('a failed refresh keeps serving the cached manifest', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'm.json');
    const first = new ManifestClient(URL_, file, {
      fetchImpl: fakeFetch({ campaigns: [campaign('c1')] }),
      now: () => NOW,
    });
    await first.refresh();

    const client = new ManifestClient(URL_, file, { fetchImpl: fakeFetch(500), now: () => NOW });
    await client.refresh();
    assert.deepEqual(client.campaigns().map((c) => c.id), ['c1']);
  });
});

test('a cache staler than the hard limit stops serving', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'm.json');
    const first = new ManifestClient(URL_, file, {
      fetchImpl: fakeFetch({ campaigns: [campaign('c1')] }),
      now: () => NOW,
    });
    await first.refresh();

    // Eight days later, with the endpoint down. An offer that can no longer be retracted must
    // not keep running.
    const eightDays = NOW + 8 * 24 * 60 * 60_000;
    const client = new ManifestClient(URL_, file, {
      fetchImpl: fakeFetch(new Error('offline')),
      now: () => eightDays,
    });
    assert.deepEqual(client.campaigns(), []);
  });
});

test('campaigns() never blocks and triggers at most one refresh at a time', async () => {
  await withTempDir(async (dir) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      await gate;
      return { ok: true, status: 200, text: async () => JSON.stringify({ campaigns: [campaign('c1')] }) };
    };

    const client = new ManifestClient(URL_, path.join(dir, 'm.json'), { fetchImpl, now: () => NOW });
    // Stale from the start (never fetched), so each of these wants to refresh.
    assert.deepEqual(client.campaigns(), []);
    assert.deepEqual(client.campaigns(), []);
    assert.deepEqual(client.campaigns(), []);
    assert.equal(calls, 1, 'concurrent refreshes must share one request');

    release();
    await client.refresh();
    assert.deepEqual(client.campaigns().map((c) => c.id), ['c1']);
  });
});

test('an oversized response is rejected', async () => {
  await withTempDir(async (dir) => {
    const huge = { campaigns: [{ ...campaign('c1'), body: 'x'.repeat(600 * 1024) }] };
    const client = new ManifestClient(URL_, path.join(dir, 'm.json'), {
      fetchImpl: fakeFetch(huge),
      now: () => NOW,
    });
    await client.refresh();
    assert.deepEqual(client.campaigns(), []);
  });
});

test('malformed JSON leaves the previous inventory untouched', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'm.json');
    const first = new ManifestClient(URL_, file, {
      fetchImpl: fakeFetch({ campaigns: [campaign('c1')] }),
      now: () => NOW,
    });
    await first.refresh();

    const broken = async () => ({ ok: true, status: 200, text: async () => '{ not json' });
    const client = new ManifestClient(URL_, file, { fetchImpl: broken, now: () => NOW });
    await client.refresh();
    assert.deepEqual(client.campaigns().map((c) => c.id), ['c1']);
  });
});
