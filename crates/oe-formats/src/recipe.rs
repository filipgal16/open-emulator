//! A ROM, as data: what the builder removes, renames, rewrites and adds on top of one of Google's
//! emulator images. This module holds the shape, the rules every recipe must meet, and the first
//! recipe — `openemu`, built from the AOSP `default` API 30 image; `design/openemu-rom.md`
//! ("Recipe v1") is where each of its choices is argued. [`crate::recipe_compat`] holds the second,
//! and [`crate::recipes`] is where a recipe is looked up by id.
//!
//! Paths are **in-volume**: each logical partition is its own ext4, opened on its own. The system
//! volume is system-as-root — its tree starts at `/` with the content under `/system/...` — while
//! system_ext, product and vendor are mounted at their own root, so their apps are `/app/...`, not
//! `/product/app/...`. Mixing the two up removes nothing and still reports success, which is what
//! [`validate_recipe`] refuses.

use std::collections::{BTreeMap, HashMap, HashSet};

use sha2::{Digest, Sha256};

use crate::build_prop::{check_identity, check_prop, RomIdentity};
use crate::bytes::{hex, json_quote};
use crate::{fail, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Volume {
    System,
    SystemExt,
    Product,
    Vendor,
}

impl Volume {
    pub const ALL: [Volume; 4] = [Volume::System, Volume::SystemExt, Volume::Product, Volume::Vendor];

    /// The name the partition has in `super`, and in recipes.
    pub fn name(self) -> &'static str {
        match self {
            Volume::System => "system",
            Volume::SystemExt => "system_ext",
            Volume::Product => "product",
            Volume::Vendor => "vendor",
        }
    }
}

impl std::fmt::Display for Volume {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// One value per volume.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PerVolume<T> {
    pub system: T,
    pub system_ext: T,
    pub product: T,
    pub vendor: T,
}

impl<T> PerVolume<T> {
    pub fn get(&self, volume: Volume) -> &T {
        match volume {
            Volume::System => &self.system,
            Volume::SystemExt => &self.system_ext,
            Volume::Product => &self.product,
            Volume::Vendor => &self.vendor,
        }
    }

    pub fn get_mut(&mut self, volume: Volume) -> &mut T {
        match volume {
            Volume::System => &mut self.system,
            Volume::SystemExt => &mut self.system_ext,
            Volume::Product => &mut self.product,
            Volume::Vendor => &mut self.vendor,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Dir,
    File,
}

impl FileKind {
    fn name(self) -> &'static str {
        match self {
            FileKind::Dir => "dir",
            FileKind::File => "file",
        }
    }
}

/// Where a created file's bytes come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    Wallpaper,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Source::Wallpaper => "wallpaper",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RomFile {
    pub volume: Volume,
    /// In-volume path; see the module comment.
    pub path: String,
    pub kind: FileKind,
    /// Permission bits only (`0o755`); the type comes from `kind`.
    pub mode: u32,
    /// The `security.selinux` label. Unlabeled, init is not allowed to read the file on enforcing.
    pub selinux: String,
    /// Where a file's bytes come from; a file without one is created empty.
    pub source: Option<Source>,
}

/// `arm-cpuinfo`: the `/proc/cpuinfo` the ARM translator shows translated apps, repeated once per
/// guest core. See [`crate::arm_cpuinfo`]. Needs [`RomParams::arm_cpu_cores`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transform {
    ArmCpuinfo,
}

impl Transform {
    pub fn name(self) -> &'static str {
        match self {
            Transform::ArmCpuinfo => "arm-cpuinfo",
        }
    }
}

/// A stock file whose bytes are rewritten from its own content. The inode is kept, so its mode,
/// owner and label are whatever Google gave it — which is why an edit names no label, and why the
/// file must already exist: a recipe that edits a file its base does not have fails the build
/// rather than inventing one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RomEdit {
    pub volume: Volume,
    /// In-volume path; see the module comment.
    pub path: String,
    pub transform: Transform,
}

