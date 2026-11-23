//! The default wallpaper for open-emulator Android, drawn rather than stored as a bitmap.
//!
//! Same night colours as the shell and the same phone as the app icon, so the launcher and the
//! desktop read as one product. The field stays dark and quiet through the middle, where the icon
//! labels sit, and the phone is centred so a portrait crop and a landscape crop both keep it.
//!
//! Every step is integer arithmetic, ported operation for operation from the TypeScript renderer,
//! so the pixels are identical on every machine and to the ones that renderer drew. (The PNG's
//! compressed bytes are this deflate's, not zlib's: same picture, its own file.)

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;

use crate::{fail, Result};

pub const WALLPAPER_SIZE: usize = 2048;

/// Android center-crops this square to both ~9:16 and ~16:9, which keeps the middle 1152². The
/// phone, glow included, sits inside that square.
const SAFE: i64 = 1152;

// Icon proportions, scaled up so the handset still reads behind a 5×5 grid:
// width 0.30, height 0.52, corner 0.055, stroke 0.035 of one unit.
// 1040 × 15/26 = 600, corner 1040 × 11/104 = 110, stroke 1040 × 7/104 = 70.
const PHONE_W: i64 = 600;
const PHONE_H: i64 = 1040;
const PHONE_R: i64 = 110;
const STROKE: i64 = 70;
/// Earpiece cut into the top bezel. Width is 0.30 of the phone; height is ~0.62 of the stroke.
const SLOT_W: i64 = 180;
const SLOT_H: i64 = 44;
const GLOW: i64 = 36;

type Rgb = [i64; 3];

const CORNER: Rgb = [0x0e, 0x10, 0x14];
const FIELD: Rgb = [0x15, 0x1b, 0x26];
const BLOOM_TOP: Rgb = [0x1a, 0x2c, 0x44];
const BLOOM_BOT: Rgb = [0x22, 0x3a, 0x58];
const CORE_TOP: Rgb = [0x24, 0x3c, 0x5e];
const CORE_BOT: Rgb = [0x2c, 0x4a, 0x72];
const STROKE_TOP: Rgb = [0x35, 0x5a, 0x86];
const STROKE_BOT: Rgb = [0x4d, 0x7d, 0xb5];
const GLASS_TOP: Rgb = [0x12, 0x18, 0x24];
const GLASS_BOT: Rgb = [0x18, 0x22, 0x34];
const SLOT: Rgb = [0x0c, 0x10, 0x16];
const HALO: Rgb = [0x6a, 0xa9, 0xff];

const U: i64 = 8;
const SIZE: i64 = WALLPAPER_SIZE as i64;
const BLOOM_LIM: i64 = (1080 * 2) * (1080 * 2);
const CORE_LIM: i64 = (720 * 2) * (720 * 2);
const CORNER_LIM: i64 = 2047 * 2047 * 2;

const PHONE_LEFT: i64 = (SIZE - PHONE_W) / 2;
const PHONE_TOP: i64 = (SIZE - PHONE_H) / 2;
const PHONE_RIGHT: i64 = PHONE_LEFT + PHONE_W;
const PHONE_BOTTOM: i64 = PHONE_TOP + PHONE_H;

const INNER_LEFT: i64 = PHONE_LEFT + STROKE;
const INNER_TOP: i64 = PHONE_TOP + STROKE;
const INNER_RIGHT: i64 = PHONE_RIGHT - STROKE;
const INNER_BOTTOM: i64 = PHONE_BOTTOM - STROKE;
const INNER_R: i64 = PHONE_R - STROKE / 2;

const SLOT_LEFT: i64 = (SIZE - SLOT_W) / 2;
const SLOT_TOP: i64 = PHONE_TOP + (STROKE - SLOT_H) / 2;
const SLOT_RIGHT: i64 = SLOT_LEFT + SLOT_W;
const SLOT_BOTTOM: i64 = SLOT_TOP + SLOT_H;

// Every geometric constant above is a whole number; the TypeScript computed them in floating
// point, and these assertions are what make the integer port the same picture.
const _: () = assert!((SIZE - PHONE_W) % 2 == 0 && (SIZE - PHONE_H) % 2 == 0);
const _: () = assert!(STROKE % 2 == 0 && (SIZE - SLOT_W) % 2 == 0 && (STROKE - SLOT_H) % 2 == 0);

