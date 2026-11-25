//! Builds a ROM from one of Google's stock images, on the user's machine: `openemu` from the AOSP
//! image, `openemu-compat` from the Google APIs one.
//!
//! See `design/openemu-rom.md`. The short version: copy the base image aside, edit the four ext4
//! volumes inside its `super` partition (debloat, identity, our own files), re-sign the top-level
//! vbmeta with our key and `HASHTREE_DISABLED` so the guest mounts `/system` without dm-verity
//! putting Google's bytes back, and swap the result into place. Nothing here needs WSL, and nothing
//! of Google's is redistributed: the user's machine downloaded the base.

use std::collections::HashMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::arm_cpuinfo::expand_arm_cpuinfo;
use crate::avb::{
    load_or_create_signing_key, parse_avb_footer, parse_vbmeta_header, resign_vbmeta, upsert_verified_boot_params,
    vbmeta_digest, AVB_FLAG_HASHTREE_DISABLED,
};
use crate::build_prop::{rewrite_identity, upsert_props};
use crate::bytes::{hex, js_line_spans, replace_first_line};
use crate::ext4::{Ext4Volume, FileDisk, NewInodeOptions, OpenOptions};
use crate::gpt::{find_partition, read_gpt};
use crate::lp::{find_logical, read_lp_metadata};
use crate::recipe::{
    recipe_hash, used_params, validate_recipe, FileKind, PerVolume, RomEdit, RomParams, RomRecipe, Source, Transform,
    Volume, BUILDER_REVISION,
};
use crate::wallpaper::render_wallpaper;
use crate::{err, fail, fileio, FnReader, Result};

/// Everything the builder creates or changes carries this time. 2009-01-01, AOSP's own convention.
pub const ROM_EPOCH: u32 = 1230768000;

const MANIFEST: &str = "openemu-manifest.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RomPaths {
    pub base_dir: PathBuf,
    pub image_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub prev_dir: PathBuf,
}

/// Where the per-machine signing key lives: beside the SDK, not inside an image directory it would
/// be copied with.
pub fn rom_key_dir(root: &Path) -> PathBuf {
    root.join("rom")
}

pub fn rom_paths(sdk_root: &Path, recipe: &RomRecipe) -> RomPaths {
    let images = sdk_root.join("system-images").join(format!("android-{}", recipe.api_level));
    let image_dir = images.join(&recipe.id).join("x86_64");
    RomPaths {
        base_dir: images.join(&recipe.base_tag).join("x86_64"),
        staging_dir: with_suffix(&image_dir, ".staging"),
        prev_dir: with_suffix(&image_dir, ".prev"),
        image_dir,
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut text = path.as_os_str().to_owned();
    text.push(suffix);
    PathBuf::from(text)
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VolumeReport {
    pub removed: Vec<String>,
    pub not_present: Vec<String>,
    pub blocks_freed: u64,
    pub inodes_freed: u64,
    pub blocks_still_shared: u64,
    pub props_changed: Vec<String>,
    /// Stock files rewritten in place. Absent from a manifest written before edits existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited: Option<Vec<String>>,
    pub created: Vec<String>,
    pub free_blocks: u64,
    pub free_inodes: u64,
}

/// The params a recipe read, as the manifest records them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ManifestParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arm_cpu_cores: Option<u32>,
}

impl From<RomParams> for ManifestParams {
    fn from(params: RomParams) -> Self {
        ManifestParams { arm_cpu_cores: params.arm_cpu_cores }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ManifestVolumes {
    pub system: VolumeReport,
    pub system_ext: VolumeReport,
    pub product: VolumeReport,
    pub vendor: VolumeReport,
}

/// What the builder writes beside a ROM it built, field for field what the TypeScript builder
/// wrote, so either can read the other's.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RomManifest {
    /// Always `openemu-rom`; a manifest without it is from the old debugfs builder.
    pub builder: String,
    pub builder_revision: i64,
    pub recipe_id: String,
    pub recipe_version: u32,
    pub recipe_hash: String,
    /// SHA-256 over the stock top-level and chained `system` vbmeta: identifies the base image.
    pub base_digest: String,
    /// The same digest over ours. It is what the guest reports as `ro.boot.vbmeta.digest`.
    pub vbmeta_digest: String,
    /// Identifies this build of the ROM: what an AVD records when it is provisioned, and what a
    /// later start compares against to decide whether its snapshot still belongs to the image.
    ///
    /// Not the vbmeta digest alone, though it looks like one. With the hashtree disabled nothing
    /// in the vbmeta depends on what `/system` holds, so two builds with different content would
    /// share a digest, and an old snapshot would be restored onto a changed system. The id folds
    /// in the recipe, the builder revision and the base, which are what the content is made from.
    pub rom_id: String,
    /// The params the recipe read, as built: already part of `recipe_hash`. Absent if it reads
    /// none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<ManifestParams>,
    pub volumes: ManifestVolumes,
    /// Informational. Not part of the image, so it does not affect reproducibility.
    pub built_at: String,
}

pub struct BuildOptions<'a> {
    pub sdk_root: PathBuf,
    /// Where the per-machine signing key lives. See [`load_or_create_signing_key`].
    pub key_dir: PathBuf,
    pub recipe: RomRecipe,
    /// Facts about this machine's guest the image must agree with. See [`RomParams`].
    pub params: RomParams,
    pub force: bool,
    /// Whether the ROM's emulator is running. A running guest has `system.img` open.
    pub is_running: Option<&'a dyn Fn() -> bool>,
    pub on_log: Option<&'a dyn Fn(&str)>,
}

#[derive(Debug, Clone)]
pub struct BuildResult {
    pub manifest: RomManifest,
    pub image_dir: PathBuf,
    pub skipped: bool,
}

// ── Reading the image's structure ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct Window {
    offset: u64,
    size: u64,
}

