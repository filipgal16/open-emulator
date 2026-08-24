import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../helpers.mjs';

const { FdroidSource } = loadDist('store/sources/fdroid.js');

const sha = (n) => String(n).repeat(64).slice(0, 64);

function rawIndex(packages, timestamp = 1) {
  return {
    repo: { address: 'https://f-droid.org/repo', timestamp },
    packages,
  };
}

function rawApp(name, versions) {
  return {
    metadata: {
      name: { 'en-US': name },
      summary: { 'en-US': `${name} does things` },
      description: { 'en-US': `<p>All about ${name}.</p>` },
      license: 'Apache-2.0',
      categories: ['Internet'],
      lastUpdated: 5_000,
      icon: { 'en-US': { name: `/icons/${name}.png`, sha256: sha(9), size: 100 } },
      webSite: 'https://example.test',
    },
    versions,
  };
}

function rawVersion({ versionCode = 1, versionName = '1.0', minSdk = 21, digest = sha(1), size = 2048 } = {}) {
  return {
    added: 400,
    file: { name: `/app_${versionCode}.apk`, sha256: digest, size },
    manifest: { versionCode, versionName, usesSdk: { minSdkVersion: minSdk } },
  };
}

function fakeIcons() {
  const ready = new Set();
  return {
    prefetched: [],
    urlIfReady(url) {
      return ready.has(url) ? `oe-app://icon/${'a'.repeat(32)}` : null;
    },
    async prefetch(urls) {
      this.prefetched.push(...urls);
      for (const url of urls) ready.add(url);
    },
  };
}

function fakeFetch(payload, { status = 200, etag = '"v1"' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (status === 304) {
      return { ok: false, status: 304, headers: new Map(), text: async () => '' };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['etag', etag]]),
      text: async () => JSON.stringify(payload),
    };
  };
  impl.calls = calls;
  return impl;
}

const INDEX = rawIndex({
  'org.fdroid.fdroid': rawApp('F-Droid', { [sha(1)]: rawVersion({ digest: sha(1) }) }),
  'com.needs.new': rawApp('Needs New', {
    [sha(2)]: rawVersion({ versionCode: 9, versionName: '9.0', minSdk: 34, digest: sha(2) }),
    [sha(3)]: rawVersion({ versionCode: 2, versionName: '2.0', minSdk: 29, digest: sha(3) }),
  }),
});

test('the catalogue is fetched, distilled, and searchable', async () => {
  await withTempDir(async (dir) => {
    const icons = fakeIcons();
    const fetchImpl = fakeFetch(INDEX);
    const source = new FdroidSource(path.join(dir, 'index.json'), icons, { fetchImpl });

    assert.equal(source.ready, false);
    await source.refresh();

    assert.equal(source.ready, true);
    assert.equal(source.appCount, 2);
    assert.ok(source.updatedAt > 0);

    const results = await source.search('fdroid', 30, 10);
    assert.equal(results[0].packageName, 'org.fdroid.fdroid');
    assert.equal(results[0].source, 'fdroid');
    assert.equal(results[0].id, 'fdroid:org.fdroid.fdroid');
  });
});

test('the distilled catalogue is cached and reloaded without a second fetch', async () => {
  await withTempDir(async (dir) => {
    const cacheFile = path.join(dir, 'index.json');
    const fetchImpl = fakeFetch(INDEX);

    await new FdroidSource(cacheFile, fakeIcons(), { fetchImpl }).refresh();
    assert.ok(existsSync(cacheFile));
    assert.ok(readFileSync(cacheFile, 'utf8').includes('org.fdroid.fdroid'));

    // A fresh instance reads the cache, and refresh() inside the TTL does nothing.
    const reopened = new FdroidSource(cacheFile, fakeIcons(), { fetchImpl });
    assert.equal(reopened.ready, true);
    await reopened.refresh();
    assert.equal(fetchImpl.calls.length, 1, 'the TTL suppressed a second download');
  });
});

test('a refresh sends a conditional GET once it has an ETag', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch(INDEX);
    const source = new FdroidSource(path.join(dir, 'index.json'), fakeIcons(), { fetchImpl });

    await source.refresh();
    assert.equal(fetchImpl.calls[0].headers['if-none-match'], undefined, 'nothing to be conditional on yet');

    await source.refresh(true);
    assert.equal(fetchImpl.calls[1].headers['if-none-match'], '"v1"');
  });
});

test('a 304 keeps the cached catalogue rather than emptying it', async () => {
  await withTempDir(async (dir) => {
    const cacheFile = path.join(dir, 'index.json');
    await new FdroidSource(cacheFile, fakeIcons(), { fetchImpl: fakeFetch(INDEX) }).refresh();

    const source = new FdroidSource(cacheFile, fakeIcons(), { fetchImpl: fakeFetch(INDEX, { status: 304 }) });
    await source.refresh(true);

    assert.equal(source.appCount, 2, 'still serving the cached distillate');
  });
});

