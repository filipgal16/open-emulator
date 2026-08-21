import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { CreativeCache, sniffImageMime } = loadDist('ads/creative-cache.js');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64, 2)]);
const URL_ = 'https://cdn.example.test/creative.png';

function fakeFetch(body, { ok = true, contentType = 'image/png' } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (!ok) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', contentType]]),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  impl.calls = calls;
  return impl;
}

test('mime is sniffed from magic bytes', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(GIF), 'image/gif');
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('<html>not an image at all</html>')), null);
  assert.equal(sniffImageMime(Buffer.alloc(4)), null);
});

test('a downloaded creative becomes an oe-ad URL that reads back', async () => {
  await withTempDir(async (dir) => {
    const cache = new CreativeCache(dir, { fetchImpl: fakeFetch(PNG) });
    assert.equal(cache.urlIfReady(URL_), null, 'nothing cached yet');

    const url = await cache.ensure(URL_);
    assert.match(url, /^oe-ad:\/\/creative\/[0-9a-f]{32}$/);
    assert.equal(cache.urlIfReady(URL_), url, 'now served from disk');

    const id = url.split('/').pop();
    const read = cache.read(id);
    assert.equal(read.mime, 'image/png');
    assert.deepEqual(read.bytes, PNG);
  });
});

test('a Content-Type header cannot make a non-image servable', async () => {
  await withTempDir(async (dir) => {
    // A compromised CDN labelling a script as an image is exactly the case the byte sniff exists
    // for — the header says image/png and it is still refused.
    const html = Buffer.from('<script>alert(1)</script>'.padEnd(64, ' '));
    const cache = new CreativeCache(dir, { fetchImpl: fakeFetch(html, { contentType: 'image/png' }) });
    assert.equal(await cache.ensure(URL_), null);
  });
});

test('non-https art is never fetched', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch(PNG);
    const cache = new CreativeCache(dir, { fetchImpl });
    assert.equal(await cache.ensure('http://cdn.example.test/a.png'), null);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a failed download resolves null instead of throwing', async () => {
  await withTempDir(async (dir) => {
    const cache = new CreativeCache(dir, { fetchImpl: fakeFetch(PNG, { ok: false }) });
    assert.equal(await cache.ensure(URL_), null);
  });
});

test('concurrent requests for the same art share one download', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch(PNG);
    const cache = new CreativeCache(dir, { fetchImpl });
    const [a, b, c] = await Promise.all([cache.ensure(URL_), cache.ensure(URL_), cache.ensure(URL_)]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(fetchImpl.calls.length, 1);
  });
});

test('ids are hex-only, so no path can be traversed', async () => {
  await withTempDir(async (dir) => {
    const cache = new CreativeCache(dir, { fetchImpl: fakeFetch(PNG) });
    for (const id of ['../../etc/passwd', '..\\..\\windows\\win.ini', 'abc', '', 'ZZZZ'.repeat(8)]) {
      assert.equal(cache.pathFor(id), null, `accepted id: ${id}`);
      assert.equal(cache.read(id), null);
    }
  });
});

test('reading an id that was never cached returns null', async () => {
  await withTempDir(async (dir) => {
    const cache = new CreativeCache(path.join(dir, 'sub'), { fetchImpl: fakeFetch(PNG) });
    assert.equal(cache.read('0'.repeat(32)), null);
  });
});

test('prefetch never rejects, whatever the network does', async () => {
  await withTempDir(async (dir) => {
    const cache = new CreativeCache(dir, {
      fetchImpl: async () => {
        throw new Error('down');
      },
    });
    await cache.prefetch([URL_, 'https://cdn.example.test/b.png']);
  });
});