/// What a build is given beyond the recipe: facts about this machine's guest that the image has
/// to agree with. They are hashed with the recipe, so a changed value rebuilds the image and gives
/// it a new ROM id, which is what drops a snapshot taken with the old one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RomParams {
    /// How many CPU cores the guest is started with.
    pub arm_cpu_cores: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RomRecipe {
    /// Names the image directory and the SDK tag, so it is held to what a profile name may be.
    pub id: String,
    /// Bumped for any change to what the image contains; it shows in the build number.
    pub version: u32,
    pub display_name: String,
    /// The SDK tag of the image this is built from: `default`, `google_apis`.
    pub base_tag: String,
    pub api_level: u32,
    /// The brand, model and fingerprints written into every `build.prop`, or `None` to leave the
    /// base's own. `None` is not a shortcut: Google Play services decides from the fingerprint
    /// whether a device may sign in, so a recipe built on a Google image keeps Google's.
    pub identity: Option<RomIdentity>,
    pub build_prop_path: PerVolume<String>,
    /// In-volume directories to remove, whole. Run first, so the space is there for `files`.
    pub debloat: PerVolume<Vec<String>>,
    /// Upserted into the system volume's `build.prop`, in this order.
    pub system_props: Vec<(String, String)>,
    /// Stock files rewritten in place, after debloat. `None` and an empty list build the same
    /// image but hash differently, as they did in the TypeScript builder.
    pub edits: Option<Vec<RomEdit>>,
    /// Created in order, after debloat — a directory before anything inside it.
    pub files: Vec<RomFile>,
}

