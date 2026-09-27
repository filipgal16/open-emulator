import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { loadDist } from '../helpers.mjs';

const { renderWallpaper, WALLPAPER_SIZE } = loadDist('rom/wallpaper.js');

// Rendered once for the file: it is the slowest thing in the suite.
const png = renderWallpaper();

test('the wallpaper is a 2048x2048 8-bit RGB PNG', () => {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), WALLPAPER_SIZE);
  assert.equal(png.readUInt32BE(20), WALLPAPER_SIZE);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 2, 'colour type RGB');
});

test('the wallpaper stays within the size the image has room for', () => {
  assert.ok(png.length <= 2 * 1024 * 1024, `${png.length} bytes`);
});

test('the wallpaper is the same bytes every time — its hash decides whether the ROM is rebuilt', () => {
  assert.ok(renderWallpaper().equals(png));
});

test('the image data decodes to exactly one filtered row per scanline', () => {
  const idatAt = png.indexOf('IDAT');
  const length = png.readUInt32BE(idatAt - 4);
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length));
  assert.equal(raw.length, WALLPAPER_SIZE * (WALLPAPER_SIZE * 3 + 1));
});
