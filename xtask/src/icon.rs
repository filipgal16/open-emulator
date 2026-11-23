//! `cargo xtask icon`: draws the app icon and writes it where the apps look for it.
//!
//! Kept as code so the mark can be adjusted in one place and regenerated, and so the repo carries
//! the recipe rather than an opaque file nobody can edit. The mark is the one the app itself draws
//! (`BrandMark`): an ink tile lit from its top-left corner, the phone in one stroke, and a mint
//! dot. Every size is drawn at its own resolution, because shrinking a 512 px bitmap to 16 px
//! blurs the stroke the small sizes depend on.
//!
//! Outputs:
//! - `crates/oe-ui/assets/icon-512.png`, 512 px: for the README and release pages.
//! - `crates/oe-ui/assets/icon.png`, 256 px: the window and taskbar icon of the Rust app.
//! - `crates/oe-ui/assets/icon.ico`: 16, 24, 32, 48, 64, 128 and 256 px, for the executable.

mod ico;

use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::ZlibEncoder;

/// The ICO sizes Windows picks from: the notification area, the taskbar, Explorer's views.
const ICO_SIZES: [usize; 7] = [16, 24, 32, 48, 64, 128, 256];

type Rgb = [u8; 3];

const TILE_FROM: Rgb = [0x2c, 0x2c, 0x30];
const TILE_MID: Rgb = [0x15, 0x15, 0x17];
const TILE_TO: Rgb = [0x05, 0x05, 0x06];
const INK_EDGE: Rgb = [0xff, 0xff, 0xff];
const PAPER: Rgb = [0xf6, 0xf6, 0xf4];
const MINT: Rgb = [0x8f, 0xf2, 0xcc];

/// A straight-alpha RGBA canvas that the shapes are composited onto, `w` pixels square.
struct Canvas {
    w: usize,
    px: Vec<u8>,
}

impl Canvas {
    fn new(w: usize) -> Self {
        Canvas { w, px: vec![0; w * w * 4] }
    }

    /// Source-over compositing of one colour at alpha `a` (0 to 255).
    fn put(&mut self, x: usize, y: usize, [r, g, b]: Rgb, a: f64) {
        let i = (y * self.w + x) * 4;
        let src = a / 255.0;
        let dst = f64::from(self.px[i + 3]) / 255.0;
        let out = src + dst * (1.0 - src);
        if out == 0.0 {
            return;
        }
        let mix = |new: u8, old: u8| ((f64::from(new) * src + f64::from(old) * dst * (1.0 - src)) / out) as u8;
        self.px[i] = mix(r, self.px[i]);
        self.px[i + 1] = mix(g, self.px[i + 1]);
        self.px[i + 2] = mix(b, self.px[i + 2]);
        self.px[i + 3] = (out * 255.0) as u8;
    }
}

