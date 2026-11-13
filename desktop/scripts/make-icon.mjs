// Generates build/icon.png — the app icon, drawn rather than checked in as a binary blob.
//
// Kept as a script so the mark can be adjusted in one place and regenerated, and so the repo
// carries the recipe rather than an opaque file nobody can edit. Pure Node: a small PNG encoder
// over zlib, no image dependency.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const SS = 2; // supersample factor — the corners and the glyph need the anti-aliasing
const W = SIZE * SS;

/**
 * The mark the app itself draws (`BrandMark`, `.brand-mark` in the renderer): an ink tile lit from
 * its top-left corner, the phone in one stroke, and a mint dot. Kept to the same three stops and
 * the same mint, so the taskbar, the installer and the first screen agree.
 */
const TILE_FROM = [0x2c, 0x2c, 0x30];
const TILE_MID = [0x15, 0x15, 0x17];
const TILE_TO = [0x05, 0x05, 0x06];
const INK_EDGE = [0xff, 0xff, 0xff];
const PAPER = [0xf6, 0xf6, 0xf4];
const MINT = [0x8f, 0xf2, 0xcc];

const canvas = new Uint8Array(W * W * 4);

const inRoundedRect = (x, y, left, top, right, bottom, r) => {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const put = (x, y, [r, g, b], a = 255) => {
  const i = (y * W + x) * 4;
  const src = a / 255;
  const dst = canvas[i + 3] / 255;
  const out = src + dst * (1 - src);
  if (out === 0) return;
  canvas[i] = (r * src + canvas[i] * dst * (1 - src)) / out;
  canvas[i + 1] = (g * src + canvas[i + 1] * dst * (1 - src)) / out;
  canvas[i + 2] = (b * src + canvas[i + 2] * dst * (1 - src)) / out;
  canvas[i + 3] = out * 255;
};

const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));

// Rounded-square tile, its gradient running corner to corner as the CSS one does (155deg), with
// a faint paper edge so the tile still has a shape on a black taskbar.
const pad = W * 0.06;
const tileR = W * 0.2;
const edge = W * 0.006;
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    if (!inRoundedRect(x, y, pad, pad, W - pad, W - pad, tileR)) continue;
    const t = Math.min(1, Math.max(0, (x * 0.42 + y * 0.9) / (W * 1.32)));
    put(x, y, t < 0.52 ? mix(TILE_FROM, TILE_MID, t / 0.52) : mix(TILE_MID, TILE_TO, (t - 0.52) / 0.48));
    const inside = inRoundedRect(x, y, pad + edge, pad + edge, W - pad - edge, W - pad - edge, tileR - edge);
    if (!inside) put(x, y, INK_EDGE, 44);
  }
}

// A phone outline, centred: the clearest one-glyph way to say "Android on your PC".
const phoneW = W * 0.30;
const phoneH = W * 0.52;
const left = (W - phoneW) / 2;
const top = (W - phoneH) / 2;
const stroke = W * 0.026;
const phoneR = W * 0.055;

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const outer = inRoundedRect(x, y, left, top, left + phoneW, top + phoneH, phoneR);
    const inner = inRoundedRect(
      x,
      y,
      left + stroke,
      top + stroke,
      left + phoneW - stroke,
      top + phoneH - stroke,
      phoneR - stroke / 2,
    );
    if (outer && !inner) put(x, y, PAPER, 245);
  }
}

// Speaker slot, so the glyph reads as a phone rather than a rectangle.
const slotW = phoneW * 0.30;
const slotH = stroke * 0.62;
const slotX = (W - slotW) / 2;
const slotY = top + stroke * 1.9;
for (let y = Math.floor(slotY); y < slotY + slotH; y++) {
  for (let x = Math.floor(slotX); x < slotX + slotW; x++) {
    if (inRoundedRect(x, y, slotX, slotY, slotX + slotW, slotY + slotH, slotH / 2)) {
      put(x, y, PAPER, 128);
    }
  }
}

// The dot: the one colour the brand owns, in the middle of the glass, with the glow the app gives it.
const dotR = W * 0.034;
const glowR = W * 0.13;
const cx = W / 2;
const cy = W / 2;
for (let y = Math.floor(cy - glowR); y <= cy + glowR; y++) {
  for (let x = Math.floor(cx - glowR); x <= cx + glowR; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= dotR) put(x, y, MINT, 255);
    // A quadratic falloff reads as light; a linear one reads as a second, larger disc.
    else if (d <= glowR) put(x, y, MINT, Math.round(70 * (1 - (d - dotR) / (glowR - dotR)) ** 2));
  }
}

// Downsample by averaging each SS×SS block.
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
        const alpha = canvas[i + 3];
        r += canvas[i] * alpha;
        g += canvas[i + 1] * alpha;
        b += canvas[i + 2] * alpha;
        a += alpha;
      }
    }
    const o = (y * SIZE + x) * 4;
    // Premultiplied average, undone — otherwise transparent pixels drag the colour toward black.
    out[o] = a ? Math.round(r / a) : 0;
    out[o + 1] = a ? Math.round(g / a) : 0;
    out[o + 2] = a ? Math.round(b / a) : 0;
    out[o + 3] = Math.round(a / (SS * SS));
  }
}

// ── Minimal PNG encoder ────────────────────────────────────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// 10..12 stay zero: deflate, adaptive filtering, no interlace.

// One filter byte (0 = None) per scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'build', 'icon.png');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, png);
console.log(`wrote ${dest} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
