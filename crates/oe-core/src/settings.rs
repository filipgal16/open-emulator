//! Everything the user can change, kept in `settings.json` in the same shape the Electron app wrote.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use oe_engine::sdk::dependencies::size_of;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    #[default]
    System,
    Light,
    Dark,
}

/// The device identities a guest can report as — the file names in `android/devices/`.
///
/// Not cosmetic: stock images identify as brand "Android", model "mainline", and plenty of apps
/// treat that as an emulator and refuse to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum DeviceId {
    #[default]
    #[serde(rename = "generic")]
    Generic,
    #[serde(rename = "pixel_5")]
    Pixel5,
    #[serde(rename = "redmi_note_11")]
    RedmiNote11,
}

impl DeviceId {
    pub const ALL: [DeviceId; 3] = [DeviceId::Generic, DeviceId::Pixel5, DeviceId::RedmiNote11];

    pub fn id(self) -> &'static str {
        match self {
            DeviceId::Generic => "generic",
            DeviceId::Pixel5 => "pixel_5",
            DeviceId::RedmiNote11 => "redmi_note_11",
        }
    }

    pub fn parse(value: &str) -> Option<DeviceId> {
        DeviceId::ALL.into_iter().find(|device| device.id() == value)
    }

    pub fn label(self) -> &'static str {
        match self {
            DeviceId::Generic => "Default",
            DeviceId::Pixel5 => "Pixel 5",
            DeviceId::RedmiNote11 => "Redmi Note 11",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            DeviceId::Generic => "Reports whatever the Android image says. The honest option.",
            DeviceId::Pixel5 => "Reports as a Google Pixel 5. Helps with apps that refuse to run on an emulator.",
            DeviceId::RedmiNote11 => "Reports as a Xiaomi handset. Some games gate features on the manufacturer.",
        }
    }
}

/// `cores` and `ram_mb` are `None` by default, meaning "decide from this machine". `density` is
/// how large Android draws everything; `None` keeps the device's own. There is no resolution
/// setting on purpose: the display follows the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: ThemeChoice,
    /// Where the SDK and system images are downloaded. `None` is the default under %LOCALAPPDATA%.
    pub download_root: Option<PathBuf>,
    pub device: DeviceId,
    pub cores: Option<u32>,
    pub ram_mb: Option<u32>,
    pub density: Option<u32>,
}

/// The ranges the controls offer. A hand-edited file is clamped to a little more, not refused.
pub const RAM_MIN_MB: u32 = 2048;
pub const RAM_MAX_MB: u32 = 16_384;
pub const RAM_STEP_MB: u32 = 512;
/// Windows keeps this much for itself however the slider is set.
pub const RAM_HOST_RESERVE_MB: u32 = 2048;
/// Android's own density buckets run from 160 (large tablets) to 480 (small, sharp phones).
pub const DENSITY_MIN: u32 = 160;
pub const DENSITY_MAX: u32 = 480;
pub const DENSITY_STEP: u32 = 40;

fn clamp_number(value: Option<&Value>, min: u32, max: u32) -> Option<u32> {
    let parsed = match value? {
        Value::Null => return None,
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let digits: String = text.trim().chars().enumerate().take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && *c == '-')).map(|(_, c)| c).collect();
            digits.parse::<f64>().ok()?
        }
        _ => return None,
    };
    parsed.is_finite().then(|| oe_formats::js_round(parsed).clamp(f64::from(min), f64::from(max)) as u32)
}

fn sanitize_root(value: Option<&Value>) -> Option<PathBuf> {
    let trimmed = value?.as_str()?.trim();
    let path = Path::new(trimmed);
    (!trimmed.is_empty() && (path.is_absolute() || path.has_root())).then(|| path.components().collect())
}

/// Reads whatever is on disk into valid settings: a bad value falls back rather than being kept.
pub fn sanitize(raw: &Value) -> Settings {
    let field = |name: &str| raw.get(name);
    Settings {
        theme: field("theme").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default(),
        download_root: sanitize_root(field("downloadRoot")),
        device: field("device").and_then(Value::as_str).and_then(DeviceId::parse).unwrap_or_default(),
        cores: clamp_number(field("cores"), 1, 32),
        ram_mb: clamp_number(field("ramMb"), 1024, 16_384),
        density: clamp_number(field("density"), 120, 640),
    }
}

