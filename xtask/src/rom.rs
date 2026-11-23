//! `cargo xtask rom-build` and `rom-check`: build one of the app's Android ROMs from the
//! downloaded stock image exactly as the app does on first run, and check a built image with
//! tools that did not write it. See design/openemu-rom.md.
//!
//! The check runs `e2fsck` through `wsl.exe`. That is a development requirement only: the app
//! never needs WSL, but `fsck-lite` shares the editor's assumptions and so cannot be the judge of
//! the editor's output.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use oe_engine::env_file::load_profile;
use oe_engine::host::{HostFacts, TuningOverrides, tune_for_host};
use oe_engine::layout::{SdkLayout, native_root};
use oe_engine::sdk::find_process::find_qemu_pid_blocking;
use oe_formats::ReadAt;
use oe_formats::avb::{parse_avb_footer, parse_vbmeta_header, vbmeta_digest};
use oe_formats::builder::{BuildOptions, build_rom, read_manifest, rom_key_dir, rom_paths};
use oe_formats::ext4::{BufferDisk, Ext4Volume, FileDisk, NewInodeOptions, OpenOptions};
use oe_formats::gpt::{find_partition, read_gpt};
use oe_formats::lp::{find_logical, read_lp_metadata};
use oe_formats::recipe::{RomParams, RomRecipe};
use oe_formats::recipes::{recipe_by_id, rom_recipes};

/// The repository root: `xtask` sits directly under it.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf).unwrap_or_default()
}

/// Where downloads live: `OPEN_EMULATOR_DOWNLOAD_ROOT` when set, else the app's own folder.
fn sdk_layout() -> SdkLayout {
    let root = std::env::var_os("OPEN_EMULATOR_DOWNLOAD_ROOT").map(PathBuf::from);
    SdkLayout::new(native_root(root.as_deref()))
}

fn known_recipes() -> String {
    rom_recipes().into_iter().map(|r| r.id).collect::<Vec<_>>().join(", ")
}

/// The recipe named by `--recipe`, or `openemu`. Unknown ids list what this build knows.
fn pick_recipe(id: &str) -> Result<RomRecipe, String> {
    recipe_by_id(id).ok_or_else(|| format!("unknown recipe '{id}' — this build knows: {}", known_recipes()))
}

/// The value after `--name`. A flag given without one is an error, not a silent default.
fn option(args: &[String], name: &str) -> Result<Option<String>, String> {
    let flag = format!("--{name}");
    let Some(at) = args.iter().position(|a| *a == flag) else { return Ok(None) };
    match args.get(at + 1) {
        Some(value) if !value.starts_with("--") => Ok(Some(value.clone())),
        _ => Err(format!("{flag} needs a value")),
    }
}