fn in_rounded_rect(x: f64, y: f64, left: f64, top: f64, right: f64, bottom: f64, r: f64) -> bool {
    if x < left || x > right || y < top || y > bottom {
        return false;
    }
    let cx = x.clamp(left + r, right - r);
    let cy = y.clamp(top + r, bottom - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

fn lerp(a: Rgb, b: Rgb, t: f64) -> Rgb {
    std::array::from_fn(|i| (f64::from(a[i]) + (f64::from(b[i]) - f64::from(a[i])) * t).round() as u8)
}

/// The mark at `size` px, supersampled `ss` times per axis: the corners and the glyph need the
/// anti-aliasing. Straight-alpha RGBA, `size * size * 4` bytes.
fn render(size: usize, ss: usize) -> Vec<u8> {
    let w = size * ss;
    let wf = w as f64;
    let mut c = Canvas::new(w);

    // Rounded-square tile, its gradient running corner to corner as the CSS one does (155deg),
    // with a faint paper edge so the tile still has a shape on a black taskbar.
    let pad = wf * 0.06;
    let tile_r = wf * 0.2;
    let edge = wf * 0.006;
    for y in 0..w {
        for x in 0..w {
            let (xf, yf) = (x as f64, y as f64);
            if !in_rounded_rect(xf, yf, pad, pad, wf - pad, wf - pad, tile_r) {
                continue;
            }
            let t = ((xf * 0.42 + yf * 0.9) / (wf * 1.32)).clamp(0.0, 1.0);
            let colour = if t < 0.52 { lerp(TILE_FROM, TILE_MID, t / 0.52) } else { lerp(TILE_MID, TILE_TO, (t - 0.52) / 0.48) };
            c.put(x, y, colour, 255.0);
            if !in_rounded_rect(xf, yf, pad + edge, pad + edge, wf - pad - edge, wf - pad - edge, tile_r - edge) {
                c.put(x, y, INK_EDGE, 44.0);
            }
        }
    }

    // A phone outline, centred: the clearest one-glyph way to say "Android on your PC".
    let phone_w = wf * 0.30;
    let phone_h = wf * 0.52;
    let left = (wf - phone_w) / 2.0;
    let top = (wf - phone_h) / 2.0;
    let stroke = wf * 0.026;
    let phone_r = wf * 0.055;
    for y in 0..w {
        for x in 0..w {
            let (xf, yf) = (x as f64, y as f64);
            let outer = in_rounded_rect(xf, yf, left, top, left + phone_w, top + phone_h, phone_r);
            let inner = in_rounded_rect(
                xf,
                yf,
                left + stroke,
                top + stroke,
                left + phone_w - stroke,
                top + phone_h - stroke,
                phone_r - stroke / 2.0,
            );
            if outer && !inner {
                c.put(x, y, PAPER, 245.0);
            }
        }
    }

    // Speaker slot, so the glyph reads as a phone rather than a rectangle.
    let slot_w = phone_w * 0.30;
    let slot_h = stroke * 0.62;
    let slot_x = (wf - slot_w) / 2.0;
    let slot_y = top + stroke * 1.9;
    let mut y = slot_y.floor();
    while y < slot_y + slot_h {
        let mut x = slot_x.floor();
        while x < slot_x + slot_w {
            if in_rounded_rect(x, y, slot_x, slot_y, slot_x + slot_w, slot_y + slot_h, slot_h / 2.0) {
                c.put(x as usize, y as usize, PAPER, 128.0);
            }
            x += 1.0;
        }
        y += 1.0;
    }

    // The dot: the one colour the brand owns, in the middle of the glass, with the glow the app
    // gives it.
    let dot_r = wf * 0.034;
    let glow_r = wf * 0.13;
    let (cx, cy) = (wf / 2.0, wf / 2.0);
    let mut y = (cy - glow_r).floor();
    while y <= cy + glow_r {
        let mut x = (cx - glow_r).floor();
        while x <= cx + glow_r {
            let d = (x - cx).hypot(y - cy);
            if d <= dot_r {
                c.put(x as usize, y as usize, MINT, 255.0);
            } else if d <= glow_r {
                // A quadratic falloff reads as light; a linear one reads as a second, larger disc.
                c.put(x as usize, y as usize, MINT, (70.0 * (1.0 - (d - dot_r) / (glow_r - dot_r)).powi(2)).round());
            }
            x += 1.0;
        }
        y += 1.0;
    }

    downsample(&c, size, ss)
}

/// Averages each `ss`×`ss` block, weighting colour by alpha: otherwise transparent pixels drag the
/// colour toward black.
fn downsample(c: &Canvas, size: usize, ss: usize) -> Vec<u8> {
    let mut out = vec![0u8; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            let (mut r, mut g, mut b, mut a) = (0u64, 0u64, 0u64, 0u64);
            for dy in 0..ss {
                for dx in 0..ss {
                    let i = ((y * ss + dy) * c.w + (x * ss + dx)) * 4;
                    let alpha = u64::from(c.px[i + 3]);
                    r += u64::from(c.px[i]) * alpha;
                    g += u64::from(c.px[i + 1]) * alpha;
                    b += u64::from(c.px[i + 2]) * alpha;
                    a += alpha;
                }
            }
            let o = (y * size + x) * 4;
            let avg = |sum: u64| if a == 0 { 0 } else { (sum as f64 / a as f64).round() as u8 };
            out[o] = avg(r);
            out[o + 1] = avg(g);
            out[o + 2] = avg(b);
            out[o + 3] = (a as f64 / (ss * ss) as f64).round() as u8;
        }
    }
    out
}

/// Supersampling per size: the big sizes have pixels enough that 2× smooths the edge, the small
/// ones need more samples to keep the stroke from shimmering.
fn supersample_for(size: usize) -> usize {
    if size >= 128 { 2 } else { 4 }
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut crc = crc32fast::Hasher::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc.finalize().to_be_bytes());
}

