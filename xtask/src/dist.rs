//! `cargo xtask dist`: the release build, the Windows installer, and `latest.yml`.
//!
//! Three steps, each runnable on its own:
//!
//!   1. `cargo build --release -p oe-ui` — the app, one executable.
//!   2. Stage it beside what it reads at run time: `android\` (profiles, devices, the AVD config
//!      template) and the licence files — the same subset of `android\` the Electron build shipped.
//!   3. `makensis` turns the stage into `open-emulator-Setup-<version>.exe`, and `latest.yml`
//!      describes it in the shape electron-builder wrote, which is what installed copies — Electron
//!      ones included — read to find an update.
//!
//! Options: `--skip-build` reuses the last release build; `--stage-only` stops before NSIS, for a
//! machine without it.

use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha512};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("xtask sits in the workspace root").to_owned()
}

pub fn run(args: &[String]) -> Result<(), String> {
    let skip_build = args.iter().any(|a| a == "--skip-build");
    let stage_only = args.iter().any(|a| a == "--stage-only");
    if let Some(unknown) = args.iter().find(|a| !matches!(a.as_str(), "--skip-build" | "--stage-only")) {
        return Err(format!("unknown option {unknown} (expected --skip-build or --stage-only)"));
    }

    let root = root();
    let dist = root.join("target").join("dist");
    if !skip_build {
        build_release(&root)?;
    }
    let stage = dist.join("app");
    stage_app(&root, &stage)?;
    println!("staged the app in {}", stage.display());
    if stage_only {
        return Ok(());
    }

    let installer_name = format!("open-emulator-Setup-{VERSION}.exe");
    let installer = dist.join(&installer_name);
    build_installer(&root, &stage, &installer)?;
    let yml = latest_yml(&installer, &installer_name, &iso_now())?;
    std::fs::write(dist.join("latest.yml"), yml).map_err(|e| format!("could not write latest.yml: {e}"))?;
    println!("built {} and latest.yml", installer.display());
    Ok(())
}

fn build_release(root: &Path) -> Result<(), String> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .args(["build", "--release", "-p", "oe-ui"])
        .current_dir(root)
        .status()
        .map_err(|e| format!("could not run cargo: {e}"))?;
    status.success().then_some(()).ok_or_else(|| "the release build failed".to_owned())
}

/// What of `android\` the app reads at run time. The SDK, AVDs, state, logs, images and APKs a
/// developer may have beside it are not part of the app, and would make the installer gigabytes.
fn shipped(relative: &Path) -> bool {
    let text = relative.to_string_lossy().replace('\\', "/");
    let first = text.split('/').next().unwrap_or("");
    let excluded_dir = matches!(first, "sdk" | "avd" | "state" | "logs" | "bin" | "foss" | "imported" | "lib" | "scripts");
    let excluded_file = [".img", ".qcow2", ".apk", ".xapk", ".apks", ".sh"].iter().any(|ext| text.ends_with(ext));
    !excluded_dir && !excluded_file
}