impl RomRecipe {
    pub fn system_prop(&self, key: &str) -> Option<&str> {
        self.system_props.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn edits(&self) -> &[RomEdit] {
        self.edits.as_deref().unwrap_or(&[])
    }
}

/// Bumped whenever the builder changes how it applies a recipe — a different edit order, a fixed
/// ext4 bug, another file rewritten — without the recipe itself changing.
///
/// It is hashed with the recipe, because "up to date" is decided by the hash: without it, an image
/// built by a broken builder would count as current forever after the fix shipped.
// 2: the ROM id became a build id over recipe, base and vbmeta, not the vbmeta digest alone.
pub const BUILDER_REVISION: u32 = 2;

// ── Recipe v1 ───────────────────────────────────────────────────────────────────────────────────

const VERSION: u32 = 1;

pub(crate) const SYSTEM_FILE: &str = "u:object_r:system_file:s0";

/// The system volume is rooted at `/`, so this in-volume path is also the path Android sees —
/// which is what `ro.config.wallpaper` has to name.
const MEDIA_DIR: &str = "/system/media";
const WALLPAPER_DIR: &str = "/system/media/openemu";
const WALLPAPER: &str = "/system/media/openemu/wallpaper.png";

pub(crate) fn under(dir: &str, names: &[&str]) -> Vec<String> {
    names.iter().map(|name| format!("{dir}/{name}")).collect()
}

/// Apps the recipe must never remove, and why. A test holds `debloat` to this.
///
/// `PartnerBookmarksProvider` is the one provider that goes: it only supplies a partner's preset
/// bookmarks, and nothing on this image has any.
pub const KEPT: &[(&str, &str)] = &[
    ("BookmarkProvider", "Browser2 and QuickSearchBox query it; without it the browser and search suggestions break"),
    ("PrintSpooler", "PrintManagerService binds the spooler"),
    ("Camera2", "ACTION_IMAGE_CAPTURE needs a handler"),
    ("WallpaperPicker", "the launcher's wallpaper entry opens the picker"),
    ("WallpaperCropper", "the picker hands the chosen image to the cropper"),
    ("WallpaperBackup", "backs up the user's wallpaper; harmless, and not worth a fight"),
    ("CalendarProvider", "removing the Calendar app does not remove its provider, which other apps use"),
    ("ContactsProvider", "removing the Contacts app does not remove its provider, which telephony and other apps use"),
    ("TelephonyProvider", "telephony's own data; the framework starts it regardless of the apps removed"),
    ("BlockedNumberProvider", "Telecom checks incoming calls against it"),
    ("SettingsProvider", "Settings.System/Secure/Global live in it; without it nothing boots"),
    ("DownloadProvider", "DownloadManager is a framework API any app may call"),
    ("TeleService", "com.android.phone; the framework starts it regardless of the apps removed"),
    ("Telecom", "call routing in the framework; runs whether or not a dialer is installed"),
];

/// The `openemu` recipe.
pub fn openemu_recipe() -> RomRecipe {
    RomRecipe {
        id: "openemu".into(),
        version: VERSION,
        display_name: "open-emulator Android".into(),
        base_tag: "default".into(),
        api_level: 30,
        identity: Some(RomIdentity {
            brand: "open-emulator".into(),
            manufacturer: "open-emulator".into(),
            model: "OpenEmulator One".into(),
            name: "openemu_x86_64".into(),
            device: "openemu".into(),
            display_id: format!("open-emulator Android 11 (openemu {VERSION})"),
            // The build this was made from: release, build id, incremental, type and tags are the
            // stock image's and stay honest. If Google republishes `default` under another build
            // id, this line is the one to update with it.
            description: "openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys".into(),
            build_product: "openemu".into(),
        }),
        build_prop_path: PerVolume {
            system: "/system/build.prop".into(),
            system_ext: "/build.prop".into(),
            product: "/build.prop".into(),
            vendor: "/build.prop".into(),
        },
        debloat: PerVolume {
            system: [
                // Screensavers, the easter egg, live wallpapers, Bluetooth MIDI, IMS presence and
                // RCS, SIM toolkit screens, print recommendations and the tracing tool: user-facing
                // extras, or services for hardware and carrier features the emulator does not
                // have. None is needed to boot; the framework looks the MIDI and
                // print-recommendation services up only on demand. NfcNci goes because the stock
                // image declares no `android.hardware.nfc` feature (checked on a boot), so
                // SystemServer never starts NfcService. PartnerBookmarksProvider only serves a
                // partner's preset bookmarks; BookmarkProvider, which Browser2 uses, stays.
                under(
                    "/system/app",
                    &[
                        "BasicDreams",
                        "BluetoothMidiService",
                        "EasterEgg",
                        "LiveWallpapersPicker",
                        "NfcNci",
                        "PartnerBookmarksProvider",
                        "PresencePolling",
                        "PrintRecommendationService",
                        "RcsService",
                        "SimAppDialog",
                        "Stk",
                        "Traceur",
                    ],
                ),
                // The default print plugin (the spooler stays), the call-log backup agent (no
                // dialer left to log calls), legacy cell broadcast, the GSI installer (DSU), the
                // effects panel for the removed Music app, the opportunistic network service
                // (multi-SIM carrier switching) and the NFC tag viewer. The verification boot
                // checks that system_server stays up without them.
                under(
                    "/system/priv-app",
                    &[
                        "BuiltInPrintService",
                        "CallLogBackup",
                        "CellBroadcastLegacyApp",
                        "DynamicSystemInstallationService",
                        "MusicFX",
                        "ONS",
                        "Tag",
                    ],
                ),
            ]
            .concat(),
            // The emergency information screen, a phone feature with no use on a desktop emulator.
            system_ext: under("/priv-app", &["EmergencyInfo"]),
            product: [
                // Bundled user apps. Their data lives in providers under other directory names
                // (CalendarProvider, MediaProvider), which stay; nothing binds these by package.
                // Without `messaging` there is no default SMS app, which this emulator does not
                // need.
                under("/app", &["Calendar", "DeskClock", "Gallery2", "Music", "PhotoTable", "messaging"]),
                // ContactsProvider stays. Without a dialer Telecom logs a missing default dialer
                // and keeps running; there is no in-call UI, which is accepted here.
                under("/priv-app", &["Contacts", "Dialer"]),
            ]
            .concat(),
            // Nothing: vendor holds the goldfish HALs and one free inode.
            vendor: Vec::new(),
        },
        system_props: vec![
            ("ro.openemu.rom".into(), "1".into()),
            ("ro.openemu.rom.version".into(), VERSION.to_string()),
            // Applies only when a user has no wallpaper file yet, so it shows on fresh AVDs, not
            // upgrades.
            ("ro.config.wallpaper".into(), WALLPAPER.into()),
        ],
        edits: None,
        files: vec![
            // This image keeps its media under /product/media; /system/media, the usual AOSP home
            // for boot animations and wallpapers, does not exist on it, so the ROM makes it.
            RomFile {
                volume: Volume::System,
                path: MEDIA_DIR.into(),
                kind: FileKind::Dir,
                mode: 0o755,
                selinux: SYSTEM_FILE.into(),
                source: None,
            },
            RomFile {
                volume: Volume::System,
                path: WALLPAPER_DIR.into(),
                kind: FileKind::Dir,
                mode: 0o755,
                selinux: SYSTEM_FILE.into(),
                source: None,
            },
            RomFile {
                volume: Volume::System,
                path: WALLPAPER.into(),
                kind: FileKind::File,
                mode: 0o644,
                selinux: SYSTEM_FILE.into(),
                source: Some(Source::Wallpaper),
            },
        ],
    }
}

// ── Hash ────────────────────────────────────────────────────────────────────────────────────────

/// A JSON value with object keys kept sorted: one text per value.
enum Canon {
    Null,
    Number(u64),
    Text(String),
    Array(Vec<Canon>),
    Object(BTreeMap<String, Canon>),
}

impl Canon {
    fn text(value: &str) -> Canon {
        Canon::Text(value.to_owned())
    }

