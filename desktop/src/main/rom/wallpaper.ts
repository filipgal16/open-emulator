/**
 * The default wallpaper for open-emulator Android, drawn rather than stored as a bitmap.
 *
 * Same night colours as the shell and the same phone as the app icon, so the launcher and the
 * desktop read as one product. The field stays dark and quiet through the middle, where the
 * icon labels sit, and the phone is centred so a portrait crop and a landscape crop both keep it.
 */

import { constants, crc32, deflateSync } from 'zlib';

export const WALLPAPER_SIZE = 2048;

/**
 * Android center-crops this square to both ~9:16 and ~16:9, which keeps the middle 1152².
 * The phone, glow included, sits inside that square.
 */
const SAFE = 1152;

/**
 * Icon proportions, scaled up so the handset still reads behind a 5×5 grid:
 * width 0.30, height 0.52, corner 0.055, stroke 0.035 of one unit.
 * 1040 × 15/26 = 600, corner 1040 × 11/104 = 110, stroke 1040 × 7/104 = 70.
 */
const PHONE_W = 600;
const PHONE_H = 1040;
const PHONE_R = 110;
const STROKE = 70;
/** Earpiece cut into the top bezel. Width is 0.30 of the phone; height is ~0.62 of the stroke. */
const SLOT_W = 180;
const SLOT_H = 44;
const GLOW = 36;

const CORNER: readonly [number, number, number] = [0x0e, 0x10, 0x14];
const FIELD: readonly [number, number, number] = [0x15, 0x1b, 0x26];
const BLOOM_TOP: readonly [number, number, number] = [0x1a, 0x2c, 0x44];
const BLOOM_BOT: readonly [number, number, number] = [0x22, 0x3a, 0x58];
const CORE_TOP: readonly [number, number, number] = [0x24, 0x3c, 0x5e];
const CORE_BOT: readonly [number, number, number] = [0x2c, 0x4a, 0x72];
const STROKE_TOP: readonly [number, number, number] = [0x35, 0x5a, 0x86];
const STROKE_BOT: readonly [number, number, number] = [0x4d, 0x7d, 0xb5];
const GLASS_TOP: readonly [number, number, number] = [0x12, 0x18, 0x24];
const GLASS_BOT: readonly [number, number, number] = [0x18, 0x22, 0x34];
const SLOT: readonly [number, number, number] = [0x0c, 0x10, 0x16];
const HALO: readonly [number, number, number] = [0x6a, 0xa9, 0xff];

const U = 8;
const SIZE = WALLPAPER_SIZE;
const BLOOM_LIM = (1080 * 2) * (1080 * 2);
const CORE_LIM = (720 * 2) * (720 * 2);
const CORNER_LIM = 2047 * 2047 * 2;

const PHONE_LEFT = (SIZE - PHONE_W) / 2;
const PHONE_TOP = (SIZE - PHONE_H) / 2;
const PHONE_RIGHT = PHONE_LEFT + PHONE_W;
const PHONE_BOTTOM = PHONE_TOP + PHONE_H;

const INNER_LEFT = PHONE_LEFT + STROKE;
const INNER_TOP = PHONE_TOP + STROKE;
const INNER_RIGHT = PHONE_RIGHT - STROKE;
const INNER_BOTTOM = PHONE_BOTTOM - STROKE;
const INNER_R = PHONE_R - STROKE / 2;

const SLOT_LEFT = (SIZE - SLOT_W) / 2;
const SLOT_TOP = PHONE_TOP + (STROKE - SLOT_H) / 2;
const SLOT_RIGHT = SLOT_LEFT + SLOT_W;
const SLOT_BOTTOM = SLOT_TOP + SLOT_H;

type RGB = readonly [number, number, number];

/** 4×4 Bayer thresholds. The tile repeats, so the grain is deterministic and deflate can reuse it. */
const BAYER = new Uint8Array([
  8, 136, 40, 168, 200, 72, 232, 104, 56, 184, 24, 152, 248, 120, 216, 88,
]);