/// Only the flags the scripts accept: a typo the old scripts silently ignored would here build
/// the wrong thing without a word.
fn reject_unknown(args: &[String], flags: &[&str], valued: &[&str]) -> Result<(), String> {
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
        } else if valued.contains(&arg.as_str()) {
            skip = true;
        } else if !flags.contains(&arg.as_str()) {
            return Err(format!("unknown argument `{arg}`"));
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct BuildArgs {
    force: bool,
    recipe: String,
    cores: Option<u32>,
}

fn parse_build_args(args: &[String]) -> Result<BuildArgs, String> {
    reject_unknown(args, &["--force"], &["--recipe", "--cores"])?;
    let cores = match option(args, "cores")? {
        None => None,
        Some(text) => match text.parse::<u32>() {
            Ok(n) if (1..=32).contains(&n) => Some(n),
            _ => return Err(format!("--cores must be a whole number from 1 to 32, not '{text}'")),
        },
    };
    Ok(BuildArgs {
        force: args.iter().any(|a| a == "--force"),
        recipe: option(args, "recipe")?.unwrap_or_else(|| "openemu".into()),
        cores,
    })
}

/// The core count the engine would start the guest with, so a ROM built by hand is the one the
/// app would have built. The CLI cannot probe the hypervisor, so it assumes the accelerated case.
fn default_cores() -> u32 {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
    // RAM does not enter the core count; the figure only fills the struct.
    let facts = HostFacts { cpus, total_ram_mb: 8192, accelerated: true, has_window: true };
    tune_for_host(&facts, TuningOverrides::default()).cores
}

pub fn build(args: &[String]) -> Result<(), String> {
    let args = parse_build_args(args)?;
    let recipe = pick_recipe(&args.recipe)?;
    let cores = args.cores.unwrap_or_else(default_cores);
    let layout = sdk_layout();

    let paths = rom_paths(&layout.sdk_root, &recipe);
    if !paths.base_dir.join("system.img").exists() {
        return Err(format!(
            "the {} system image is not downloaded: {} has no system.img, so there is nothing to build {} from. \
             Download it in the app first, or set OPEN_EMULATOR_DOWNLOAD_ROOT to the folder that holds it.",
            recipe.base_tag,
            paths.base_dir.display(),
            recipe.id
        ));
    }

    // The profile of the same name carries the AVD whose emulator must not be running.
    let profile = load_profile(&repo_root().join("android"), &recipe.id).map_err(|e| e.to_string())?;
    let avd = profile.avd_name.clone();
    let is_running = move || find_qemu_pid_blocking(&avd).is_some();
    let on_log = |line: &str| println!("{line}");

    let started = Instant::now();
    let result = build_rom(&BuildOptions {
        sdk_root: layout.sdk_root.clone(),
        key_dir: rom_key_dir(&layout.root),
        recipe,
        params: RomParams { arm_cpu_cores: Some(cores) },
        force: args.force,
        is_running: Some(&is_running),
        on_log: Some(&on_log),
    })
    .map_err(|e| format!("build failed: {e}"))?;

    let manifest = &result.manifest;
    println!(
        "\n{} in {:.1}s — {}",
        if result.skipped { "already up to date" } else { "built" },
        started.elapsed().as_secs_f64(),
        result.image_dir.display()
    );
    println!("  ROM id {}", manifest.rom_id);
    println!("  vbmeta digest {}", manifest.vbmeta_digest);
    if let Some(params) = &manifest.params {
        println!("  params {}", serde_json::to_string(params).unwrap_or_default());
    }
    let volumes = &manifest.volumes;
    for (name, v) in [
        ("system", &volumes.system),
        ("system_ext", &volumes.system_ext),
        ("product", &volumes.product),
        ("vendor", &volumes.vendor),
    ] {
        println!(
            "  {name:<10} removed {:>2}  freed {:>6} blocks  props {:>2}  rewrote {}  added {}  free now {} blocks / {} inodes",
            v.removed.len(),
            v.blocks_freed,
            v.props_changed.len(),
            v.edited.as_ref().map_or(0, Vec::len),
            v.created.len(),
            v.free_blocks,
            v.free_inodes,
        );
        if !v.not_present.is_empty() {
            println!("  {:<10} not in this image: {}", "", v.not_present.join(", "));
        }
    }
    Ok(())
}

// ── rom-check ───────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
struct CheckArgs {
    fixtures: bool,
    recipe: String,
}

fn parse_check_args(args: &[String]) -> Result<CheckArgs, String> {
    reject_unknown(args, &["--fixtures"], &["--recipe"])?;
    Ok(CheckArgs {
        fixtures: args.iter().any(|a| a == "--fixtures"),
        recipe: option(args, "recipe")?.unwrap_or_else(|| "openemu".into()),
    })
}

/// An absolute Windows path in WSL2's `/mnt/<drive>/...` passthrough form.
fn to_wsl_mount_path(path: &Path) -> Result<String, String> {
    let absolute = std::path::absolute(path).map_err(|e| format!("cannot resolve {}: {e}", path.display()))?;
    let text = absolute.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text);
    let mut chars = text.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(drive), Some(':'), Some('/')) if drive.is_ascii_alphabetic() => {
            Ok(format!("/mnt/{}/{}", drive.to_ascii_lowercase(), &text[3..]))
        }
        _ => Err(format!("cannot convert to a WSL mount path: {}", path.display())),
    }
}

/// Counts failures and prints each check as the script did.
#[derive(Default)]
struct Report {
    failures: u32,
}

impl Report {
    fn pass(&self, message: impl std::fmt::Display) {
        println!("  ok   {message}");
    }

    fn fail(&mut self, message: impl std::fmt::Display) {
        self.failures += 1;
        println!("  FAIL {message}");
    }

    fn check(&mut self, ok: bool, pass: impl std::fmt::Display, fail: impl std::fmt::Display) {
        if ok {
            self.pass(pass)
        } else {
            self.fail(fail)
        }
    }
}