    fn object(members: Vec<(&str, Canon)>) -> Canon {
        Canon::Object(members.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    /// JSON with object keys sorted, as the TypeScript builder's `canonical` wrote it. Keys here
    /// are ASCII, where UTF-16 code-unit order and byte order agree.
    fn write(&self, out: &mut String) {
        match self {
            Canon::Null => out.push_str("null"),
            Canon::Number(n) => out.push_str(&n.to_string()),
            Canon::Text(text) => out.push_str(&json_quote(text)),
            Canon::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Canon::Object(members) => {
                out.push('{');
                for (i, (key, value)) in members.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&json_quote(key));
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn per_volume<T>(values: &PerVolume<T>, each: impl Fn(&T) -> Canon) -> Canon {
    Canon::Object(Volume::ALL.iter().map(|&v| (v.name().to_owned(), each(values.get(v)))).collect())
}

fn texts(list: &[String]) -> Canon {
    Canon::Array(list.iter().map(|s| Canon::text(s)).collect())
}

/// The recipe as the TypeScript object it was, field names and all, so the hash of a recipe is
/// the hash the TypeScript builder computed and an image it built stays current.
fn canonical_recipe(recipe: &RomRecipe) -> Canon {
    let identity = match &recipe.identity {
        None => Canon::Null,
        Some(identity) => Canon::object(vec![
            ("brand", Canon::text(&identity.brand)),
            ("manufacturer", Canon::text(&identity.manufacturer)),
            ("model", Canon::text(&identity.model)),
            ("name", Canon::text(&identity.name)),
            ("device", Canon::text(&identity.device)),
            ("displayId", Canon::text(&identity.display_id)),
            ("description", Canon::text(&identity.description)),
            ("buildProduct", Canon::text(&identity.build_product)),
        ]),
    };
    let files = Canon::Array(
        recipe
            .files
            .iter()
            .map(|file| {
                let mut members = vec![
                    ("volume", Canon::text(file.volume.name())),
                    ("path", Canon::text(&file.path)),
                    ("kind", Canon::text(file.kind.name())),
                    ("mode", Canon::Number(u64::from(file.mode))),
                    ("selinux", Canon::text(&file.selinux)),
                ];
                if let Some(source) = file.source {
                    members.push(("source", Canon::text(source.name())));
                }
                Canon::object(members)
            })
            .collect(),
    );
    let mut members = vec![
        ("id", Canon::text(&recipe.id)),
        ("version", Canon::Number(u64::from(recipe.version))),
        ("displayName", Canon::text(&recipe.display_name)),
        ("baseTag", Canon::text(&recipe.base_tag)),
        ("apiLevel", Canon::Number(u64::from(recipe.api_level))),
        ("identity", identity),
        ("buildPropPath", per_volume(&recipe.build_prop_path, |path| Canon::text(path))),
        ("debloat", per_volume(&recipe.debloat, |list| texts(list))),
        (
            "systemProps",
            Canon::Object(recipe.system_props.iter().map(|(k, v)| (k.clone(), Canon::text(v))).collect()),
        ),
        ("files", files),
    ];
    if let Some(edits) = &recipe.edits {
        members.push((
            "edits",
            Canon::Array(
                edits
                    .iter()
                    .map(|edit| {
                        Canon::object(vec![
                            ("volume", Canon::text(edit.volume.name())),
                            ("path", Canon::text(&edit.path)),
                            ("transform", Canon::text(edit.transform.name())),
                        ])
                    })
                    .collect(),
            ),
        ));
    }
    Canon::object(members)
}

/// What decides whether a built image is current: sha256 over the recipe, [`BUILDER_REVISION`],
/// and the sha256 of every content a file is built from.
///
/// The serialisation sorts object keys, so reordering a literal does not force a 3 GB rebuild;
/// arrays keep their order, because the order of `files` is the order they are created in.
/// Content the recipe does not use is ignored. `builder_revision` is there for tests; the builder
/// always passes [`BUILDER_REVISION`].
pub fn recipe_hash(
    recipe: &RomRecipe,
    contents: &HashMap<Source, Vec<u8>>,
    builder_revision: u32,
    params: RomParams,
) -> Result<String> {
    let mut sources = BTreeMap::new();
    for file in &recipe.files {
        let Some(source) = file.source else { continue };
        let Some(content) = contents.get(&source) else {
            fail!(
                "{}:{} is built from '{}', and no content was given for it",
                file.volume,
                file.path,
                source.name()
            );
        };
        sources.insert(source.name().to_owned(), Canon::Text(hex(&Sha256::digest(content))));
    }
    let mut members = vec![
        ("builderRevision", Canon::Number(u64::from(builder_revision))),
        ("recipe", canonical_recipe(recipe)),
        ("sources", Canon::Object(sources)),
    ];
    // `params` is absent for a recipe that reads none: such a recipe hashes exactly as it did
    // before params existed, so its built image stays current.
    if let Some(used) = used_params(recipe, params)? {
        let cores = used.arm_cpu_cores.expect("used_params checked it");
        members.push(("params", Canon::object(vec![("armCpuCores", Canon::Number(u64::from(cores)))])));
    }
    let mut text = String::new();
    Canon::object(members).write(&mut text);
    Ok(hex(&Sha256::digest(text.as_bytes())))
}

/// The emulator's own ceiling for `hw.cpu.ncore`.
pub const MAX_ARM_CPU_CORES: u32 = 64;

/// The params this recipe's edits actually read, checked — or `None` if it reads none. A param
/// the recipe does not use is left out, so it cannot force a rebuild.
pub fn used_params(recipe: &RomRecipe, params: RomParams) -> Result<Option<RomParams>> {
    if !recipe.edits().iter().any(|edit| edit.transform == Transform::ArmCpuinfo) {
        return Ok(None);
    }
    let Some(cores) = params.arm_cpu_cores else {
        fail!(
            "{} rewrites the ARM translator's cpuinfo and has to be told how many cores the guest has",
            recipe.id
        );
    };
    if !(1..=MAX_ARM_CPU_CORES).contains(&cores) {
        fail!("armCpuCores {cores} is not a whole number from 1 to {MAX_ARM_CPU_CORES}");
    }
    Ok(Some(RomParams { arm_cpu_cores: Some(cores) }))
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────

/// Directories new files may go into without declaring them: measured on the stock volumes, not
/// assumed. `/system` is a linear directory of 17 entries in one block on the stock system
/// volume. Adding one here is a claim about Google's image, so it needs a measurement behind it —
/// an earlier revision listed `/system/media`, which that image does not have.
fn stock_dirs(volume: Volume) -> &'static [&'static str] {
    match volume {
        Volume::System => &["/system"],
        _ => &[],
    }
}

/// `^[a-z0-9_-]{1,32}$`: what a profile name may be (`env-file`); the id and the base tag are each
/// used as one.
fn is_safe_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// `^u:object_r:[a-z0-9_]+:s0$`
fn is_selinux_file_label(label: &str) -> bool {
    label
        .strip_prefix("u:object_r:")
        .and_then(|rest| rest.strip_suffix(":s0"))
        .is_some_and(|ty| !ty.is_empty() && ty.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
}

/// Fails, naming the entry, if the recipe could not be applied as written. Run before a build
/// touches anything, so a bad recipe costs no 3 GB copy.
pub fn validate_recipe(recipe: &RomRecipe) -> Result<()> {
    // The id becomes a directory under system-images and the AVD's `tag.id`; the base tag and the
    // API level become the directory the base is read from.
    if !is_safe_name(&recipe.id) {
        fail!("recipe id '{}' is not a safe name", recipe.id);
    }
    if !is_safe_name(&recipe.base_tag) {
        fail!("{}: base tag '{}' is not a safe name", recipe.id, recipe.base_tag);
    }
    if recipe.base_tag == recipe.id {
        fail!("{} cannot be built from itself", recipe.id);
    }
    if !(21..=99).contains(&recipe.api_level) {
        fail!("{}: API level {} is not one an emulator image has", recipe.id, recipe.api_level);
    }
    if recipe.version < 1 {
        fail!("recipe version {} is not a positive integer", recipe.version);
    }
    if let Some(identity) = &recipe.identity {
        check_identity(identity)?;
    }
    for (key, value) in &recipe.system_props {
        check_prop(key, value)?;
    }

    let mut removed: HashSet<(Volume, String)> = HashSet::new();
    for volume in Volume::ALL {
        check_path(volume, recipe.build_prop_path.get(volume), "build.prop")?;
        for target in recipe.debloat.get(volume) {
            check_path(volume, target, "debloat path")?;
            if !removed.insert((volume, target.clone())) {
                fail!("debloat path {volume}:{target} is listed twice");
            }
        }
    }

    // Debloat runs before anything else, so a removed path that is — or contains — something the
    // recipe then edits or creates would leave the builder editing a file that no longer exists.
    let removed_ancestor = |volume: Volume, target: &str| -> Option<String> {
        let mut p = target;
        while !p.is_empty() {
            if removed.contains(&(volume, p.to_owned())) {
                return Some(p.to_owned());
            }
            p = &p[..p.rfind('/').unwrap_or(0)];
        }
        None
    };

    for volume in Volume::ALL {
        let path = recipe.build_prop_path.get(volume);
        if let Some(gone) = removed_ancestor(volume, path) {
            fail!("{volume}:{path} is rewritten, but debloat removes {gone}");
        }
    }

    let mut edited: HashSet<(Volume, String)> = HashSet::new();
    for edit in recipe.edits() {
        check_path(edit.volume, &edit.path, "edit")?;
        let id = format!("{}:{}", edit.volume, edit.path);
        if edited.contains(&(edit.volume, edit.path.clone())) {
            fail!("edit {id} is listed twice");
        }
        if let Some(gone) = removed_ancestor(edit.volume, &edit.path) {
            fail!("{id} is edited, but debloat removes {gone}");
        }
        // Both rewrite the whole file from the stock bytes, so the second would undo the first.
        if recipe.build_prop_path.get(edit.volume) == &edit.path {
            fail!("{id} is the volume's build.prop, which is rewritten on its own");
        }
        edited.insert((edit.volume, edit.path.clone()));
    }

    let mut created: HashMap<(Volume, String), FileKind> = HashMap::new();
    for file in &recipe.files {
        check_path(file.volume, &file.path, "file")?;
        let id = format!("{}:{}", file.volume, file.path);
        let key = (file.volume, file.path.clone());
        if created.contains_key(&key) {
            fail!("file {id} is listed twice");
        }
        if edited.contains(&key) {
            fail!("{id} is both edited in place and created as a file");
        }

        if let Some(gone) = removed_ancestor(file.volume, &file.path) {
            if gone == file.path {
                fail!("{id} is both removed by debloat and created as a file");
            }
            fail!("{id} is created inside {gone}, which debloat removes");
        }

        let parent = &file.path[..file.path.rfind('/').unwrap_or(0)];
        let parent_ok = match created.get(&(file.volume, parent.to_owned())) {
            Some(kind) => *kind == FileKind::Dir,
            None => stock_dirs(file.volume).contains(&parent),
        };
        if !parent_ok {
            fail!("{id}: its parent {parent} is neither a known stock directory nor a directory declared before it");
        }

        if file.mode > 0o7777 {
            fail!("{id}: mode 0o{:o} is not permission bits alone — the type comes from kind", file.mode);
        }
        if file.kind == FileKind::Dir && file.source.is_some() {
            fail!("{id} is a directory and cannot have content");
        }
        if !is_selinux_file_label(&file.selinux) {
            fail!("{id}: '{}' is not an SELinux file label", file.selinux);
        }

        created.insert(key, file.kind);
    }
    Ok(())
}

/// An in-volume path must be absolute and normalised — the ext4 editor looks names up one
/// component at a time, and `.`, `..` or an empty component are not names it will find — and must
/// have the shape its volume has (see the module comment).
fn check_path(volume: Volume, target: &str, what: &str) -> Result<()> {
    if !target.starts_with('/') {
        fail!("{what} {volume}:{target} is not absolute");
    }
    // `^(\/[^/\0]+)+$`, and no `.` or `..` component.
    let components: Vec<&str> = target[1..].split('/').collect();
    let normalised = components.iter().all(|part| !part.is_empty() && !part.contains('\0') && *part != "." && *part != "..");
    if !normalised {
        fail!("{what} {volume}:{target} is not normalised");
    }
    let in_system = target.starts_with("/system/");
    if volume == Volume::System && !in_system {
        fail!("{what} system:{target} is outside /system/ — the system volume is rooted at / with its content under /system/");
    }
    if volume != Volume::System && in_system {
        fail!("{what} {volume}:{target} starts with /system/, but {volume} is mounted at its own root");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_WALLPAPER: &[u8] = b"\x89PNG\r\n\x1a\n not really a wallpaper";

    fn contents() -> HashMap<Source, Vec<u8>> {
        HashMap::from([(Source::Wallpaper, TEST_WALLPAPER.to_vec())])
    }

    fn hash(recipe: &RomRecipe) -> String {
        recipe_hash(recipe, &contents(), BUILDER_REVISION, RomParams::default()).unwrap()
    }

    fn basename(p: &str) -> &str {
        &p[p.rfind('/').map_or(0, |i| i + 1)..]
    }

    #[test]
    fn the_hash_is_the_one_the_typescript_builder_computed() {
        // recipeHash(OPENEMU_RECIPE, { wallpaper: <the test bytes above> }) in desktop v0.2.0.
        assert_eq!(hash(&openemu_recipe()), "45bd300a85ac3cc65949e9874c9855b7c575f56b2a33ead72a750aafbc15a47b");
    }

    #[test]
    fn the_openemu_recipe_validates() {
        validate_recipe(&openemu_recipe()).unwrap();
    }

    #[test]
    fn the_recipe_carries_exactly_the_plans_identity_props_and_files() {
        let r = openemu_recipe();
        assert_eq!(r.id, "openemu");
        assert_eq!(r.version, 1);
        assert_eq!(r.display_name, "open-emulator Android");
        assert_eq!(r.base_tag, "default");
        assert_eq!(r.api_level, 30);
        let identity = r.identity.as_ref().unwrap();
        assert_eq!(identity.display_id, "open-emulator Android 11 (openemu 1)");
        assert_eq!(identity.description, "openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys");
        assert_eq!(r.build_prop_path.system, "/system/build.prop");
        assert_eq!(r.build_prop_path.vendor, "/build.prop");
        assert_eq!(r.system_prop("ro.config.wallpaper"), Some("/system/media/openemu/wallpaper.png"));
        assert_eq!(r.files.len(), 3);
        assert_eq!(r.files[2].source, Some(Source::Wallpaper));
    }

    #[test]
    fn the_build_number_and_the_version_prop_follow_the_version() {
        let r = openemu_recipe();
        assert!(r.identity.as_ref().unwrap().display_id.contains(&format!("openemu {}", r.version)));
        assert_eq!(r.system_prop("ro.openemu.rom.version"), Some(r.version.to_string().as_str()));
    }

    #[test]
    fn system_paths_live_under_system_the_other_volumes_at_their_own_root() {
        let r = openemu_recipe();
        for p in &r.debloat.system {
            assert!(p.starts_with("/system/app/") || p.starts_with("/system/priv-app/"), "{p}");
        }
        for volume in [Volume::SystemExt, Volume::Product, Volume::Vendor] {
            for p in r.debloat.get(volume) {
                assert!(p.starts_with("/app/") || p.starts_with("/priv-app/"), "{volume}: {p}");
            }
        }
    }

    #[test]
    fn nothing_on_the_kept_list_is_removed_and_each_keep_says_why() {
        let r = openemu_recipe();
        let removed: Vec<&str> = Volume::ALL.iter().flat_map(|&v| r.debloat.get(v)).map(|p| basename(p)).collect();
        for (name, reason) in KEPT {
            assert!(!removed.contains(name), "{name} is kept on purpose: {reason}");
            assert!(reason.len() > 10, "{name} needs a reason");
        }
        let providers: Vec<&&str> = removed.iter().filter(|n| n.ends_with("Provider")).collect();
        assert_eq!(providers, vec![&"PartnerBookmarksProvider"]);
    }

    #[test]
    fn the_hash_is_stable() {
        let a = hash(&openemu_recipe());
        assert_eq!(a.len(), 64);
        assert_eq!(hash(&openemu_recipe()), a);
    }

    #[test]
    fn the_hash_ignores_prop_order_but_not_the_order_of_files() {
        let r = openemu_recipe();
        let mut reordered = r.clone();
        reordered.system_props.reverse();
        assert_eq!(hash(&reordered), hash(&r));

        let mut swapped = r.clone();
        swapped.files.reverse();
        assert_ne!(hash(&swapped), hash(&r), "files are created in order");
    }

    #[test]
    fn the_hash_changes_with_a_debloat_entry() {
        let base = hash(&openemu_recipe());

        let mut fewer = openemu_recipe();
        fewer.debloat.product.pop();
        assert_ne!(hash(&fewer), base);

        let mut renamed = openemu_recipe();
        renamed.debloat.system[0] = "/system/app/SomethingElse".into();
        assert_ne!(hash(&renamed), base);

        let mut moved = openemu_recipe();
        let path = moved.debloat.product.pop().unwrap();
        moved.debloat.vendor.push(path);
        assert_ne!(hash(&moved), base, "the same path on another volume is another file");
    }

    #[test]
    fn the_hash_changes_with_the_version_the_builder_revision_and_the_wallpaper_bytes() {
        let base = hash(&openemu_recipe());

        let mut bumped = openemu_recipe();
        bumped.version += 1;
        assert_ne!(hash(&bumped), base);

        let next = recipe_hash(&openemu_recipe(), &contents(), BUILDER_REVISION + 1, RomParams::default()).unwrap();
        assert_ne!(next, base);

        let mut repainted = TEST_WALLPAPER.to_vec();
        *repainted.last_mut().unwrap() ^= 1;
        let other = HashMap::from([(Source::Wallpaper, repainted)]);
        assert_ne!(recipe_hash(&openemu_recipe(), &other, BUILDER_REVISION, RomParams::default()).unwrap(), base);
    }

    #[test]
    fn a_missing_content_is_an_error_not_a_hash_of_nothing() {
        let error = recipe_hash(&openemu_recipe(), &HashMap::new(), BUILDER_REVISION, RomParams::default()).unwrap_err();
        assert!(error.0.contains("wallpaper.png is built from 'wallpaper'"), "{error}");
    }

    // ── validate_recipe refusals ────────────────────────────────────────────────────────────────

    fn refuses(mutate: impl FnOnce(&mut RomRecipe), message: &str) {
        let mut r = openemu_recipe();
        mutate(&mut r);
        let error = validate_recipe(&r).expect_err("expected a refusal").0;
        assert!(error.contains(message), "{error} should mention {message}");
    }

    #[test]
    fn a_relative_path_is_refused() {
        refuses(|r| r.debloat.product.push("app/Foo".into()), "not absolute");
        refuses(|r| r.files[0].path = "system/media/openemu".into(), "not absolute");
    }

    #[test]
    fn a_path_that_is_not_normalised_is_refused() {
        for p in ["/system/app/../priv-app/X", "/system/app//X", "/system/app/X/", "/system/./app/X"] {
            refuses(|r| r.debloat.system.push(p.into()), "not normalised");
        }
    }

    #[test]
    fn a_system_volume_path_outside_system_is_refused() {
        refuses(|r| r.debloat.system.push("/app/Calendar".into()), "outside /system/");
        refuses(|r| r.debloat.system.push("/system".into()), "outside /system/");
        refuses(|r| r.build_prop_path.system = "/build.prop".into(), "outside /system/");
    }

    #[test]
    fn a_system_path_on_another_volume_is_refused() {
        refuses(|r| r.debloat.product.push("/system/app/Calendar".into()), "mounted at its own root");
        refuses(|r| r.build_prop_path.vendor = "/system/build.prop".into(), "mounted at its own root");
    }

    #[test]
    fn a_debloat_path_that_is_also_a_file_path_is_refused() {
        refuses(|r| r.debloat.system.push("/system/media/openemu/wallpaper.png".into()), "both removed by debloat and created");
        refuses(|r| r.debloat.system.push("/system/media/openemu".into()), "both removed by debloat and created");
        refuses(|r| r.debloat.system.push("/system/media".into()), "both removed by debloat and created");
        refuses(|r| r.debloat.product.push("/build.prop".into()), "is rewritten, but debloat removes");
    }

    #[test]
    fn a_file_whose_parent_is_neither_a_stock_directory_nor_declared_first_is_refused() {
        refuses(|r| drop(r.files.remove(0)), "parent /system/media is neither");
        refuses(|r| r.files.reverse(), "parent /system/media/openemu is neither");
        refuses(|r| r.files[2].path = "/system/fonts/openemu.png".into(), "parent /system/fonts is neither");
        refuses(|r| r.files[0].kind = FileKind::File, "parent /system/media is neither");
    }

    #[test]
    fn duplicate_paths_are_refused() {
        refuses(|r| r.debloat.system.push(r.debloat.system[0].clone()), "listed twice");
        refuses(|r| r.files.push(r.files[1].clone()), "listed twice");
    }

    #[test]
    fn the_same_in_volume_path_on_two_different_volumes_is_not_a_duplicate() {
        let mut r = openemu_recipe();
        r.debloat.system_ext.push("/priv-app/Contacts".into());
        validate_recipe(&r).unwrap();
    }

    #[test]
    fn identity_values_that_would_break_a_fingerprint_are_refused() {
        refuses(|r| r.identity.as_mut().unwrap().brand = "open/emulator".into(), "identity.brand");
        refuses(|r| r.identity.as_mut().unwrap().name = "openemu:x86_64".into(), "identity.name");
        refuses(|r| r.identity.as_mut().unwrap().device = "open emu".into(), "identity.device");
        refuses(|r| r.identity.as_mut().unwrap().model = "One\nTwo".into(), "identity.model");
    }

    #[test]
    fn modes_with_type_bits_content_on_a_directory_and_a_missing_label_are_refused() {
        refuses(|r| r.files[1].mode = 0o100644, "not permission bits");
        refuses(|r| r.files[0].source = Some(Source::Wallpaper), "directory and cannot have content");
        refuses(|r| r.files[1].selinux = String::new(), "not an SELinux file label");
    }

    #[test]
    fn a_system_prop_that_cannot_be_written_as_a_line_is_refused() {
        refuses(|r| r.system_props.push(("ro.bad key".into(), "1".into())), "property name");
        refuses(|r| r.system_props[0].1 = "1\nro.debuggable=1".into(), "line break");
    }

    #[test]
    fn an_id_or_base_tag_that_could_not_be_a_directory_name_is_refused() {
        refuses(|r| r.id = "../escape".into(), "not a safe name");
        refuses(|r| r.id = "Has Space".into(), "not a safe name");
        refuses(|r| r.base_tag = "google apis".into(), "is not a safe name");
        refuses(|r| r.base_tag = r.id.clone(), "cannot be built from itself");
        refuses(|r| r.api_level = 3, "API level 3");
    }
}
