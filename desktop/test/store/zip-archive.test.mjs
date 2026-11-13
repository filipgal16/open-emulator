import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../helpers.mjs';
import { makeZip } from './zip-fixture.mjs';

const { readZipDirectory, readZipEntry, extractZipEntry, ZipError } = loadDist('store/zip-archive.js');

/** Compressible but not trivially so, and large enough to cross many stream chunks. */
function payload(bytes) {
  const out = Buffer.alloc(bytes);
  let seed = 7;
  for (let i = 0; i < bytes; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = 0x41 + ((seed >>> 16) % 8);
  }
  return out;
}

test('the directory lists stored and deflated members with their real sizes', async () => {
  await withTempDir(async (dir) => {
    const zip = path.join(dir, 'a.zip');
    writeFileSync(zip, makeZip([['plain.txt', 'stored text', { method: 'stored' }], ['packed.txt', 'deflated text '.repeat(40)]]));

    const entries = readZipDirectory(zip);

    assert.deepEqual(entries.map((entry) => entry.name), ['plain.txt', 'packed.txt']);
    assert.equal(entries[0].method, 0);
    assert.equal(entries[1].method, 8);
    assert.equal(entries[1].size, 'deflated text '.repeat(40).length);
    assert.ok(entries[1].compressedSize < entries[1].size, 'the fixture really is compressed');
    assert.equal(readZipEntry(zip, entries[0], 1024).toString(), 'stored text');
    assert.equal(readZipEntry(zip, entries[1], 1024).toString(), 'deflated text '.repeat(40));
  });
});

test('a large member streams to disk byte for byte, reporting progress as it goes', async () => {
  await withTempDir(async (dir) => {
    const big = payload(3 * 1024 * 1024);
    const zip = path.join(dir, 'big.zip');
    writeFileSync(zip, makeZip([['readme.txt', 'hi'], ['big.bin', big], ['raw.bin', big.subarray(0, 70_000), { method: 'stored' }]]));

    const entries = readZipDirectory(zip);
    let reported = 0;
    let calls = 0;
    await extractZipEntry(zip, entries[1], path.join(dir, 'big.out'), (bytes) => {
      reported += bytes;
      calls += 1;
    });
    await extractZipEntry(zip, entries[2], path.join(dir, 'raw.out'));

    assert.ok(readFileSync(path.join(dir, 'big.out')).equals(big));
    assert.ok(readFileSync(path.join(dir, 'raw.out')).equals(big.subarray(0, 70_000)));
    assert.equal(reported, big.length, 'progress adds up to the member’s size');
    assert.ok(calls > 1, 'delivered in chunks, not read whole');
  });
});

test('an empty member extracts to an empty file', async () => {
  await withTempDir(async (dir) => {
    const zip = path.join(dir, 'empty.zip');
    writeFileSync(zip, makeZip([['nothing.txt', '', { method: 'stored' }], ['also-nothing.txt', '']]));

    const [stored, deflated] = readZipDirectory(zip);
    await extractZipEntry(zip, stored, path.join(dir, 'a'));
    await extractZipEntry(zip, deflated, path.join(dir, 'b'));

    assert.equal(readFileSync(path.join(dir, 'a')).length, 0);
    assert.equal(readFileSync(path.join(dir, 'b')).length, 0);
  });
});

test('zip64 archives are read through their zip64 record and extra fields', async () => {
  await withTempDir(async (dir) => {
    const data = payload(200_000);
    const zip = path.join(dir, 'z64.zip');
    writeFileSync(zip, makeZip([['first.apk', 'small one'], ['second.bin', data]], { zip64: true }));

    const entries = readZipDirectory(zip);

    assert.deepEqual(entries.map((entry) => entry.name), ['first.apk', 'second.bin']);
    assert.equal(entries[1].size, data.length, 'the size came from the zip64 extra, not the placeholder');
    assert.notEqual(entries[1].localHeaderOffset, 0xffffffff);
    await extractZipEntry(zip, entries[1], path.join(dir, 'out.bin'));
    assert.ok(readFileSync(path.join(dir, 'out.bin')).equals(data));
  });
});

test('a corrupted member is refused rather than handed on', async () => {
  await withTempDir(async (dir) => {
    const archive = makeZip([['data.txt', 'the original content', { method: 'stored' }]]);
    // Flip a byte inside the stored data; the CRC in the directory no longer matches.
    archive[30 + 'data.txt'.length + 2] ^= 0xff;
    const zip = path.join(dir, 'bad.zip');
    writeFileSync(zip, archive);

    const [entry] = readZipDirectory(zip);
    await assert.rejects(() => extractZipEntry(zip, entry, path.join(dir, 'out')), ZipError);
    assert.throws(() => readZipEntry(zip, entry, 1024), ZipError);
  });
});

test('something that is not a zip says so', async () => {
  await withTempDir(async (dir) => {
    const junk = path.join(dir, 'junk.bin');
    writeFileSync(junk, 'definitely not an archive, just some text that goes on for a while');
    assert.throws(() => readZipDirectory(junk), ZipError);

    const tiny = path.join(dir, 'tiny.bin');
    writeFileSync(tiny, 'PK');
    assert.throws(() => readZipDirectory(tiny), ZipError);
  });
});

test('a small read refuses a member over its limit before reading it', async () => {
  await withTempDir(async (dir) => {
    const zip = path.join(dir, 'a.zip');
    writeFileSync(zip, makeZip([['manifest.json', 'x'.repeat(5000)]]));
    const [entry] = readZipDirectory(zip);
    assert.throws(() => readZipEntry(zip, entry, 1000), /too large/);
  });
});