struct ImageLayout {
    vbmeta: Window,
    volumes: PerVolume<Window>,
}

fn read_exact_at(file: &File, offset: u64, length: usize) -> Result<Vec<u8>> {
    fileio::read_exact(file, offset, length)
}

fn layout_of(file: &File) -> Result<ImageLayout> {
    let mut read = FnReader(|offset: u64, length: usize| fileio::read_exact(file, offset, length));
    let gpt = read_gpt(&mut read)?;
    let vbmeta = find_partition(&gpt, "vbmeta")?;
    let super_part = find_partition(&gpt, "super")?;
    let super_offset = super_part.offset;
    let mut super_read =
        FnReader(|offset: u64, length: usize| fileio::read_exact(file, super_offset + offset, length));
    let lp = read_lp_metadata(&mut super_read, super_part.size)?;
    let window = |volume: Volume| -> Result<Window> {
        let part = find_logical(&lp.partitions, volume.name())?;
        Ok(Window { offset: super_offset + part.offset, size: part.size })
    };
    Ok(ImageLayout {
        vbmeta: Window { offset: vbmeta.offset, size: vbmeta.size },
        volumes: PerVolume {
            system: window(Volume::System)?,
            system_ext: window(Volume::SystemExt)?,
            product: window(Volume::Product)?,
            vendor: window(Volume::Vendor)?,
        },
    })
}

struct Vbmetas {
    top: Vec<u8>,
    chained: Vec<u8>,
}

/// The top-level vbmeta, trimmed to its real size, and the chained one from `system`'s footer.
fn read_vbmetas(file: &File, layout: &ImageLayout) -> Result<Vbmetas> {
    // The parser checks the claimed size against the bytes it is given, so it gets the whole
    // partition and the image is trimmed to what the header says afterwards.
    let partition = read_exact_at(file, layout.vbmeta.offset, layout.vbmeta.size as usize)?;
    let top = partition[..parse_vbmeta_header(&partition)?.total_size as usize].to_vec();

    let system = layout.volumes.system;
    let tail = read_exact_at(file, system.offset + system.size - 64, 64)?;
    let Some(footer) = parse_avb_footer(&tail, Some(system.size))? else {
        fail!("the system partition has no AVB footer; this is not the image layout the ROM is built for");
    };
    let region = read_exact_at(file, system.offset + footer.vbmeta_offset, footer.vbmeta_size as usize)?;
    let chained = region[..parse_vbmeta_header(&region)?.total_size as usize].to_vec();
    Ok(Vbmetas { top, chained })
}

/// The params the emulator copies onto the kernel command line, as a map: every
/// `param: "key=value"` line, the last definition of a key winning.
fn boot_params(text: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    for (start, end) in js_line_spans(text) {
        let line = &text[start..end];
        let Some(rest) = line.strip_prefix("param:") else { continue };
        let Some(rest) = rest.trim_start_matches(crate::bytes::js_is_space).strip_prefix('"') else { continue };
        let Some(close) = rest.find('"') else { continue };
        if !rest[close + 1..].chars().all(crate::bytes::js_is_space) {
            continue;
        }
        let Some((key, value)) = rest[..close].split_once('=') else { continue };
        if key.is_empty() {
            continue;
        }
        params.insert(key.to_owned(), value.to_owned());
    }
    params
}

