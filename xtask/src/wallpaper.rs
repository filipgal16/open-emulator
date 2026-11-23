//! `cargo xtask wallpaper <out.png>`: renders the default wallpaper the ROM builder installs, so
//! the picture can be looked at without building a ROM. The renderer is deterministic, so the
//! file is the one a built image carries.

use std::path::{Path, PathBuf};
use std::time::Instant;

/// The one positional argument, the file to write. Anything else is a mistake worth stopping on,
/// since a stray flag silently taken for a path would write a file called `--force`.
fn parse(args: &[String]) -> Result<PathBuf, String> {
    match args {
        [out] if !out.starts_with("--") => Ok(PathBuf::from(out)),
        [] => Err("usage: cargo xtask wallpaper <out.png>".into()),
        _ => Err(format!("usage: cargo xtask wallpaper <out.png> (got `{}`)", args.join(" "))),
    }
}

/// Renders into `dest`, creating its folder, and returns the PNG's size in bytes.
fn write_wallpaper(dest: &Path) -> Result<usize, String> {
    let png = oe_formats::wallpaper::render_wallpaper().map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(dest, &png).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    Ok(png.len())
}

pub fn run(args: &[String]) -> Result<(), String> {
    let dest = parse(args)?;
    let started = Instant::now();
    let bytes = write_wallpaper(&dest)?;
    println!("wrote {} ({bytes} bytes, {:.1} ms)", dest.display(), started.elapsed().as_secs_f64() * 1000.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn one_path_is_the_output_and_anything_else_is_refused() {
        assert_eq!(parse(&strings(&["a.png"])).unwrap(), PathBuf::from("a.png"));
        assert!(parse(&[]).is_err());
        assert!(parse(&strings(&["a.png", "b.png"])).is_err());
        assert!(parse(&strings(&["--force"])).is_err());
    }

    #[test]
    fn the_rendered_file_is_a_png_in_a_folder_made_for_it() {
        let dir = std::env::temp_dir().join(format!("oe-xtask-wallpaper-{}", std::process::id()));
        let dest = dir.join("nested").join("w.png");
        let bytes = write_wallpaper(&dest).unwrap();
        let data = std::fs::read(&dest).unwrap();
        assert_eq!(data.len(), bytes);
        assert_eq!(&data[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