fn copy_tree(from: &Path, to: &Path, base: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(from).map_err(|e| format!("could not read {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path.strip_prefix(base).map_err(|e| e.to_string())?;
        if !shipped(relative) {
            continue;
        }
        let target = to.join(relative);
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            copy_tree(&path, to, base)?;
        } else {
            std::fs::copy(&path, &target).map_err(|e| format!("could not copy {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn stage_app(root: &Path, stage: &Path) -> Result<(), String> {
    let exe = root.join("target").join("release").join("open-emulator.exe");
    if !exe.is_file() {
        return Err(format!("{} is missing — build it first, or drop --skip-build", exe.display()));
    }
    if stage.exists() {
        std::fs::remove_dir_all(stage).map_err(|e| format!("could not clear {}: {e}", stage.display()))?;
    }
    let android = stage.join("android");
    std::fs::create_dir_all(&android).map_err(|e| e.to_string())?;
    std::fs::copy(&exe, stage.join("open-emulator.exe")).map_err(|e| format!("could not copy the app: {e}"))?;
    copy_tree(&root.join("android"), &android, &root.join("android"))?;
    for name in ["LICENSE", "LICENSING.md", "THIRD-PARTY-NOTICES.md"] {
        let file = root.join(name);
        if file.is_file() {
            std::fs::copy(&file, stage.join(name)).map_err(|e| format!("could not copy {name}: {e}"))?;
        }
    }
    Ok(())
}

/// `makensis` from PATH, or where the NSIS installer puts it.
fn makensis() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").into_iter().flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>());
    let installed = ["ProgramFiles(x86)", "ProgramFiles"]
        .iter()
        .filter_map(|var| std::env::var_os(var))
        .map(|dir| PathBuf::from(dir).join("NSIS"));
    on_path.chain(installed).map(|dir| dir.join("makensis.exe")).find(|candidate| candidate.is_file())
}

fn build_installer(root: &Path, stage: &Path, installer: &Path) -> Result<(), String> {
    let makensis = makensis().ok_or("makensis was not found: install NSIS (https://nsis.sourceforge.io), or pass --stage-only")?;
    let script = root.join("packaging").join("windows").join("installer.nsi");
    let mut command = Command::new(makensis);
    command
        .arg("/V2")
        .arg(format!("/DVERSION={VERSION}"))
        .arg(format!("/DSTAGE={}", stage.display()))
        .arg(format!("/DOUTFILE={}", installer.display()));
    let icon = root.join("crates").join("oe-ui").join("assets").join("icon.ico");
    if icon.is_file() {
        command.arg(format!("/DICON={}", icon.display()));
    }
    let status = command.arg(&script).status().map_err(|e| format!("could not run makensis: {e}"))?;
    status.success().then_some(()).ok_or_else(|| "makensis failed".to_owned())
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let bits = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((bits >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The update feed, as electron-builder wrote it: the installer's SHA-512 in base64, its size,
/// and the version. Installed copies compare the version with their own.
pub fn latest_yml(installer: &Path, name: &str, released: &str) -> Result<String, String> {
    let bytes = std::fs::read(installer).map_err(|e| format!("could not read {}: {e}", installer.display()))?;
    let sha512 = base64(&Sha512::digest(&bytes));
    let size = bytes.len();
    Ok(format!(
        "version: {VERSION}\nfiles:\n  - url: {name}\n    sha512: {sha512}\n    size: {size}\npath: {name}\nsha512: {sha512}\nreleaseDate: '{released}'\n"
    ))
}

fn iso_now() -> String {
    oe_formats::time::now_iso8601()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn the_feed_names_the_installer_its_digest_and_size() {
        let dir = std::env::temp_dir().join(format!("oe-xtask-yml-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let installer = dir.join("setup.exe");
        std::fs::write(&installer, b"installer bytes").unwrap();
        let yml = latest_yml(&installer, "open-emulator-Setup-9.9.9.exe", "2026-11-24T00:00:00.000Z").unwrap();
        assert!(yml.starts_with(&format!("version: {VERSION}\n")));
        assert!(yml.contains("  - url: open-emulator-Setup-9.9.9.exe\n"));
        assert!(yml.contains("    size: 15\n"));
        assert!(yml.contains("path: open-emulator-Setup-9.9.9.exe\n"));
        assert!(yml.contains(&format!("sha512: {}\n", base64(&Sha512::digest(b"installer bytes")))));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_what_the_app_reads_ships() {
        assert!(shipped(Path::new("profiles/openemu.env")));
        assert!(shipped(Path::new("devices/pixel_5.env")));
        assert!(shipped(Path::new("config/avd_config.ini")));
        assert!(!shipped(Path::new("sdk/emulator/emulator.exe")));
        assert!(!shipped(Path::new("apps/game.apk")));
        assert!(!shipped(Path::new("bin/open-emu")));
        assert!(!shipped(Path::new("scripts/fetch_android.sh")));
        assert!(!shipped(Path::new("scripts/bench_paired.ps1")), "developer scripts are not part of the app");
    }
}