/// Identifies a base image by the digest the emulator puts on the command line, recomputed from
/// the bytes and checked against Google's own `VerifiedBootParams.textproto`.
///
/// Cheap: two small reads, never the 3 GB image, and it changes whenever Google republishes the
/// image, which is exactly when a rebuild is needed. The cross-check doubles as proof that the
/// builder reads this layout the way the emulator does.
pub fn base_digest(base_dir: &Path) -> Result<String> {
    let file = File::open(base_dir.join("system.img"))?;
    let vbmetas = read_vbmetas(&file, &layout_of(&file)?)?;
    let digest = vbmeta_digest(&[&vbmetas.top, &vbmetas.chained]);
    let params = boot_params(&fs::read_to_string(base_dir.join("VerifiedBootParams.textproto"))?);
    if let Some(expected) = params.get("androidboot.vbmeta.digest") {
        if !expected.is_empty() && expected.to_lowercase() != digest {
            let tag = base_dir.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            fail!("the {tag} image's vbmeta does not match its VerifiedBootParams digest");
        }
    }
    let size: u64 = params.get("androidboot.vbmeta.size").and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    let total = (vbmetas.top.len() + vbmetas.chained.len()) as u64;
    if size != 0 && size != total {
        fail!("vbmeta size {total} does not match VerifiedBootParams ({size})");
    }
    Ok(digest)
}

// ── State of the built ROM ──────────────────────────────────────────────────────────────────────

pub fn read_manifest(image_dir: &Path) -> Option<RomManifest> {
    let text = fs::read_to_string(image_dir.join(MANIFEST)).ok()?;
    let manifest: RomManifest = serde_json::from_str(&text).ok()?;
    // A manifest from the old debugfs builder has no `builder` field and never counts as ours.
    (manifest.builder == "openemu-rom").then_some(manifest)
}