/// `e2fsck -fn` through WSL. `wsl -e` runs the program without a login shell, so `/usr/sbin` is
/// not on its PATH and a bare `e2fsck` is not found; the path is spelled out, and `/sbin` covers
/// distributions without a merged `/usr`. Returns the exit code and the output.
fn e2fsck(target: &str) -> Result<(i32, String), String> {
    let mut last = None;
    for binary in ["/usr/sbin/e2fsck", "/sbin/e2fsck"] {
        let result = Command::new("wsl.exe")
            .args(["-e", binary, "-fn", target])
            .output()
            .map_err(|e| format!("cannot run wsl.exe (e2fsck needs WSL with e2fsprogs): {e}"))?;
        let text =
            format!("{}{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr)).replace('\0', "");
        let not_found = text.contains("execvpe(") && text.contains(") failed");
        last = Some((result.status.code().unwrap_or(-1), text));
        if !not_found {
            break;
        }
    }
    last.ok_or_else(|| "e2fsck was not run".to_owned())
}

fn first_lines(text: &str, n: usize) -> String {
    text.trim().lines().take(n).collect::<Vec<_>>().join("\n")
}

/// Reads a window of an open file as if it began at `base`: the `super` partition inside the disk.
struct Window<'a> {
    file: &'a File,
    base: u64,
}

impl ReadAt for Window<'_> {
    fn read_at(&mut self, offset: u64, len: usize) -> oe_formats::Result<Vec<u8>> {
        oe_formats::fileio::read_up_to(self.file, self.base + offset, len)
    }
}

/// One of the ext4 editor's test edits.
type Edit = fn(&mut Ext4Volume<BufferDisk>) -> oe_formats::Result<()>;

const LABEL: &str = "u:object_r:system_file:s0";

fn file_opts() -> NewInodeOptions<'static> {
    NewInodeOptions::new(0o644, LABEL)
}

fn dir_opts() -> NewInodeOptions<'static> {
    NewInodeOptions::new(0o755, LABEL)
}

/// The edits, named as the script named them.
fn fixture_cases() -> Vec<(&'static str, Edit)> {
    vec![
        ("remove a tree that shares a block", |v| v.remove_tree("/system/app/Bloat").map(drop)),
        ("remove both sharers", |v| {
            v.remove_tree("/system/app/Bloat")?;
            v.remove_tree("/system/app/Keep/Shared.apk").map(drop)
        }),
        ("remove from a hashed directory", |v| {
            v.remove_tree("/system/etc/many/a-deliberately-long-file-name-to-fill-directory-blocks-150.txt").map(drop)
        }),
        ("create a directory and a file", |v| {
            v.mkdir("/system/media/openemu", dir_opts())?;
            v.create_file("/system/media/openemu/wallpaper.png", &vec![b'W'; 3 * 4096 + 4], file_opts()).map(drop)
        }),
        ("allocate from uninitialised groups", |v| {
            v.create_file("/system/media/big.bin", &vec![b'Z'; 1015 * 4096], file_opts())?;
            v.mkdir("/system/media/lots", dir_opts())?;
            for i in 0..60 {
                v.create_file(&format!("/system/media/lots/f{i}"), &[], file_opts())?;
            }
            Ok(())
        }),
        ("grow a directory", |v| {
            v.mkdir("/system/media/wide", dir_opts())?;
            for i in 0..40 {
                let name = format!("/system/media/wide/{i:03}-{}", "n".repeat(190));
                v.create_file(&name, i.to_string().as_bytes(), file_opts())?;
            }
            Ok(())
        }),
        ("replace in place", |v| v.replace_file("/system/build.prop", b"ro.build.display.id=openemu\n")),
        ("replace by reallocating, including a shared file", |v| {
            v.replace_file("/system/build.prop", &vec![b'g'; 3 * 4096 + 10])?;
            v.replace_file("/system/app/Keep/Shared.apk", &vec![b'R'; 2 * 4096])
        }),
    ]
}