pub struct SettingsStore {
    file: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    pub fn new(file: impl Into<PathBuf>) -> SettingsStore {
        let file = file.into();
        let current = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .map(|raw| sanitize(&raw))
            .unwrap_or_default();
        SettingsStore { file, current: Mutex::new(current) }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Applies a change, re-checks every value, and saves. A failed write keeps the change for this
    /// session rather than losing it.
    pub fn update(&self, change: impl FnOnce(&mut Settings)) -> Settings {
        let mut settings = self.get();
        change(&mut settings);
        let settings = sanitize(&serde_json::to_value(&settings).unwrap_or(Value::Null));
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = settings.clone();
        if let Ok(text) = serde_json::to_string_pretty(&settings) {
            if let Some(dir) = self.file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = self.file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &self.file);
            }
        }
        settings
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveResult {
    pub ok: bool,
    /// What happened, in a sentence the UI can show directly.
    pub message: String,
    pub moved_bytes: u64,
}

fn move_bytes_text(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else if value >= MB {
        format!("{} MB", oe_formats::js_round(value / MB))
    } else {
        format!("{} KB", oe_formats::js_round(value / 1024.0).max(1.0))
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Moves the download folder: a rename where it can, a copy across drives where it cannot. Refuses
/// a destination that already holds files rather than mixing two trees.
pub fn move_download_root(from: &Path, to: &Path) -> MoveResult {
    let done = |ok: bool, message: String, moved_bytes: u64| MoveResult { ok, message, moved_bytes };
    if std::path::absolute(from).ok() == std::path::absolute(to).ok() {
        return done(true, "That is already the current location.".into(), 0);
    }
    if !from.exists() {
        return done(true, "Nothing had been downloaded yet, so there was nothing to move.".into(), 0);
    }
    let bytes = size_of(from);
    if std::fs::read_dir(to).is_ok_and(|mut entries| entries.next().is_some()) {
        return done(false, format!("{} already contains files. Choose an empty folder.", to.display()), 0);
    }
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // An empty destination folder would make the rename fail; it is replaced, not merged into.
    let _ = std::fs::remove_dir(to);
    match std::fs::rename(from, to) {
        Ok(()) => return done(true, format!("Moved {} to {}.", move_bytes_text(bytes), to.display()), bytes),
        // ERROR_NOT_SAME_DEVICE: another drive, which only a copy crosses.
        Err(error) if error.raw_os_error() != Some(17) && error.raw_os_error() != Some(18) => {
            return done(false, format!("Could not move the files: {error}"), 0);
        }
        Err(_) => {}
    }
    match copy_dir_all(from, to).and_then(|()| std::fs::remove_dir_all(from)) {
        Ok(()) => done(true, format!("Copied {} to {}.", move_bytes_text(bytes), to.display()), bytes),
        Err(error) => done(false, format!("Could not copy the files: {error}"), 0),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StorageUsage {
    /// Where the runtime keeps the SDK, images, and per-guest state.
    pub root: PathBuf,
    pub total_bytes: u64,
    /// Archives and scratch that freeing space would remove.
    pub reclaimable_bytes: u64,
}

pub fn storage_usage(root: &Path, reclaimable: &[PathBuf]) -> StorageUsage {
    StorageUsage {
        root: root.to_owned(),
        total_bytes: size_of(root),
        reclaimable_bytes: reclaimable.iter().map(|path| size_of(path)).sum(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_missing_or_broken_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(SettingsStore::new(dir.path().join("settings.json")).get(), Settings::default());
        std::fs::write(dir.path().join("broken.json"), "{not json").unwrap();
        assert_eq!(SettingsStore::new(dir.path().join("broken.json")).get(), Settings::default());
    }

    #[test]
    fn out_of_range_values_are_clamped_and_unknown_ones_fall_back() {
        let settings = sanitize(&json!({
            "theme": "purple", "device": "pixel_5", "cores": 99, "ramMb": "3000", "density": 12.6, "downloadRoot": "relative\\path"
        }));
        assert_eq!(settings.theme, ThemeChoice::System);
        assert_eq!(settings.device, DeviceId::Pixel5);
        assert_eq!(settings.cores, Some(32));
        assert_eq!(settings.ram_mb, Some(3000));
        assert_eq!(settings.density, Some(120));
        assert_eq!(settings.download_root, None, "only an absolute folder is a place to download to");
    }

    #[test]
    fn changes_are_saved_in_the_electron_apps_shape_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let store = SettingsStore::new(&file);
        store.update(|settings| {
            settings.theme = ThemeChoice::Dark;
            settings.cores = Some(4);
            settings.download_root = Some(PathBuf::from(r"D:\Android"));
        });
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"theme\": \"dark\"") && text.contains("\"ramMb\": null") && text.contains("\"device\": \"generic\""), "{text}");
        let reread = SettingsStore::new(&file).get();
        assert_eq!((reread.theme, reread.cores), (ThemeChoice::Dark, Some(4)));
    }

    #[test]
    fn moving_the_download_folder_refuses_a_full_destination_and_moves_into_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old");
        std::fs::create_dir_all(from.join("sdk")).unwrap();
        std::fs::write(from.join("sdk").join("a.bin"), vec![0u8; 2048]).unwrap();
        let full = dir.path().join("full");
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("x"), "x").unwrap();
        assert!(!move_download_root(&from, &full).ok);

        let to = dir.path().join("new");
        std::fs::create_dir_all(&to).unwrap();
        let moved = move_download_root(&from, &to);
        assert!(moved.ok, "{}", moved.message);
        assert_eq!(moved.moved_bytes, 2048);
        assert!(to.join("sdk").join("a.bin").exists() && !from.exists());
        assert!(move_download_root(&dir.path().join("never"), &dir.path().join("x")).message.contains("nothing to move"));
    }
}