/// Fixed-seed hash. Grain is a function of the pixel's 8×8 tile cell, not of a random source or
/// of call order, so the picture is the same on every machine and the tile repeats often enough
/// for deflate to keep the file small.
const SEED: u32 = 0x6d2b79f5;

const fn grain_table() -> [u8; 64] {
    let mut grain = [0u8; 64];
    let mut i = 0;
    while i < 64 {
        let i32_ = i as u32;
        let mut h = SEED ^ ((i32_ & 7) + 1).wrapping_mul(0x9e3779b1) ^ ((i32_ >> 3) + 1).wrapping_mul(0x85ebca6b);
        h = (h ^ (h >> 16)).wrapping_mul(0x7feb352d);
        h ^= h >> 15;
        h = (h ^ (h >> 16)).wrapping_mul(0x846ca68b);
        h ^= h >> 16;
        grain[i] = (h >> 24) as u8;
        i += 1;
    }
    grain
}

const GRAIN: [u8; 64] = grain_table();

const fn smooth_table() -> [i64; 257] {
    let mut smooth = [0i64; 257];
    let mut u = 0;
    while u <= 256 {
        let v = u as i64;
        smooth[u] = (v * v * (768 - 2 * v)) / 65536;
        u += 1;
    }
    smooth
}

const SMOOTH: [i64; 257] = smooth_table();

fn smooth(u: i64) -> i64 {
    if (0..=256).contains(&u) { SMOOTH[u as usize] } else { 0 }
}

/// `Math.floor(a / b)` for a positive `b`.
fn floor_div(a: i64, b: i64) -> i64 {
    a.div_euclid(b)
}

/// 8-bit endpoints, `t` in 0..256, result in 8.8 fixed point.
fn mix88(a: i64, b: i64, t: i64) -> i64 {
    (a << 8) + (b - a) * t
}

/// Both ends and the result are 8.8. `t` is 0..256.
fn lerp88(a: i64, b: i64, t: i64) -> i64 {
    a + floor_div((b - a) * t, 256)
}

/// Smooth 0 at `d2 >= lim`, smooth 256 at `d2 == 0`.
fn falloff(d2: i64, lim: i64) -> i64 {
    if d2 >= lim {
        return 0;
    }
    smooth(floor_div((lim - d2) * 256, lim))
}

/// One LSB of grain from the fixed-seed tile, so gradient steps don't turn into rings.
fn quant(v: i64, x: i64, y: i64) -> u8 {
    if v <= 0 {
        return 0;
    }
    if v >= 65535 {
        return 255;
    }
    let base = v >> 8;
    let frac = v & 255;
    let out = base + i64::from(frac > i64::from(GRAIN[(((y & 7) << 3) | (x & 7)) as usize]));
    out.min(255) as u8
}

fn put(rgb: &mut [u8], x: i64, y: i64, r: i64, g: i64, b: i64) {
    let i = ((y * SIZE + x) * 3) as usize;
    rgb[i] = quant(r, x, y);
    rgb[i + 1] = quant(g, x, y);
    rgb[i + 2] = quant(b, x, y);
}

fn along(uy: i64) -> i64 {
    floor_div((uy - PHONE_TOP * U) * 256, PHONE_H * U).clamp(0, 256)
}

fn gradient(top: Rgb, bot: Rgb, t: i64) -> Rgb {
    [mix88(top[0], bot[0], t), mix88(top[1], bot[1], t), mix88(top[2], bot[2], t)]
}