fn check_fixtures(report: &mut Report) -> Result<(), String> {
    let source = repo_root().join("desktop").join("test").join("fixtures").join("rom").join("ext4-fixture.img.gz");
    let gz = std::fs::read(&source).map_err(|e| format!("cannot read the ext4 fixture {}: {e}", source.display()))?;
    let mut fixture = Vec::new();
    flate2::read::GzDecoder::new(&gz[..])
        .read_to_end(&mut fixture)
        .map_err(|e| format!("cannot unpack the ext4 fixture: {e}"))?;

    let dir = std::env::temp_dir().join(format!("oe-rom-check-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let outcome = (|| {
        for (name, edit) in fixture_cases() {
            let mut buffer = fixture.clone();
            let edited = Ext4Volume::open(BufferDisk::new(&mut buffer), OpenOptions::writable()).and_then(|mut volume| {
                edit(&mut volume)?;
                volume.flush()
            });
            if let Err(e) = edited {
                report.fail(format!("editor: {name}: {e}"));
                continue;
            }
            let file = dir.join("case.img");
            std::fs::write(&file, &buffer).map_err(|e| e.to_string())?;
            let (code, output) = e2fsck(&to_wsl_mount_path(&file)?)?;
            report.check(code == 0, format!("e2fsck: {name}"), format!("e2fsck (exit {code}): {name}\n{}", first_lines(&output, 20)));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

fn check_rom(report: &mut Report, recipe_id: &str) -> Result<(), String> {
    let Ok(recipe) = pick_recipe(recipe_id) else {
        report.fail(format!("unknown recipe '{recipe_id}' — this build knows: {}", known_recipes()));
        return Ok(());
    };
    let layout = sdk_layout();
    let image_dir = rom_paths(&layout.sdk_root, &recipe).image_dir;
    let Some(manifest) = read_manifest(&image_dir) else {
        report.fail(format!("no ROM built by this builder at {} — run cargo xtask rom-build", image_dir.display()));
        return Ok(());
    };
    println!("{} {}, built {}", manifest.recipe_id, manifest.recipe_version, manifest.built_at);

    let image = image_dir.join("system.img");
    let mut file = File::open(&image).map_err(|e| format!("cannot open {}: {e}", image.display()))?;
    let e = |err: oe_formats::Error| err.to_string();

    let gpt = read_gpt(&mut file).map_err(e)?;
    let vbmeta = find_partition(&gpt, "vbmeta").map_err(e)?.clone();
    let super_part = find_partition(&gpt, "super").map_err(e)?.clone();
    let lp = read_lp_metadata(&mut Window { file: &file, base: super_part.offset }, super_part.size).map_err(e)?;

    let wsl_image = to_wsl_mount_path(&image)?;
    for name in ["system", "system_ext", "product", "vendor"] {
        let part = find_logical(&lp.partitions, name).map_err(e)?;
        let offset = super_part.offset + part.offset;
        let mut volume = Ext4Volume::open(FileDisk::new(&file, offset, part.size, false), OpenOptions::default()).map_err(e)?;
        let lite = volume.verify().map_err(e)?;
        if lite.ok {
            report.pass(format!("{name}: fsck-lite ({} blocks, {} inodes free)", volume.free_blocks(), volume.free_inodes()));
        } else {
            report.fail(format!("{name}: fsck-lite — {}", lite.problems.iter().take(5).cloned().collect::<Vec<_>>().join("; ")));
        }
        let (code, output) = e2fsck(&format!("{wsl_image}?offset={offset}"))?;
        report.check(code == 0, format!("{name}: e2fsck -fn"), format!("{name}: e2fsck -fn exited {code}\n{}", first_lines(&output, 20)));
    }

    let vbmeta_partition = file.read_at(vbmeta.offset, vbmeta.size as usize).map_err(e)?;
    let header = parse_vbmeta_header(&vbmeta_partition).map_err(e)?;
    let top = &vbmeta_partition[..header.total_size as usize];
    report.check(header.flags == 1, "vbmeta flags: HASHTREE_DISABLED only", format!("vbmeta flags are {}, expected 1", header.flags));

    let system = find_logical(&lp.partitions, "system").map_err(e)?;
    let system_offset = super_part.offset + system.offset;
    let tail = file.read_at(system_offset + system.size - 64, 64).map_err(e)?;
    let footer = parse_avb_footer(&tail, Some(system.size)).map_err(e)?.ok_or("the system partition has no AVB footer")?;
    let region = file.read_at(system_offset + footer.vbmeta_offset, footer.vbmeta_size as usize).map_err(e)?;
    let chained = &region[..parse_vbmeta_header(&region).map_err(e)?.total_size as usize];
    let digest = vbmeta_digest(&[top, chained]);
    report.check(
        digest == manifest.vbmeta_digest,
        format!("vbmeta digest matches the manifest ({}…)", &digest[..16]),
        format!("vbmeta digest {digest} is not the manifest's {}", manifest.vbmeta_digest),
    );

    let params_file = image_dir.join("VerifiedBootParams.textproto");
    let params = std::fs::read_to_string(&params_file).map_err(|err| format!("cannot read {}: {err}", params_file.display()))?;
    report.check(
        params.contains(&format!("androidboot.vbmeta.digest={digest}\"")),
        "VerifiedBootParams carries that digest",
        "VerifiedBootParams.textproto does not carry the image digest",
    );
    report.check(
        !(params.contains("verifiedbootstate") || params.contains("device_state")),
        "no unlocked/orange state on the command line",
        "VerifiedBootParams declares an unlocked device",
    );
    let size = top.len() + chained.len();
    report.check(
        params.contains(&format!("androidboot.vbmeta.size={size}\"")),
        format!("vbmeta size {size}"),
        format!("VerifiedBootParams size is not {size}"),
    );
    Ok(())
}

pub fn check(args: &[String]) -> Result<(), String> {
    let args = parse_check_args(args)?;
    let mut report = Report::default();
    if args.fixtures {
        println!("ext4 editor edits through e2fsck -fn");
        check_fixtures(&mut report)?;
    } else {
        check_rom(&mut report, &args.recipe)?;
    }
    if report.failures == 0 {
        println!("\nall checks passed");
        Ok(())
    } else {
        Err(format!("{} check(s) failed", report.failures))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn build_defaults_to_the_openemu_recipe_without_force() {
        assert_eq!(parse_build_args(&[]).unwrap(), BuildArgs { force: false, recipe: "openemu".into(), cores: None });
    }

    #[test]
    fn build_reads_its_flags_in_any_order() {
        let args = parse_build_args(&strings(&["--cores", "6", "--force", "--recipe", "openemu-compat"])).unwrap();
        assert_eq!(args, BuildArgs { force: true, recipe: "openemu-compat".into(), cores: Some(6) });
    }

    #[test]
    fn a_flag_without_its_value_or_with_a_bad_one_is_an_error() {
        assert_eq!(parse_build_args(&strings(&["--recipe"])).unwrap_err(), "--recipe needs a value");
        assert!(parse_build_args(&strings(&["--recipe", "--force"])).is_err());
        assert!(parse_build_args(&strings(&["--cores", "many"])).is_err());
        assert!(parse_build_args(&strings(&["--cores", "0"])).is_err());
        assert!(parse_build_args(&strings(&["--forse"])).unwrap_err().contains("--forse"));
    }

    #[test]
    fn check_reads_fixtures_and_recipe() {
        assert_eq!(parse_check_args(&[]).unwrap(), CheckArgs { fixtures: false, recipe: "openemu".into() });
        let args = parse_check_args(&strings(&["--fixtures", "--recipe", "openemu-compat"])).unwrap();
        assert_eq!(args, CheckArgs { fixtures: true, recipe: "openemu-compat".into() });
    }

    #[test]
    fn an_unknown_recipe_lists_the_known_ones() {
        let message = pick_recipe("nope").unwrap_err();
        assert!(message.contains("openemu, openemu-compat"), "{message}");
        assert!(pick_recipe("openemu-compat").is_ok());
    }

    #[test]
    fn windows_paths_become_wsl_mount_paths() {
        if cfg!(windows) {
            assert_eq!(to_wsl_mount_path(Path::new(r"C:\Users\x\a b.img")).unwrap(), "/mnt/c/Users/x/a b.img");
            assert_eq!(to_wsl_mount_path(Path::new(r"\\?\D:\t\case.img")).unwrap(), "/mnt/d/t/case.img");
        }
    }

    #[test]
    fn a_missing_base_image_fails_the_build_with_a_message_saying_so() {
        let empty = std::env::temp_dir().join(format!("oe-xtask-no-sdk-{}", std::process::id()));
        // SAFETY: only this test touches the variable, and nothing else in this crate reads it.
        unsafe { std::env::set_var("OPEN_EMULATOR_DOWNLOAD_ROOT", &empty) };
        let message = build(&[]).unwrap_err();
        unsafe { std::env::remove_var("OPEN_EMULATOR_DOWNLOAD_ROOT") };
        assert!(message.contains("not downloaded"), "{message}");
    }

    #[test]
    fn fixture_edits_have_distinct_names() {
        let cases = fixture_cases();
        let mut names: Vec<_> = cases.iter().map(|(n, _)| *n).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), cases.len());
    }
}
