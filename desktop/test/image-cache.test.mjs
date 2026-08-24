import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { ImageCache } = loadDist('image-cache.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const ICON_URL = 'https://f-droid.org/repo/icons/app.png';

function fakeFetch(body) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/png']]),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  impl.calls = calls;
  return impl;
}

// What matters here is that the scheme and host are genuinely configurable — that is the whole
// reason a caller can reuse this class instead of owning a second copy of it.

test('the scheme and host are configurable, which is what the store reuses', async () => {
  await withTempDir(async (dir) => {
    const cache = new ImageCache(dir, { scheme: 'oe-app', host: 'icon', fetchImpl: fakeFetch(PNG) });

    const url = await cache.ensure(ICON_URL);
    assert.match(url, /^oe-app:\/\/icon\/[0-9a-f]{32}$/);
    assert.equal(cache.urlIfReady(ICON_URL), url);

    const read = cache.read(url.split('/').pop());
    assert.equal(read.mime, 'image/png');
    assert.deepEqual(read.bytes, PNG);
  });
});

test('two caches with different schemes do not collide on ids', async () => {
  await withTempDir(async (dir) => {
    const shots = new ImageCache(dir, { scheme: 'oe-shot', host: 'screenshot', fetchImpl: fakeFetch(PNG) });
    const store = new ImageCache(dir, { scheme: 'oe-app', host: 'icon', fetchImpl: fakeFetch(PNG) });

    const shotUrl = await shots.ensure(ICON_URL);
    const storeUrl = await store.ensure(ICON_URL);

    assert.notEqual(shotUrl, storeUrl, 'same bytes, different scheme');
    assert.equal(shotUrl.split('/').pop(), storeUrl.split('/').pop(), 'the id is content-addressed either way');
  });
});

test('the size limit is per-cache, so screenshots can be larger than icons', async () => {
  await withTempDir(async (dir) => {
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 7)]);

    const tight = new ImageCache(dir, { scheme: 'oe-app', host: 'icon', maxBytes: 1024, fetchImpl: fakeFetch(big) });
    assert.equal(await tight.ensure(ICON_URL), null, 'refused by the smaller cap');

    const roomy = new ImageCache(dir, {
      scheme: 'oe-app',
      host: 'icon',
      maxBytes: 4 * 1024 * 1024,
      fetchImpl: fakeFetch(big),
    });
    assert.match(await roomy.ensure(ICON_URL), /^oe-app:\/\/icon\//);
  });
});
