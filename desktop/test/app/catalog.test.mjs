import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { Catalog } = loadDist('store/catalog.js');

function app(source, packageName) {
  return { id: `${source}:${packageName}`, source, packageName, name: packageName };
}

function stubSource(id, apps, { failSearch = false } = {}) {
  const calls = [];
  return {
    id,
    calls,
    async search(query, guestSdk, limit) {
      calls.push({ query, guestSdk, limit });
      if (failSearch) throw new Error(`${id} is down`);
      return apps.slice(0, limit);
    },
    async detail(packageName) {
      return apps.find((a) => a.packageName === packageName) ?? null;
    },
    async resolve(packageName) {
      return apps.some((a) => a.packageName === packageName) ? { packageName, source: id } : null;
    },
  };
}

test('a named source is searched on its own', async () => {
  const fdroid = stubSource('fdroid', [app('fdroid', 'a')]);
  const local = stubSource('local', [app('local', 'b.apk')]);
  const catalog = new Catalog([local, fdroid]);

  const results = await catalog.search({ query: 'x', source: 'fdroid', guestSdk: 30, limit: 10 });

  assert.deepEqual(results.map((r) => r.source), ['fdroid']);
  assert.equal(local.calls.length, 0);
});

test('local results come first, because there are few of them and they are the user’s own', async () => {
  const fdroid = stubSource('fdroid', [app('fdroid', 'a'), app('fdroid', 'b')]);
  const local = stubSource('local', [app('local', 'mine.apk')]);
  const catalog = new Catalog([fdroid, local]);

  const results = await catalog.search({ query: '', source: null, guestSdk: 30, limit: 10 });

  assert.equal(results[0].source, 'local');
  assert.equal(results.length, 3);
});

test('one broken source does not empty the whole result set', async () => {
  const fdroid = stubSource('fdroid', [app('fdroid', 'a')]);
  const local = stubSource('local', [], { failSearch: true });
  const catalog = new Catalog([fdroid, local]);

  const results = await catalog.search({ query: '', source: null, guestSdk: 30, limit: 10 });

  assert.deepEqual(results.map((r) => r.source), ['fdroid']);
});

test('the overall limit is respected across sources', async () => {
  const many = Array.from({ length: 20 }, (_, i) => app('fdroid', `pkg${i}`));
  const catalog = new Catalog([stubSource('fdroid', many), stubSource('local', [app('local', 'x.apk')])]);

  const results = await catalog.search({ query: '', source: null, guestSdk: 30, limit: 5 });
  assert.equal(results.length, 5);
});

test('an unknown source id yields nothing rather than throwing', async () => {
  const catalog = new Catalog([stubSource('fdroid', [app('fdroid', 'a')])]);

  assert.deepEqual(await catalog.search({ query: '', source: 'play', guestSdk: 30, limit: 5 }), []);
  assert.equal(await catalog.detail('play', 'a', 30), null);
  assert.equal(await catalog.resolve('play', 'a', null, 30), null);
});

test('detail and resolve route to the owning source', async () => {
  const catalog = new Catalog([stubSource('fdroid', [app('fdroid', 'a')]), stubSource('local', [app('local', 'b.apk')])]);

  assert.equal((await catalog.detail('fdroid', 'a', 30)).source, 'fdroid');
  assert.equal((await catalog.resolve('local', 'b.apk', null, 30)).source, 'local');
  assert.equal(await catalog.detail('fdroid', 'b.apk', 30), null);
});

test('the guest API level is passed through to every source', async () => {
  const fdroid = stubSource('fdroid', [app('fdroid', 'a')]);
  const catalog = new Catalog([fdroid]);

  await catalog.search({ query: 'q', source: null, guestSdk: 29, limit: 10 });
  assert.equal(fdroid.calls[0].guestSdk, 29);
});