const SMOOTH = new Uint16Array(257);
for (let u = 0; u <= 256; u++) {
  SMOOTH[u] = Math.floor((u * u * (768 - 2 * u)) / 65536);
}

/** 8-bit endpoints, `t` in 0..256, result in 8.8 fixed point. */
function mix88(a: number, b: number, t: number): number {
  return (a << 8) + (b - a) * t;
}

/** Both ends and the result are 8.8. `t` is 0..256. */
function lerp88(a: number, b: number, t: number): number {
  return a + Math.floor(((b - a) * t) / 256);
}

/** Smooth 0 at `d2 >= lim`, smooth 256 at `d2 === 0`. */
function falloff(d2: number, lim: number): number {
  if (d2 >= lim) return 0;
  const u = Math.floor(((lim - d2) * 256) / lim);
  return SMOOTH[u] ?? 0;
}

/**
 * One LSB of fixed-pattern grain, from the Bayer tile rather than `Math.random`, so every
 * machine writes the same bytes and flat gradient steps don't show as rings.
 */
function quant(v: number, x: number, y: number): number {
  if (v <= 0) return 0;
  if (v >= 65535) return 255;
  const base = v >> 8;
  const frac = v & 255;
  const out = base + (frac > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0) ? 1 : 0);
  return out > 255 ? 255 : out;
}

function put(rgb: Buffer, x: number, y: number, r: number, g: number, b: number): void {
  const i = (y * SIZE + x) * 3;
  rgb[i] = quant(r, x, y);
  rgb[i + 1] = quant(g, x, y);
  rgb[i + 2] = quant(b, x, y);
}

function along(uy: number): number {
  const t = Math.floor(((uy - PHONE_TOP * U) * 256) / (PHONE_H * U));
  if (t <= 0) return 0;
  if (t >= 256) return 256;
  return t;
}

function gradient(top: RGB, bot: RGB, t: number): [number, number, number] {
  return [mix88(top[0], bot[0], t), mix88(top[1], bot[1], t), mix88(top[2], bot[2], t)];
}