/// A crash between the two renames of a swap leaves `x86_64` missing and `x86_64.prev` holding
/// the last good ROM. Put it back before anything looks for the image.
pub fn recover_interrupted_swap(paths: &RomPaths) -> Result<bool> {
    if !paths.image_dir.exists() && paths.prev_dir.exists() {
        fs::rename(&paths.prev_dir, &paths.image_dir)?;
        return Ok(true);
    }
    if paths.image_dir.exists() && paths.prev_dir.exists() {
        fs::remove_dir_all(&paths.prev_dir)?;
    }
    Ok(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RomState {
    pub built: bool,
    pub up_to_date: bool,
    pub reason: String,
    pub manifest: Option<RomManifest>,
}

/// Rendered once per process. The wallpaper is drawn, not stored, and deterministic, so its bytes
/// cannot change within a run, while `rom_state` is asked on every launch and every cold start.
static WALLPAPER: OnceLock<Vec<u8>> = OnceLock::new();

fn contents_for(recipe: &RomRecipe) -> Result<HashMap<Source, Vec<u8>>> {
    let mut contents = HashMap::new();
    if recipe.files.iter().any(|f| f.source == Some(Source::Wallpaper)) {
        let wallpaper = match WALLPAPER.get() {
            Some(wallpaper) => wallpaper.clone(),
            None => {
                let rendered = render_wallpaper()?;
                WALLPAPER.get_or_init(|| rendered).clone()
            }
        };
        contents.insert(Source::Wallpaper, wallpaper);
    }
    Ok(contents)
}

/// What, if anything, keeps this image's partitions from mounting: each of Android's logical
/// partitions must start with an ext4 superblock. A few kilobytes of reads, cheap enough for every
/// launch; the full check (`cargo xtask rom-check`) reads the whole image.
pub fn damage(image: &Path) -> Option<String> {
    const PARTITIONS: [&str; 4] = ["system", "system_ext", "product", "vendor"];
    const EXT4_MAGIC: [u8; 2] = [0x53, 0xef];
    let check = || -> Result<Option<String>> {
        let mut file = File::open(image)?;
        let gpt = read_gpt(&mut file)?;
        let super_part = find_partition(&gpt, "super")?.clone();
        let mut window = FnReader(|offset: u64, len: usize| fileio::read_up_to(&file, super_part.offset + offset, len));
        let lp = read_lp_metadata(&mut window, super_part.size)?;
        for name in PARTITIONS {
            let Ok(part) = find_logical(&lp.partitions, name) else { continue };
            // The superblock is 1 KiB in; its magic is 0x38 bytes into that.
            let magic = fileio::read_up_to(&file, super_part.offset + part.offset + 1024 + 0x38, 2)?;
            if magic != EXT4_MAGIC {
                return Ok(Some(format!("the {name} partition is not a readable file system")));
            }
        }
        Ok(None)
    };
    check().unwrap_or_else(|error| Some(format!("its partition table cannot be read ({error})")))
}

fn state(built: bool, up_to_date: bool, reason: &str, manifest: Option<RomManifest>) -> RomState {
    RomState { built, up_to_date, reason: reason.to_owned(), manifest }
}

/// Whether the ROM on disk is the one this build of the app would produce: written by this
/// builder, from this recipe, over this base. Anything else, including the old builder's image,
/// rebuilds. `contents` replaces the rendered wallpaper, for tests.
pub fn rom_state(
    sdk_root: &Path,
    recipe: &RomRecipe,
    contents: Option<&HashMap<Source, Vec<u8>>>,
    params: RomParams,
) -> Result<RomState> {
    let paths = rom_paths(sdk_root, recipe);
    recover_interrupted_swap(&paths)?;
    if !paths.image_dir.join("system.img").exists() {
        return Ok(state(false, false, "not built", None));
    }
    let Some(manifest) = read_manifest(&paths.image_dir) else {
        return Ok(state(true, false, "built by an older builder", None));
    };
    if manifest.builder_revision != i64::from(BUILDER_REVISION) {
        return Ok(state(true, false, "builder changed", Some(manifest)));
    }
    // A copy can damage an image without changing its size or date. The guest then cannot mount
    // its partitions and reboots forever, so a damaged image rebuilds, like an outdated one.
    if let Some(problem) = damage(&paths.image_dir.join("system.img")) {
        return Ok(state(true, false, &format!("damaged: {problem}"), Some(manifest)));
    }
    let rendered;
    let contents = match contents {
        Some(contents) => contents,
        None => {
            rendered = contents_for(recipe)?;
            &rendered
        }
    };
    let hash = recipe_hash(recipe, contents, BUILDER_REVISION, params)?;
    if manifest.recipe_hash != hash {
        // Told apart because the fix differs: a new app version for one, a settings change for the
        // other.
        let wanted = used_params(recipe, params)?.map(ManifestParams::from);
        let reason = if manifest.params == wanted { "recipe changed" } else { "guest settings changed" };
        return Ok(state(true, false, reason, Some(manifest)));
    }
    if !paths.base_dir.join("system.img").exists() {
        // The base may be cleaned up later; the ROM stands on its own once built.
        return Ok(state(true, true, "up to date (base not present to compare)", Some(manifest)));
    }
    if manifest.base_digest != base_digest(&paths.base_dir)? {
        return Ok(state(true, false, "base image changed", Some(manifest)));
    }
    Ok(state(true, true, "up to date", Some(manifest)))
}

// ── The build ───────────────────────────────────────────────────────────────────────────────────

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn build_rom(options: &BuildOptions) -> Result<BuildResult> {
    let recipe = &options.recipe;
    let log = |line: &str| {
        if let Some(on_log) = options.on_log {
            on_log(&format!("[rom] {line}"));
        }
    };
    validate_recipe(recipe)?;

    let paths = rom_paths(&options.sdk_root, recipe);
    if recover_interrupted_swap(&paths)? {
        log("restored the previous ROM after an interrupted build");
    }
    let base_image = paths.base_dir.join("system.img");
    if !base_image.exists() {
        fail!("the {} system image is not downloaded; there is nothing to build {} from", recipe.base_tag, recipe.id);
    }

    let contents = contents_for(recipe)?;
    let rom_params = used_params(recipe, options.params)?;
    let hash = recipe_hash(recipe, &contents, BUILDER_REVISION, options.params)?;
    let base = base_digest(&paths.base_dir)?;

    if let Some(existing) = read_manifest(&paths.image_dir) {
        if !options.force
            && existing.builder_revision == i64::from(BUILDER_REVISION)
            && existing.recipe_hash == hash
            && existing.base_digest == base
            && paths.image_dir.join("system.img").exists()
        {
            log(&format!("{} {} is up to date", recipe.display_name, recipe.version));
            return Ok(BuildResult { manifest: existing, image_dir: paths.image_dir, skipped: true });
        }
    }

    if options.is_running.is_some_and(|is_running| is_running()) {
        fail!("{} is running: stop Android before its system image is rebuilt", recipe.display_name);
    }

    let gigabytes = fs::metadata(&base_image)?.len() as f64 / 1e9;
    log(&format!("copying the {} image ({gigabytes:.1} GB, once per build)", recipe.base_tag));
    remove_if_exists(&paths.staging_dir)?;
    if let Some(parent) = paths.staging_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    copy_dir(&paths.base_dir, &paths.staging_dir)?;
    // The base's manifest-less copy must never pass for a finished build if we stop half way.
    let _ = fs::remove_file(paths.staging_dir.join(MANIFEST));

    let mut volumes = ManifestVolumes::default();
    let digest;
    {
        let file = fs::OpenOptions::new().read(true).write(true).open(paths.staging_dir.join("system.img"))?;
        let layout = layout_of(&file)?;
        let before = read_vbmetas(&file, &layout)?;
        if vbmeta_digest(&[&before.top, &before.chained]) != base {
            fail!("the staged copy does not match the base image");
        }

        let params = rom_params.unwrap_or_default();
        volumes.system = edit_volume(&file, &layout, Volume::System, recipe, &contents, params, &log)?;
        volumes.system_ext = edit_volume(&file, &layout, Volume::SystemExt, recipe, &contents, params, &log)?;
        volumes.product = edit_volume(&file, &layout, Volume::Product, recipe, &contents, params, &log)?;
        volumes.vendor = edit_volume(&file, &layout, Volume::Vendor, recipe, &contents, params, &log)?;

        // The chained `system` vbmeta sits past the filesystem, in the part of the partition the
        // ext4 editor cannot reach. Confirm that rather than assume it.
        let after = read_vbmetas(&file, &layout)?;
        if after.chained != before.chained {
            fail!("the chained system vbmeta changed during the edit");
        }

        let key = load_or_create_signing_key(&options.key_dir, 4096)?;
        let signed = resign_vbmeta(&before.top, &key, AVB_FLAG_HASHTREE_DISABLED)?;
        fileio::write_all(&file, layout.vbmeta.offset, &signed)?;
        digest = vbmeta_digest(&[&signed, &before.chained]);

        let params_path = paths.staging_dir.join("VerifiedBootParams.textproto");
        let size = (signed.len() + before.chained.len()).to_string();
        let updated = upsert_verified_boot_params(
            &fs::read_to_string(&params_path)?,
            &[
                ("androidboot.vbmeta.size", &size),
                ("androidboot.vbmeta.hash_alg", "sha256"),
                ("androidboot.vbmeta.digest", &digest),
            ],
            // Neither is needed with a validly signed vbmeta, and orange would tell every app the
            // bootloader is unlocked.
            &["androidboot.verifiedbootstate", "androidboot.vbmeta.device_state"],
        )?;
        fs::write(&params_path, updated)?;
        log(&format!("signed vbmeta with HASHTREE_DISABLED; digest {}", &digest[..16]));
    }

    // The SDK keeps a copy of /system/build.prop beside the image for tools that never boot it.
    let side_prop = paths.staging_dir.join("build.prop");
    if side_prop.exists() {
        let stock = fs::read_to_string(&side_prop)?;
        let rewritten = match &recipe.identity {
            Some(identity) => rewrite_identity(&stock, identity)?.text,
            None => stock,
        };
        fs::write(&side_prop, upsert_props(&rewritten, &props_of(recipe))?)?;
    }

    let source_props = paths.staging_dir.join("source.properties");
    if source_props.exists() {
        let mut text = fs::read_to_string(&source_props)?;
        text = replace_first_line(&text, "SystemImage.TagId=", &format!("SystemImage.TagId={}", recipe.id));
        text = replace_first_line(&text, "SystemImage.TagDisplay=", &format!("SystemImage.TagDisplay={}", recipe.display_name));
        text = replace_first_line(
            &text,
            "Pkg.Desc=",
            &format!("Pkg.Desc={} {} (built from {})", recipe.display_name, recipe.version, recipe.base_tag),
        );
        fs::write(&source_props, text)?;
    }

    let rom_id = hex(&Sha256::digest(format!("{BUILDER_REVISION}\n{hash}\n{base}\n{digest}").as_bytes()));
    let manifest = RomManifest {
        builder: "openemu-rom".into(),
        builder_revision: i64::from(BUILDER_REVISION),
        recipe_id: recipe.id.clone(),
        recipe_version: recipe.version,
        recipe_hash: hash,
        base_digest: base,
        vbmeta_digest: digest,
        rom_id,
        // Omitted, not null, when the recipe reads none.
        params: rom_params.map(ManifestParams::from),
        volumes,
        built_at: crate::time::now_iso8601(),
    };
    let json = serde_json::to_string_pretty(&manifest).map_err(|error| err!("could not write the manifest: {error}"))?;
    fs::write(paths.staging_dir.join(MANIFEST), format!("{json}\n"))?;

    // Windows will not rename over a non-empty directory, so the old ROM steps aside first. A
    // crash between the two renames is repaired by `recover_interrupted_swap` on the next run.
    if paths.image_dir.exists() {
        fs::rename(&paths.image_dir, &paths.prev_dir)?;
    }
    fs::rename(&paths.staging_dir, &paths.image_dir)?;
    remove_if_exists(&paths.prev_dir)?;

    log(&format!("{} {} built at {}", recipe.display_name, recipe.version, paths.image_dir.display()));
    Ok(BuildResult { manifest, image_dir: paths.image_dir, skipped: false })
}

fn props_of(recipe: &RomRecipe) -> Vec<(&str, &str)> {
    recipe.system_props.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

/// The new bytes of a stock file. Pure: the same stock bytes and params always give the same
/// result.
fn apply_transform(edit: &RomEdit, stock: &[u8], params: RomParams) -> Result<Vec<u8>> {
    match edit.transform {
        Transform::ArmCpuinfo => {
            // `used_params` has already refused a build without it; this is for the type.
            let Some(cores) = params.arm_cpu_cores else {
                fail!("{}: no core count was given", edit.path);
            };
            expand_arm_cpuinfo(stock, cores)
        }
    }
}

/// One volume, in the order the plan fixes: removals first (they return inodes and blocks), then
/// identity, then stock files rewritten in place, then our own files. Verified through a fresh
/// reader afterwards, and every file this wrote is read back.
fn edit_volume(
    file: &File,
    layout: &ImageLayout,
    name: Volume,
    recipe: &RomRecipe,
    contents: &HashMap<Source, Vec<u8>>,
    params: RomParams,
    log: &dyn Fn(&str),
) -> Result<VolumeReport> {
    let window = *layout.volumes.get(name);
    let mut volume = Ext4Volume::open(
        FileDisk::new(file, window.offset, window.size, true),
        OpenOptions { writable: true, epoch: ROM_EPOCH },
    )?;
    let mut report = VolumeReport { edited: Some(Vec::new()), ..VolumeReport::default() };
    let mut written: Vec<(String, Vec<u8>)> = Vec::new();

    for target in recipe.debloat.get(name) {
        if !volume.exists(target)? {
            report.not_present.push(target.clone());
            continue;
        }
        let removed = volume.remove_tree(target)?;
        report.removed.push(target.clone());
        report.blocks_freed += removed.blocks_freed;
        report.inodes_freed += removed.inodes_freed;
        report.blocks_still_shared += removed.blocks_still_shared;
    }
    if !report.removed.is_empty() {
        log(&format!(
            "{name}: removed {} apps, freed {} blocks ({} stayed, shared with other files)",
            report.removed.len(),
            report.blocks_freed,
            report.blocks_still_shared
        ));
    }
    if !report.not_present.is_empty() {
        log(&format!("{name}: not in this image, skipped: {}", report.not_present.join(", ")));
    }

    let prop_path = recipe.build_prop_path.get(name);
    if volume.exists(prop_path)? {
        let original = String::from_utf8_lossy(&volume.read_file(prop_path)?).into_owned();
        // A recipe with no identity of its own leaves the base's, see `RomRecipe::identity`.
        let (mut text, changed) = match &recipe.identity {
            Some(identity) => {
                let rewritten = rewrite_identity(&original, identity)?;
                (rewritten.text, rewritten.changed)
            }
            None => (original.clone(), Vec::new()),
        };
        report.props_changed.extend(changed.iter().cloned());
        if name == Volume::System {
            text = upsert_props(&text, &props_of(recipe))?;
            report.props_changed.extend(recipe.system_props.iter().map(|(k, _)| k.clone()));
        }
        if text != original {
            let data = text.into_bytes();
            volume.replace_file(prop_path, &data)?;
            written.push((prop_path.clone(), data));
        }
        log(&format!("{name}: {prop_path}: {} identity keys rewritten", changed.len()));
    } else {
        log(&format!("{name}: no {prop_path}"));
    }

    for edit in recipe.edits().iter().filter(|e| e.volume == name) {
        if !volume.exists(&edit.path)? {
            fail!(
                "{name}:{} is not in the {} image: {} cannot be built from this base",
                edit.path,
                recipe.base_tag,
                recipe.id
            );
        }
        let stock = volume.read_file(&edit.path)?;
        let data = apply_transform(edit, &stock, params)?;
        if data != stock {
            volume.replace_file(&edit.path, &data)?;
            written.push((edit.path.clone(), data));
        }
        report.edited.get_or_insert_with(Vec::new).push(edit.path.clone());
    }
    if let Some(edited) = report.edited.as_ref().filter(|e| !e.is_empty()) {
        log(&format!("{name}: rewrote {}", edited.join(", ")));
    }

    for entry in recipe.files.iter().filter(|f| f.volume == name) {
        let options = NewInodeOptions { mode: entry.mode as u16, uid: 0, gid: 0, selinux: &entry.selinux };
        match entry.kind {
            FileKind::Dir => {
                if !volume.exists(&entry.path)? {
                    volume.mkdir(&entry.path, options)?;
                }
            }
            FileKind::File => {
                let data = match entry.source {
                    Some(source) => contents.get(&source).cloned().ok_or_else(|| err!("no content for {}", entry.path))?,
                    None => Vec::new(),
                };
                if volume.exists(&entry.path)? {
                    volume.replace_file(&entry.path, &data)?;
                } else {
                    volume.create_file(&entry.path, &data, options)?;
                }
                written.push((entry.path.clone(), data));
            }
        }
        report.created.push(entry.path.clone());
    }
    if !report.created.is_empty() {
        log(&format!("{name}: added {}", report.created.join(", ")));
    }

    volume.flush()?;
    drop(volume);

    let mut check = Ext4Volume::open(FileDisk::new(file, window.offset, window.size, false), OpenOptions::default())?;
    let verified = check.verify()?;
    if !verified.ok {
        let first: Vec<&str> = verified.problems.iter().take(5).map(String::as_str).collect();
        fail!("{name}: the edited filesystem failed verification: {}", first.join("; "));
    }
    for (path, data) in &written {
        if &check.read_file(path)? != data {
            fail!("{name}: {path} did not read back as written");
        }
    }
    report.free_blocks = check.free_blocks();
    report.free_inodes = u64::from(check.free_inodes());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipe::openemu_recipe;

    fn make_image(dir: &Path, manifest: Option<&str>) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("system.img"), "x").unwrap();
        if let Some(manifest) = manifest {
            fs::write(dir.join(MANIFEST), manifest).unwrap();
        }
    }

    #[test]
    fn images_staging_and_the_key_live_where_the_layout_says() {
        let sdk = Path::new("C:\\oe\\sdk");
        let paths = rom_paths(sdk, &openemu_recipe());
        assert_eq!(paths.base_dir, sdk.join("system-images").join("android-30").join("default").join("x86_64"));
        assert_eq!(paths.image_dir, sdk.join("system-images").join("android-30").join("openemu").join("x86_64"));
        assert_eq!(paths.staging_dir, with_suffix(&paths.image_dir, ".staging"));
        assert_eq!(paths.prev_dir, with_suffix(&paths.image_dir, ".prev"));
        assert_eq!(rom_key_dir(Path::new("C:\\oe")), Path::new("C:\\oe").join("rom"));
    }

    #[test]
    fn a_manifest_from_the_old_debugfs_builder_is_not_ours() {
        let dir = tempfile::tempdir().unwrap();
        make_image(dir.path(), Some(r#"{"imageDir":"x","removed":[],"spec":{"tag":"openemu"}}"#));
        assert_eq!(read_manifest(dir.path()), None);
        make_image(dir.path(), Some(r#"{"builder":"openemu-rom","builderRevision":1,"romId":"abc"}"#));
        assert_eq!(read_manifest(dir.path()).unwrap().rom_id, "abc");
    }

    #[test]
    fn a_crash_between_the_two_renames_of_a_swap_is_repaired_from_prev() {
        let dir = tempfile::tempdir().unwrap();
        let paths = rom_paths(dir.path(), &openemu_recipe());
        make_image(&paths.prev_dir, Some(r#"{"builder":"openemu-rom","romId":"last-good"}"#));

        assert!(recover_interrupted_swap(&paths).unwrap());
        assert!(paths.image_dir.join("system.img").exists());
        assert!(!paths.prev_dir.exists());
        assert_eq!(read_manifest(&paths.image_dir).unwrap().rom_id, "last-good");
    }

    #[test]
    fn a_leftover_prev_beside_a_finished_swap_is_removed_not_restored() {
        let dir = tempfile::tempdir().unwrap();
        let paths = rom_paths(dir.path(), &openemu_recipe());
        make_image(&paths.image_dir, Some(r#"{"builder":"openemu-rom","romId":"new"}"#));
        make_image(&paths.prev_dir, Some(r#"{"builder":"openemu-rom","romId":"old"}"#));

        assert!(!recover_interrupted_swap(&paths).unwrap());
        assert!(!paths.prev_dir.exists());
        assert_eq!(read_manifest(&paths.image_dir).unwrap().rom_id, "new");
    }

    #[test]
    fn an_image_whose_partitions_cannot_be_read_is_damaged() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("system.img");
        std::fs::write(&image, vec![0u8; 64 * 1024]).unwrap();
        let problem = damage(&image).expect("zeros are no partition table");
        assert!(problem.contains("partition table"), "{problem}");
        assert!(damage(&dir.path().join("missing.img")).is_some(), "a missing image is damaged too");
    }

    #[test]
    fn state_nothing_built_an_old_builder_a_changed_builder_revision() {
        let dir = tempfile::tempdir().unwrap();
        let contents = HashMap::from([(Source::Wallpaper, b"png".to_vec())]);
        let recipe = openemu_recipe();
        let state_of = || rom_state(dir.path(), &recipe, Some(&contents), RomParams::default()).unwrap();
        assert_eq!(state_of().reason, "not built");

        let paths = rom_paths(dir.path(), &recipe);
        make_image(&paths.image_dir, Some(r#"{"spec":{}}"#));
        let old = state_of();
        assert!(old.built);
        assert!(!old.up_to_date);
        assert!(old.reason.contains("older builder"));

        make_image(
            &paths.image_dir,
            Some(r#"{"builder":"openemu-rom","builderRevision":-1,"recipeHash":"x","baseDigest":"y","romId":"z"}"#),
        );
        assert!(state_of().reason.contains("builder changed"));
    }

    #[test]
    fn the_manifest_is_written_the_way_the_typescript_builder_wrote_it() {
        let manifest = RomManifest {
            builder: "openemu-rom".into(),
            builder_revision: 2,
            recipe_id: "openemu".into(),
            recipe_version: 1,
            recipe_hash: "h".into(),
            base_digest: "b".into(),
            vbmeta_digest: "v".into(),
            rom_id: "r".into(),
            params: None,
            volumes: ManifestVolumes::default(),
            built_at: "2026-11-23T14:00:45.678Z".into(),
        };
        let json = serde_json::to_string_pretty(&manifest).unwrap();
        assert!(json.starts_with("{\n  \"builder\": \"openemu-rom\",\n  \"builderRevision\": 2,\n  \"recipeId\": \"openemu\","));
        assert!(!json.contains("\"params\""), "omitted, not null, when the recipe reads none");
        assert!(json.contains("\"notPresent\": []"));
        assert!(json.contains("\"system_ext\": {"));
        let back: RomManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, manifest);
    }

    #[test]
    fn boot_params_read_the_emulators_textproto() {
        let text = "# summary\nmajor_version: 2\r\nparam: \"androidboot.vbmeta.size=6144\"\r\nparam:\"androidboot.vbmeta.digest=ABC\"  \nparam: \"no-equals\"\n";
        let params = boot_params(text);
        assert_eq!(params.get("androidboot.vbmeta.size").map(String::as_str), Some("6144"));
        assert_eq!(params.get("androidboot.vbmeta.digest").map(String::as_str), Some("ABC"));
        assert_eq!(params.len(), 2);
    }
}