fn isqrt(n: i64) -> i64 {
    if n < 2 {
        return n.max(0);
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Signed distance in 1/8px. Negative inside. Integer square root only on the corner quadrants.
fn sd_round(ux: i64, uy: i64, cx: i64, cy: i64, hw: i64, hh: i64, rad: i64) -> i64 {
    let ax = (ux - cx).abs();
    let ay = (uy - cy).abs();
    let qx = ax - hw + rad;
    let qy = ay - hh + rad;
    let ox = qx.max(0);
    let oy = qy.max(0);
    let outside = if ox > 0 && oy > 0 { isqrt(ox * ox + oy * oy) } else { ox + oy };
    let inside = qx.max(qy).min(0);
    outside + inside - rad
}

fn bilerp(a: i64, b: i64, c: i64, d: i64, fx: i64, fy: i64) -> i64 {
    let top = a * (8 - fx) + b * fx;
    let bot = c * (8 - fx) + d * fx;
    floor_div(top * (8 - fy) + bot * fy, 64)
}

/// The field is a broad radial wash. Sampling it every 8px and interpolating is exact at the grid
/// and well under a colour level in between, which keeps the full-resolution pass cheap.
fn paint_field(rgb: &mut [u8]) {
    let cell = 8;
    let gw = SIZE / cell + 1;
    let mut grid = vec![0i64; (gw * gw * 3) as usize];
    let corner = CORNER.map(|c| c << 8);
    let field = FIELD.map(|c| c << 8);

    for gy in 0..gw {
        let py = gy * cell;
        let dy = 2 * py + 1 - SIZE;
        let dy2 = dy * dy;
        let v = floor_div(py * 256, SIZE - 1);
        let bloom_c: Rgb = std::array::from_fn(|k| lerp88(BLOOM_TOP[k] << 8, BLOOM_BOT[k] << 8, v));
        let core_c: Rgb = std::array::from_fn(|k| lerp88(CORE_TOP[k] << 8, CORE_BOT[k] << 8, v));
        for gx in 0..gw {
            let px = gx * cell;
            let dx = 2 * px + 1 - SIZE;
            let d2 = dx * dx + dy2;
            let vig = falloff(d2, CORNER_LIM);
            let bloom = falloff(d2, BLOOM_LIM);
            let core = falloff(d2, CORE_LIM);
            let o = ((gy * gw + gx) * 3) as usize;
            for k in 0..3 {
                let mut c = lerp88(corner[k], field[k], vig);
                c = lerp88(c, bloom_c[k], bloom);
                c = lerp88(c, core_c[k], core);
                grid[o + k] = c;
            }
        }
    }

    for y in 0..SIZE {
        let gy = y >> 3;
        let fy = y & 7;
        let row0 = gy * gw;
        let row1 = row0 + gw;
        for x in 0..SIZE {
            let gx = x >> 3;
            let fx = x & 7;
            let i00 = ((row0 + gx) * 3) as usize;
            let i10 = i00 + 3;
            let i01 = ((row1 + gx) * 3) as usize;
            let i11 = i01 + 3;
            let i = ((y * SIZE + x) * 3) as usize;
            for k in 0..3 {
                let c = bilerp(grid[i00 + k], grid[i10 + k], grid[i01 + k], grid[i11 + k], fx, fy);
                rgb[i + k] = quant(c, x, y);
            }
        }
    }
}

const OCX: i64 = ((PHONE_LEFT + PHONE_RIGHT) / 2) * U;
const OCY: i64 = ((PHONE_TOP + PHONE_BOTTOM) / 2) * U;
const OHW: i64 = (PHONE_W / 2) * U;
const OHH: i64 = (PHONE_H / 2) * U;
const ORAD: i64 = PHONE_R * U;

const ICX: i64 = ((INNER_LEFT + INNER_RIGHT) / 2) * U;
const ICY: i64 = ((INNER_TOP + INNER_BOTTOM) / 2) * U;
const IHW: i64 = ((INNER_RIGHT - INNER_LEFT) / 2) * U;
const IHH: i64 = ((INNER_BOTTOM - INNER_TOP) / 2) * U;
const IRAD: i64 = INNER_R * U;

const SCX: i64 = ((SLOT_LEFT + SLOT_RIGHT) / 2) * U;
const SCY: i64 = ((SLOT_TOP + SLOT_BOTTOM) / 2) * U;
const SHW: i64 = (SLOT_W / 2) * U;
const SHH: i64 = (SLOT_H / 2) * U;
const SRAD: i64 = SHH;

const SLOT_L: i64 = SLOT_LEFT * U;
const SLOT_T: i64 = SLOT_TOP * U;
const SLOT_R: i64 = SLOT_RIGHT * U;
const SLOT_B: i64 = SLOT_BOTTOM * U;

const _: () = assert!((PHONE_LEFT + PHONE_RIGHT) % 2 == 0 && (PHONE_TOP + PHONE_BOTTOM) % 2 == 0);
const _: () = assert!((INNER_LEFT + INNER_RIGHT) % 2 == 0 && (INNER_TOP + INNER_BOTTOM) % 2 == 0);
const _: () = assert!((SLOT_LEFT + SLOT_RIGHT) % 2 == 0 && (SLOT_TOP + SLOT_BOTTOM) % 2 == 0);
const _: () = assert!((INNER_RIGHT - INNER_LEFT) % 2 == 0 && (INNER_BOTTOM - INNER_TOP) % 2 == 0);
const _: () = assert!(SLOT_H % 2 == 0);

const GLOW_U: i64 = GLOW * U;
/// Farther than this from an edge, a pixel is entirely on one side (half-diagonal is ~0.71px).
const EDGE: i64 = 14;
const HALO_GAIN: i64 = 96;

fn glow88(field: i64, channel: usize, sd: i64, t: i64) -> i64 {
    if sd >= GLOW_U {
        return field;
    }
    let u = if sd <= 0 { 256 } else { 256 - floor_div(sd * 256, GLOW_U) };
    let fade = smooth(u);
    let k = floor_div(fade * HALO_GAIN, 256);
    let stroke = mix88(STROKE_TOP[channel], STROKE_BOT[channel], t);
    let lit = lerp88(stroke, HALO[channel] << 8, 80);
    lerp88(field, lit, k)
}

fn sample88(ux: i64, uy: i64, field: Rgb) -> Rgb {
    let t = along(uy);
    if (SLOT_L..SLOT_R).contains(&ux)
        && (SLOT_T..SLOT_B).contains(&uy)
        && sd_round(ux, uy, SCX, SCY, SHW, SHH, SRAD) < 0
    {
        return SLOT.map(|c| c << 8);
    }
    if sd_round(ux, uy, ICX, ICY, IHW, IHH, IRAD) < 0 {
        return gradient(GLASS_TOP, GLASS_BOT, t);
    }
    let sd = sd_round(ux, uy, OCX, OCY, OHW, OHH, ORAD);
    if sd < 0 {
        return gradient(STROKE_TOP, STROKE_BOT, t);
    }
    [glow88(field[0], 0, sd, t), glow88(field[1], 1, sd, t), glow88(field[2], 2, sd, t)]
}

fn paint_phone(rgb: &mut [u8]) {
    let (x0, y0) = (PHONE_LEFT - GLOW, PHONE_TOP - GLOW);
    let (x1, y1) = (PHONE_RIGHT + GLOW, PHONE_BOTTOM + GLOW);

    for y in y0..y1 {
        for x in x0..x1 {
            let ux = x * U + 4;
            let uy = y * U + 4;
            let sd_o = sd_round(ux, uy, OCX, OCY, OHW, OHH, ORAD);
            let near_slot = x >= SLOT_LEFT - 2 && x < SLOT_RIGHT + 2 && y >= SLOT_TOP - 2 && y < SLOT_BOTTOM + 2;
            let sd_s = if near_slot { sd_round(ux, uy, SCX, SCY, SHW, SHH, SRAD) } else { 999 };
            let sd_i = if sd_o < EDGE { sd_round(ux, uy, ICX, ICY, IHW, IHH, IRAD) } else { 999 };
            let near = |sd: i64| sd > -EDGE && sd < EDGE;
            let edge = near(sd_o) || near(sd_i) || near(sd_s);
            let i = ((y * SIZE + x) * 3) as usize;

            if !edge && sd_s < -EDGE {
                put(rgb, x, y, SLOT[0] << 8, SLOT[1] << 8, SLOT[2] << 8);
                continue;
            }
            if !edge && sd_o >= EDGE {
                if sd_o < GLOW_U {
                    let t = along(uy);
                    let r = glow88(i64::from(rgb[i]) << 8, 0, sd_o, t);
                    let g = glow88(i64::from(rgb[i + 1]) << 8, 1, sd_o, t);
                    let b = glow88(i64::from(rgb[i + 2]) << 8, 2, sd_o, t);
                    put(rgb, x, y, r, g, b);
                }
                continue;
            }
            if !edge && sd_i <= -EDGE {
                let [r, g, b] = gradient(GLASS_TOP, GLASS_BOT, along(uy));
                put(rgb, x, y, r, g, b);
                continue;
            }
            if !edge {
                let [r, g, b] = gradient(STROKE_TOP, STROKE_BOT, along(uy));
                put(rgb, x, y, r, g, b);
                continue;
            }

            let field: Rgb = [i64::from(rgb[i]) << 8, i64::from(rgb[i + 1]) << 8, i64::from(rgb[i + 2]) << 8];
            let mut sum = [0i64; 3];
            for sy in 0..4 {
                for sx in 0..4 {
                    let sample = sample88(x * U + sx * 2 + 1, y * U + sy * 2 + 1, field);
                    for k in 0..3 {
                        sum[k] += sample[k];
                    }
                }
            }
            put(rgb, x, y, floor_div(sum[0], 16), floor_div(sum[1], 16), floor_div(sum[2], 16));
        }
    }
}

/// Up filtering: each row of this picture is almost the row above it, and deflate keeps those
/// small deltas. None would store the gradient raw and miss the size budget.
fn encode_png(rgb: &[u8]) -> Result<Vec<u8>> {
    let size = WALLPAPER_SIZE;
    let stride = size * 3;
    let mut raw = vec![0u8; size * (stride + 1)];
    for y in 0..size {
        let dest = y * (stride + 1);
        raw[dest] = 2;
        let row = y * stride;
        for i in 0..stride {
            let up = if y == 0 { 0 } else { rgb[row - stride + i] };
            raw[dest + 1 + i] = rgb[row + i].wrapping_sub(up);
        }
    }

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&(size as u32).to_be_bytes());
    ihdr[4..8].copy_from_slice(&(size as u32).to_be_bytes());
    ihdr[8] = 8;
    ihdr[9] = 2;

    // Level 6, not 9: measured on this picture, 9 saves 40 KB (1.66 vs 1.70 MB) and costs nine
    // seconds more, and the builder renders it on the user's machine.
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&raw)?;
    let idat = encoder.finish()?;

    let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &idat);
    chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut crc = crc32fast::Hasher::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc.finalize().to_be_bytes());
}