function isqrt(n: number): number {
  if (n < 2) return n > 0 ? n : 0;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

/** Signed distance in 1/8px. Negative inside. Integer square root only on the corner quadrants. */
function sdRound(ux: number, uy: number, cx: number, cy: number, hw: number, hh: number, rad: number): number {
  const ax = ux > cx ? ux - cx : cx - ux;
  const ay = uy > cy ? uy - cy : cy - uy;
  const qx = ax - hw + rad;
  const qy = ay - hh + rad;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const outside = ox > 0 && oy > 0 ? isqrt(ox * ox + oy * oy) : ox + oy;
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - rad;
}

function paintField(rgb: Buffer): void {
  const cornerR = CORNER[0] << 8;
  const cornerG = CORNER[1] << 8;
  const cornerB = CORNER[2] << 8;
  const fieldR = FIELD[0] << 8;
  const fieldG = FIELD[1] << 8;
  const fieldB = FIELD[2] << 8;

  for (let y = 0; y < SIZE; y++) {
    const dy = 2 * y + 1 - SIZE;
    const dy2 = dy * dy;
    const v = Math.floor((y * 256) / (SIZE - 1));
    const bloomR = lerp88(BLOOM_TOP[0] << 8, BLOOM_BOT[0] << 8, v);
    const bloomG = lerp88(BLOOM_TOP[1] << 8, BLOOM_BOT[1] << 8, v);
    const bloomB = lerp88(BLOOM_TOP[2] << 8, BLOOM_BOT[2] << 8, v);
    const coreR = lerp88(CORE_TOP[0] << 8, CORE_BOT[0] << 8, v);
    const coreG = lerp88(CORE_TOP[1] << 8, CORE_BOT[1] << 8, v);
    const coreB = lerp88(CORE_TOP[2] << 8, CORE_BOT[2] << 8, v);
    for (let x = 0; x < SIZE; x++) {
      const dx = 2 * x + 1 - SIZE;
      const d2 = dx * dx + dy2;
      const vig = falloff(d2, CORNER_LIM);
      const b = falloff(d2, BLOOM_LIM);
      const c = falloff(d2, CORE_LIM);
      let r = lerp88(cornerR, fieldR, vig);
      let g = lerp88(cornerG, fieldG, vig);
      let bl = lerp88(cornerB, fieldB, vig);
      r = lerp88(r, bloomR, b);
      g = lerp88(g, bloomG, b);
      bl = lerp88(bl, bloomB, b);
      r = lerp88(r, coreR, c);
      g = lerp88(g, coreG, c);
      bl = lerp88(bl, coreB, c);
      const i = (y * SIZE + x) * 3;
      rgb[i] = quant(r, x, y);
      rgb[i + 1] = quant(g, x, y);
      rgb[i + 2] = quant(bl, x, y);
    }
  }
}

const OCX = ((PHONE_LEFT + PHONE_RIGHT) / 2) * U;
const OCY = ((PHONE_TOP + PHONE_BOTTOM) / 2) * U;
const OHW = (PHONE_W / 2) * U;
const OHH = (PHONE_H / 2) * U;
const ORAD = PHONE_R * U;

const ICX = ((INNER_LEFT + INNER_RIGHT) / 2) * U;
const ICY = ((INNER_TOP + INNER_BOTTOM) / 2) * U;
const IHW = ((INNER_RIGHT - INNER_LEFT) / 2) * U;
const IHH = ((INNER_BOTTOM - INNER_TOP) / 2) * U;
const IRAD = INNER_R * U;

const SCX = ((SLOT_LEFT + SLOT_RIGHT) / 2) * U;
const SCY = ((SLOT_TOP + SLOT_BOTTOM) / 2) * U;
const SHW = (SLOT_W / 2) * U;
const SHH = (SLOT_H / 2) * U;
const SRAD = SHH;

const SLOT_L = SLOT_LEFT * U;
const SLOT_T = SLOT_TOP * U;
const SLOT_R = SLOT_RIGHT * U;
const SLOT_B = SLOT_BOTTOM * U;

const GLOW_U = GLOW * U;
/** Farther than this from an edge, a pixel is entirely on one side (half-diagonal is ~0.71px). */
const EDGE = 14;
const HALO_GAIN = 96;

function glow88(field: number, channel: 0 | 1 | 2, sd: number, t: number): number {
  if (sd >= GLOW_U) return field;
  const u = sd <= 0 ? 256 : 256 - Math.floor((sd * 256) / GLOW_U);
  const fade = SMOOTH[u] ?? 0;
  const k = Math.floor((fade * HALO_GAIN) / 256);
  const stroke = mix88(STROKE_TOP[channel], STROKE_BOT[channel], t);
  const lit = lerp88(stroke, HALO[channel] << 8, 80);
  return lerp88(field, lit, k);
}

function sample88(ux: number, uy: number, field: [number, number, number]): [number, number, number] {
  const t = along(uy);
  if (ux >= SLOT_L && ux < SLOT_R && uy >= SLOT_T && uy < SLOT_B) {
    if (sdRound(ux, uy, SCX, SCY, SHW, SHH, SRAD) < 0) {
      return [SLOT[0] << 8, SLOT[1] << 8, SLOT[2] << 8];
    }
  }
  if (sdRound(ux, uy, ICX, ICY, IHW, IHH, IRAD) < 0) return gradient(GLASS_TOP, GLASS_BOT, t);
  const sd = sdRound(ux, uy, OCX, OCY, OHW, OHH, ORAD);
  if (sd < 0) return gradient(STROKE_TOP, STROKE_BOT, t);
  return [
    glow88(field[0], 0, sd, t),
    glow88(field[1], 1, sd, t),
    glow88(field[2], 2, sd, t),
  ];
}

function paintPhone(rgb: Buffer): void {
  const x0 = PHONE_LEFT - GLOW;
  const y0 = PHONE_TOP - GLOW;
  const x1 = PHONE_RIGHT + GLOW;
  const y1 = PHONE_BOTTOM + GLOW;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ux = x * U + 4;
      const uy = y * U + 4;
      const sdO = sdRound(ux, uy, OCX, OCY, OHW, OHH, ORAD);
      const nearSlot =
        x >= SLOT_LEFT - 2 && x < SLOT_RIGHT + 2 && y >= SLOT_TOP - 2 && y < SLOT_BOTTOM + 2;
      const sdS = nearSlot ? sdRound(ux, uy, SCX, SCY, SHW, SHH, SRAD) : 999;
      const sdI = sdO < EDGE ? sdRound(ux, uy, ICX, ICY, IHW, IHH, IRAD) : 999;
      const edge =
        (sdO > -EDGE && sdO < EDGE) ||
        (sdI > -EDGE && sdI < EDGE) ||
        (sdS > -EDGE && sdS < EDGE);

      if (!edge && sdS < -EDGE) {
        put(rgb, x, y, SLOT[0] << 8, SLOT[1] << 8, SLOT[2] << 8);
        continue;
      }
      if (!edge && sdO >= EDGE) {
        if (sdO < GLOW_U) {
          const t = along(uy);
          const i = (y * SIZE + x) * 3;
          put(
            rgb,
            x,
            y,
            glow88(rgb[i] << 8, 0, sdO, t),
            glow88(rgb[i + 1] << 8, 1, sdO, t),
            glow88(rgb[i + 2] << 8, 2, sdO, t),
          );
        }
        continue;
      }
      if (!edge && sdI <= -EDGE) {
        const [r, g, b] = gradient(GLASS_TOP, GLASS_BOT, along(uy));
        put(rgb, x, y, r, g, b);
        continue;
      }
      if (!edge) {
        const [r, g, b] = gradient(STROKE_TOP, STROKE_BOT, along(uy));
        put(rgb, x, y, r, g, b);
        continue;
      }

      const i = (y * SIZE + x) * 3;
      const field: [number, number, number] = [rgb[i] << 8, rgb[i + 1] << 8, rgb[i + 2] << 8];
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const [sr, sg, sb] = sample88(x * U + sx * 2 + 1, y * U + sy * 2 + 1, field);
          r += sr;
          g += sg;
          b += sb;
        }
      }
      put(rgb, x, y, Math.floor(r / 16), Math.floor(g / 16), Math.floor(b / 16));
    }
  }
}

/**
 * Up filtering: each row of this picture is almost the row above it, and deflate keeps those
 * small deltas. None would store the gradient raw and miss the size budget.
 */
function encodePng(rgb: Buffer): Buffer {
  const stride = SIZE * 3;
  const raw = Buffer.alloc(SIZE * (stride + 1));
  for (let y = 0; y < SIZE; y++) {
    const dest = y * (stride + 1);
    raw[dest] = 2;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const up = y === 0 ? 0 : rgb[row - stride + i];
      raw[dest + 1 + i] = (rgb[row + i] - up) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = deflateSync(raw, { level: 9, strategy: constants.Z_FILTERED });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, sum]);
}

export function renderWallpaper(): Buffer {
  const margin = (SIZE - SAFE) / 2;
  if (
    PHONE_LEFT - GLOW < margin ||
    PHONE_TOP - GLOW < margin ||
    PHONE_RIGHT + GLOW > SIZE - margin ||
    PHONE_BOTTOM + GLOW > SIZE - margin
  ) {
    throw new Error('phone sits outside the center crop');
  }
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  paintField(rgb);
  paintPhone(rgb);
  return encodePng(rgb);
}