/// A PNG of straight-alpha RGBA pixels: 8-bit RGBA, no filtering, maximum deflate.
fn encode_png(rgba: &[u8], size: usize) -> Result<Vec<u8>, String> {
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(size as u32).to_be_bytes());
    header.extend_from_slice(&(size as u32).to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);

    let mut raw = Vec::with_capacity(size * (size * 4 + 1));
    for row in rgba.chunks_exact(size * 4) {
        raw.push(0); // filter: None
        raw.extend_from_slice(row);
    }
    let mut zlib = ZlibEncoder::new(Vec::new(), Compression::best());
    zlib.write_all(&raw).map_err(|e| e.to_string())?;
    let compressed = zlib.finish().map_err(|e| e.to_string())?;

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    push_chunk(&mut png, b"IHDR", &header);
    push_chunk(&mut png, b"IDAT", &compressed);
    push_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

fn write(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, data).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    println!("wrote {} ({:.1} KB)", path.display(), data.len() as f64 / 1024.0);
    Ok(())
}

/// Draws every output into `root` (the repository root) and writes it.
fn generate(root: &Path) -> Result<(), String> {
    let png_at = |size: usize| encode_png(&render(size, supersample_for(size)), size);

    let assets: PathBuf = root.join("crates").join("oe-ui").join("assets");
    write(&assets.join("icon-512.png"), &encode_png(&render(512, 2), 512)?)?;
    write(&assets.join("icon.png"), &png_at(256)?)?;

    let mut images = Vec::new();
    for size in ICO_SIZES {
        images.push(ico::IcoImage { size, png: png_at(size)? });
    }
    write(&assets.join("icon.ico"), &ico::encode(&images)?)
}

pub fn run(args: &[String]) -> Result<(), String> {
    if let Some(extra) = args.first() {
        return Err(format!("`cargo xtask icon` takes no arguments (got `{extra}`)"));
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().ok_or("cannot find the repository root")?;
    generate(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mark_has_a_transparent_corner_an_ink_tile_and_a_mint_dot() {
        let size = 64;
        let px = render(size, 2);
        let at = |x: usize, y: usize| &px[(y * size + x) * 4..(y * size + x) * 4 + 4];
        assert_eq!(at(0, 0)[3], 0, "outside the tile is transparent");
        assert!(at(8, 32)[3] == 255 && at(8, 32)[0] < 0x40, "the tile is dark ink");
        let dot = at(size / 2, size / 2);
        assert!(dot[1] > 0xe0 && dot[3] == 255, "the dot is mint, got {dot:?}");
    }

    #[test]
    fn a_png_has_its_signature_header_and_a_crc_that_checks() {
        let png = encode_png(&render(16, 4), 16).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 16);
        let crc = u32::from_be_bytes(png[29..33].try_into().unwrap());
        assert_eq!(crc, crc32fast::hash(&png[12..29]));
    }

    #[test]
    fn the_generated_icon_files_parse() {
        let root = std::env::temp_dir().join(format!("oe-xtask-icon-{}", std::process::id()));
        generate(&root).unwrap();
        let png = std::fs::read(root.join("crates/oe-ui/assets/icon.png")).unwrap();
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 256);
        let entries = ico::parse(&std::fs::read(root.join("crates/oe-ui/assets/icon.ico")).unwrap()).unwrap();
        let sizes: Vec<usize> = entries.iter().map(|e| e.size).collect();
        assert_eq!(sizes, ICO_SIZES);
        for entry in &entries {
            assert_eq!(&entry.png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
            let width = u32::from_be_bytes(entry.png[16..20].try_into().unwrap()) as usize;
            assert_eq!(width, entry.size);
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn arguments_are_refused() {
        assert!(run(&["--x".to_owned()]).is_err());
    }
}