/// The raw 2048×2048 RGB pixels, three bytes each, row by row.
pub fn render_wallpaper_pixels() -> Result<Vec<u8>> {
    let margin = (SIZE - SAFE) / 2;
    if PHONE_LEFT - GLOW < margin
        || PHONE_TOP - GLOW < margin
        || PHONE_RIGHT + GLOW > SIZE - margin
        || PHONE_BOTTOM + GLOW > SIZE - margin
    {
        fail!("phone sits outside the center crop");
    }
    let mut rgb = vec![0u8; WALLPAPER_SIZE * WALLPAPER_SIZE * 3];
    paint_field(&mut rgb);
    paint_phone(&mut rgb);
    Ok(rgb)
}

/// The wallpaper as a PNG file.
pub fn render_wallpaper() -> Result<Vec<u8>> {
    encode_png(&render_wallpaper_pixels()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::u32be;
    use std::io::Read;
    use std::sync::LazyLock;

    // Rendered once for the module: it is the slowest thing in the suite.
    static PNG: LazyLock<Vec<u8>> = LazyLock::new(|| render_wallpaper().unwrap());

    #[test]
    fn the_wallpaper_is_a_2048x2048_8_bit_rgb_png() {
        let png = &*PNG;
        assert_eq!(png[0..8], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32be(png, 16) as usize, WALLPAPER_SIZE);
        assert_eq!(u32be(png, 20) as usize, WALLPAPER_SIZE);
        assert_eq!(png[24], 8, "bit depth");
        assert_eq!(png[25], 2, "colour type RGB");
    }

    #[test]
    fn the_wallpaper_stays_within_the_size_the_image_has_room_for() {
        assert!(PNG.len() <= 2 * 1024 * 1024, "{} bytes", PNG.len());
    }

    #[test]
    fn the_wallpaper_is_the_same_bytes_every_time() {
        // Its hash decides whether the ROM is rebuilt.
        assert_eq!(render_wallpaper().unwrap(), *PNG);
    }

    #[test]
    fn the_image_data_decodes_to_exactly_one_filtered_row_per_scanline() {
        let png = &*PNG;
        let idat_at = png.windows(4).position(|w| w == b"IDAT").unwrap();
        let length = u32be(png, idat_at - 4) as usize;
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(&png[idat_at + 4..idat_at + 4 + length]).read_to_end(&mut raw).unwrap();
        assert_eq!(raw.len(), WALLPAPER_SIZE * (WALLPAPER_SIZE * 3 + 1));
    }

    #[test]
    fn the_pixels_are_the_ones_the_typescript_renderer_drew() {
        // SHA-256 of the decoded RGB pixels of the TypeScript renderer's PNG (desktop v0.2.0).
        // Any drift in the integer arithmetic of the port changes it.
        use sha2::{Digest, Sha256};
        let pixels = render_wallpaper_pixels().unwrap();
        assert_eq!(
            crate::bytes::hex(&Sha256::digest(&pixels)),
            "07e9d825f0de01dbde299ec89b3628b9d1d467487a138fc02b7898a107776d6e"
        );
    }
}