test('a failed refresh keeps serving what is cached', async () => {
  await withTempDir(async (dir) => {
    const cacheFile = path.join(dir, 'index.json');
    await new FdroidSource(cacheFile, fakeIcons(), { fetchImpl: fakeFetch(INDEX) }).refresh();

    const logs = [];
    const source = new FdroidSource(cacheFile, fakeIcons(), {
      fetchImpl: async () => {
        throw new Error('network down');
      },
      onLog: (line) => logs.push(line),
    });
    await source.refresh(true);

    assert.equal(source.appCount, 2);
    assert.ok(logs.some((line) => line.includes('network down')), 'the failure is logged, not swallowed');
  });
});

test('an index that parses to nothing is rejected rather than replacing a good one', async () => {
  await withTempDir(async (dir) => {
    const cacheFile = path.join(dir, 'index.json');
    await new FdroidSource(cacheFile, fakeIcons(), { fetchImpl: fakeFetch(INDEX) }).refresh();

    const source = new FdroidSource(cacheFile, fakeIcons(), {
      fetchImpl: fakeFetch(rawIndex({})),
    });
    await source.refresh(true);

    assert.equal(source.appCount, 2, 'an empty index is treated as a bad response');
  });
});

test('the version offered depends on the guest', async () => {
  await withTempDir(async (dir) => {
    const source = new FdroidSource(path.join(dir, 'index.json'), fakeIcons(), { fetchImpl: fakeFetch(INDEX) });
    await source.refresh();

    const [onOld] = await source.search('needs new', 30, 5);
    assert.equal(onOld.versionName, '2.0');
    assert.equal(onOld.minSdk, 29);

    const [onNew] = await source.search('needs new', 34, 5);
    assert.equal(onNew.versionName, '9.0');
  });
});

test('resolve hands the installer an https URL and the digest to check it against', async () => {
  await withTempDir(async (dir) => {
    const source = new FdroidSource(path.join(dir, 'index.json'), fakeIcons(), { fetchImpl: fakeFetch(INDEX) });
    await source.refresh();

    const resolved = await source.resolve('org.fdroid.fdroid', null, 30);
    assert.equal(resolved.kind, 'url');
    assert.equal(resolved.location, 'https://f-droid.org/repo/app_1.apk');
    assert.equal(resolved.sha256, sha(1));
    assert.equal(resolved.source, 'fdroid');
    assert.equal(resolved.label, 'F-Droid');

    assert.equal(await source.resolve('com.not.here', null, 30), null);
  });
});

test('resolve can pin an explicit version', async () => {
  await withTempDir(async (dir) => {
    const source = new FdroidSource(path.join(dir, 'index.json'), fakeIcons(), { fetchImpl: fakeFetch(INDEX) });
    await source.refresh();

    const pinned = await source.resolve('com.needs.new', 9, 30);
    assert.equal(pinned.versionName, '9.0');
    assert.equal(await source.resolve('com.needs.new', 12345, 30), null, 'an unknown version code resolves to nothing');
  });
});

test('icons are ready on the first search, not a render later', async () => {
  await withTempDir(async (dir) => {
    const icons = fakeIcons();
    const source = new FdroidSource(path.join(dir, 'index.json'), icons, { fetchImpl: fakeFetch(INDEX) });
    await source.refresh();

    // search() awaits the prefetch before building the results, so the grid paints with artwork
    // instead of a row of letter tiles that fill in afterwards.
    const first = await source.search('fdroid', 30, 5);
    assert.match(first[0].iconUrl, /^oe-app:\/\/icon\//);
    assert.ok(icons.prefetched.includes('https://f-droid.org/repo/icons/F-Droid.png'));

    const fetchedOnce = icons.prefetched.length;
    await source.search('fdroid', 30, 5);
    assert.equal(icons.prefetched.length, fetchedOnce, 'an already-cached icon is not re-requested');
  });
});

test('detail carries the description and other versions', async () => {
  await withTempDir(async (dir) => {
    const source = new FdroidSource(path.join(dir, 'index.json'), fakeIcons(), { fetchImpl: fakeFetch(INDEX) });
    await source.refresh();

    const detail = await source.detail('com.needs.new', 34);
    assert.equal(detail.description, 'All about Needs New.');
    assert.equal(detail.webSite, 'https://example.test');
    assert.deepEqual(
      detail.otherVersions.map((v) => v.versionName),
      ['2.0'],
      'the offered version is not repeated in the list',
    );

    assert.equal(await source.detail('com.missing', 30), null);
  });
});
