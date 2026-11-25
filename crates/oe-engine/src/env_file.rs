//! Reads the `KEY=value` files under `android/profiles/` and `android/devices/`.
//!
//! Those files were `source`d by bash in the WSL runtime. They stay the single source of truth:
//! one definition of what the `play` guest is, not two that can drift.
//!
//! This parses the subset they actually use (comments, blank lines, bare values, and single- or
//! double-quoted values) and nothing else. It is deliberately *not* a shell: no `$VAR` expansion,
//! no command substitution, no `export`. A file that wants any of that is a file that has outgrown
//! being data, and executing it would hand a config file the ability to run commands.

use std::collections::BTreeMap;
use std::path::Path;

use crate::{err, fail, Result};

/// Every assignment in the text, by key.
pub fn parse_env_file(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for raw in oe_formats::bytes::split_lines(text) {
        let line = oe_formats::bytes::js_trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        if eq == 0 {
            continue;
        }
        let key = oe_formats::bytes::js_trim(&line[..eq]);
        // Keys are identifiers. Anything else is a line this parser has misread, and guessing at
        // it would be worse than skipping it.
        if !is_identifier(key) {
            continue;
        }
        out.insert(key.to_owned(), unquote(oe_formats::bytes::js_trim(&line[eq + 1..])));
    }
    out
}

/// `^[A-Za-z_][A-Za-z0-9_]*$`
fn is_identifier(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Strips one matched pair of surrounding quotes.
///
/// A trailing comment is only stripped from an *unquoted* value: `DEVICE_MODEL="2201117TG"` must
/// keep everything inside its quotes, while `PROFILE_IMAGE_TAG=default  # the AOSP one` must not
/// carry the comment into the value.
fn unquote(value: &str) -> String {
    if value.len() >= 2 {
        let (first, last) = (value.as_bytes()[0], value.as_bytes()[value.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_owned();
        }
    }
    match value.find(" #") {
        Some(hash) => value[..hash].trim_end_matches(oe_formats::bytes::js_is_space).to_owned(),
        None => value.to_owned(),
    }
}

/// Names come from the UI and end up in a filesystem path, so they are matched, not trusted.
pub fn is_safe_config_name(name: &str) -> bool {
    (1..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestProfile {
    pub name: String,
    pub description: String,
    /// `system-images;android-30;google_apis_playstore;x86_64`
    pub system_image: String,
    /// `default` | `google_apis` | `google_apis_playstore` | `openemu` | `openemu-compat`
    pub image_tag: String,
    /// The Android API level of the image, and of its base when it is derived: the one number
    /// every SDK path, package and AVD target is built from. 30 when the file does not say, which
    /// is what every profile was before there was a second.
    pub api_level: u32,
    /// Guest RAM this image needs, in MB, or `None` to let the host tuning decide. A hint for
    /// images the measured default is too small for, not a preference.
    pub ram_mb: Option<u32>,
    /// The stock image this one is built from, or `None` when the image is downloaded as-is.
    ///
    /// A derived image is not in Google's repository: setup fetches the base and runs the ROM
    /// builder, and the result is installed under `image_tag`.
    pub base_image_tag: Option<String>,
    pub play_store: bool,
    pub avd_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub name: String,
    /// `ro.product.*` and `ro.build.*` overrides, in file-field order. Empty entries are dropped,
    /// not sent as blanks.
    pub props: Vec<(String, String)>,
    pub lcd_width: Option<u32>,
    pub lcd_height: Option<u32>,
    pub lcd_density: Option<u32>,
}

impl DeviceIdentity {
    pub fn prop(&self, key: &str) -> Option<&str> {
        self.props.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

fn read(file: &Path) -> std::io::Result<BTreeMap<String, String>> {
    Ok(parse_env_file(&std::fs::read_to_string(file)?))
}

fn non_empty(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    env.get(key).filter(|v| !v.is_empty()).cloned()
}

/// `android/profiles/<name>.env`.
///
/// Fails rather than falling back to a default. Silently running the wrong guest is how someone
/// ends up staring at an AOSP image wondering where the Play Store went, and worse, how a
/// snapshot taken against one image gets loaded against another.
pub fn load_profile(android_root: &Path, name: &str) -> Result<GuestProfile> {
    if !is_safe_config_name(name) {
        fail!("unsafe profile name: {name}");
    }
    let file = android_root.join("profiles").join(format!("{name}.env"));
    let env = read(&file).map_err(|_| err!("unknown profile '{name}' (expected {})", file.display()))?;

    let (Some(system_image), Some(image_tag)) = (non_empty(&env, "PROFILE_SYSTEM_IMAGE"), non_empty(&env, "PROFILE_IMAGE_TAG")) else {
        fail!("profile '{name}' is missing its system image");
    };

    Ok(GuestProfile {
        name: non_empty(&env, "PROFILE_NAME").unwrap_or_else(|| name.to_owned()),
        description: env.get("PROFILE_DESC").cloned().unwrap_or_default(),
        system_image,
        image_tag,
        api_level: int_field(&env, "PROFILE_API_LEVEL", name, 21, 99)?.unwrap_or(30),
        ram_mb: int_field(&env, "PROFILE_RAM_MB", name, 1024, 16_384)?,
        base_image_tag: non_empty(&env, "PROFILE_BASE_IMAGE_TAG").filter(|tag| is_safe_config_name(tag)),
        play_store: env.get("PROFILE_PLAYSTORE").map(String::as_str) == Some("true"),
        avd_name: non_empty(&env, "PROFILE_AVD_NAME").unwrap_or_else(|| "OpenEmulator_API30".into()),
    })
}

/// A whole number within bounds, or `None` when the key is absent or empty.
///
/// A value that is present but wrong fails, for the reason `load_profile` does:
/// `PROFILE_API_LEVEL=3O` read as "not set" would quietly point the guest at the API 30 image of
/// another profile.
fn int_field(env: &BTreeMap<String, String>, key: &str, profile: &str, min: u32, max: u32) -> Result<Option<u32>> {
    let Some(raw) = env.get(key).filter(|v| !v.is_empty()) else { return Ok(None) };
    let value = raw.bytes().all(|b| b.is_ascii_digit()).then(|| raw.parse::<u32>().ok()).flatten();
    match value {
        Some(value) if (min..=max).contains(&value) => Ok(Some(value)),
        _ => fail!("profile '{profile}': {key}={raw} is not a whole number from {min} to {max}"),
    }
}

/// The `ro.product.*` keys a device file sets, paired with the file's field names.
const DEVICE_PROPS: [(&str, &str); 9] = [
    ("ro.product.brand", "DEVICE_BRAND"),
    ("ro.product.manufacturer", "DEVICE_MANUFACTURER"),
    ("ro.product.model", "DEVICE_MODEL"),
    ("ro.product.name", "DEVICE_PRODUCT"),
    ("ro.product.device", "DEVICE_DEVICE"),
    ("ro.build.fingerprint", "DEVICE_FINGERPRINT"),
    ("ro.build.id", "DEVICE_BUILD_ID"),
    ("ro.build.tags", "DEVICE_BUILD_TAGS"),
    ("ro.build.type", "DEVICE_BUILD_TYPE"),
];

/// `android/devices/<name>.env`.
///
/// Empty fields are skipped rather than passed as blanks, which is what makes `generic` add no
/// overrides at all. Passing `ro.product.brand=` would not be "no opinion", it would be an opinion
/// that the brand is the empty string.
pub fn load_device(android_root: &Path, name: &str) -> Result<DeviceIdentity> {
    if !is_safe_config_name(name) {
        fail!("unsafe device name: {name}");
    }
    let file = android_root.join("devices").join(format!("{name}.env"));
    let env = read(&file).map_err(|_| err!("unknown device '{name}' (expected {})", file.display()))?;

    let props = DEVICE_PROPS
        .iter()
        .filter_map(|(prop, field)| non_empty(&env, field).map(|value| ((*prop).to_owned(), value)))
        .collect();

    // `parseInt`: leading digits count, anything after them is ignored; zero is no value.
    let number = |key: &str| -> Option<u32> {
        let raw = env.get(key)?.trim_start();
        let digits: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok().filter(|&n: &u32| n > 0)
    };

    Ok(DeviceIdentity {
        name: non_empty(&env, "DEVICE_NAME").unwrap_or_else(|| name.to_owned()),
        props,
        lcd_width: number("DEVICE_LCD_WIDTH"),
        lcd_height: number("DEVICE_LCD_HEIGHT"),
        lcd_density: number("DEVICE_LCD_DENSITY"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // The real files, not fixtures. These are the definitions the product ships, so a change to
    // them that this parser cannot read should fail here rather than at runtime.
    fn android_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../android")
    }

    fn get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
        env.get(key).map(String::as_str)
    }

    #[test]
    fn comments_blanks_and_bare_values() {
        let env = parse_env_file("# a comment\n\nA=1\n  B=two  \n# another");
        assert_eq!(env, BTreeMap::from([("A".into(), "1".into()), ("B".into(), "two".into())]));
    }

    #[test]
    fn quotes_are_stripped_and_a_value_keeps_what_is_inside_them() {
        let env = parse_env_file("A=\"a value\"\nB='single'\nC=\"with # hash\"");
        assert_eq!(get(&env, "A"), Some("a value"));
        assert_eq!(get(&env, "B"), Some("single"));
        assert_eq!(get(&env, "C"), Some("with # hash"), "a hash inside quotes is content, not a comment");
    }

    #[test]
    fn a_trailing_comment_is_stripped_only_from_an_unquoted_value() {
        let env = parse_env_file("A=plain # trailing\nB=\"quoted # kept\"");
        assert_eq!(get(&env, "A"), Some("plain"));
        assert_eq!(get(&env, "B"), Some("quoted # kept"));
    }

    #[test]
    fn an_empty_value_is_kept_because_empty_means_no_override() {
        assert_eq!(get(&parse_env_file("DEVICE_BRAND="), "DEVICE_BRAND"), Some(""));
    }

    #[test]
    fn nothing_is_expanded_this_is_data_not_a_shell() {
        let env = parse_env_file("A=$HOME\nB=`whoami`\nC=$(id -u)");
        assert_eq!(get(&env, "A"), Some("$HOME"));
        assert_eq!(get(&env, "B"), Some("`whoami`"));
        assert_eq!(get(&env, "C"), Some("$(id -u)"));
    }

    #[test]
    fn a_line_that_is_not_an_assignment_is_skipped_rather_than_guessed_at() {
        let env = parse_env_file("export A=1\nnot a line\n=novalue\nB=2");
        assert_eq!(get(&env, "B"), Some("2"));
        assert_eq!(get(&env, "A"), None, "`export A=1` is a shell statement, not data");
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn config_names_are_matched_not_trusted() {
        assert!(is_safe_config_name("play"));
        assert!(is_safe_config_name("pixel_5"));
        assert!(!is_safe_config_name("../../etc/passwd"));
        assert!(!is_safe_config_name("a/b"));
        assert!(!is_safe_config_name(""));
        assert!(!is_safe_config_name("Play"), "uppercase is not a filename this project uses");
    }

    #[test]
    fn every_shipped_profile_loads_and_play_is_the_only_one_with_the_play_store() {
        for name in ["openemu", "fast", "full", "play"] {
            let profile = load_profile(&android_root(), name).unwrap();
            assert!(profile.system_image.starts_with("system-images;android-30;"), "{name}");
            assert!(!profile.image_tag.is_empty() && !profile.avd_name.is_empty(), "{name}");
        }
        assert!(load_profile(&android_root(), "play").unwrap().play_store);
        for name in ["fast", "full", "openemu"] {
            assert!(!load_profile(&android_root(), name).unwrap().play_store, "{name}");
        }
    }

    #[test]
    fn openemu_is_derived_from_the_aosp_image_not_downloaded_from_google() {
        let profile = load_profile(&android_root(), "openemu").unwrap();
        assert_eq!(profile.image_tag, "openemu");
        assert_eq!(profile.base_image_tag.as_deref(), Some("default"));
        assert_eq!(load_profile(&android_root(), "fast").unwrap().base_image_tag, None);
    }

    #[test]
    fn each_profile_gets_its_own_avd() {
        let names: Vec<String> =
            ["openemu", "fast", "full", "play"].iter().map(|n| load_profile(&android_root(), n).unwrap().avd_name).collect();
        let unique: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "AVD names collide: {names:?}");
    }

    #[test]
    fn an_unknown_profile_is_refused_rather_than_silently_defaulted() {
        assert!(load_profile(&android_root(), "nope").unwrap_err().0.contains("unknown profile"));
        assert!(load_profile(&android_root(), "../../evil").unwrap_err().0.contains("unsafe profile name"));
    }

    #[test]
    fn the_generic_device_contributes_no_property_overrides_at_all() {
        let device = load_device(&android_root(), "generic").unwrap();
        assert!(device.props.is_empty(), "an empty field means no opinion, not an empty brand");
        assert_eq!(device.lcd_width, Some(720));
    }

    #[test]
    fn a_real_handset_sets_the_identity_apps_check() {
        let pixel = load_device(&android_root(), "pixel_5").unwrap();
        assert_eq!(pixel.prop("ro.product.manufacturer"), Some("Google"));
        assert_eq!(pixel.prop("ro.product.model"), Some("Pixel 5"));
        assert!(pixel.prop("ro.build.fingerprint").unwrap().starts_with("google/redfin/redfin:11/"));
        assert_eq!((pixel.lcd_width, pixel.lcd_height, pixel.lcd_density), (Some(1080), Some(2340), Some(440)));
    }

    fn with_profile(lines: &[&str], check: impl FnOnce(&Path)) {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("profiles")).unwrap();
        let mut body = vec!["PROFILE_SYSTEM_IMAGE=\"system-images;android-30;default;x86_64\"", "PROFILE_IMAGE_TAG=default"];
        body.extend_from_slice(lines);
        std::fs::write(root.path().join("profiles").join("x.env"), body.join("\n")).unwrap();
        check(root.path());
    }

    #[test]
    fn a_profile_that_does_not_state_its_api_level_is_api_30_with_no_ram_hint() {
        with_profile(&[], |root| {
            let profile = load_profile(root, "x").unwrap();
            assert_eq!(profile.api_level, 30);
            assert_eq!(profile.ram_mb, None);
        });
        with_profile(&["PROFILE_API_LEVEL=", "PROFILE_RAM_MB="], |root| {
            let profile = load_profile(root, "x").unwrap();
            assert_eq!(profile.api_level, 30, "empty means not set");
            assert_eq!(profile.ram_mb, None);
        });
    }

    #[test]
    fn a_stated_api_level_and_ram_hint_are_read_as_numbers() {
        with_profile(&["PROFILE_API_LEVEL=34", "PROFILE_RAM_MB=4096"], |root| {
            let profile = load_profile(root, "x").unwrap();
            assert_eq!(profile.api_level, 34);
            assert_eq!(profile.ram_mb, Some(4096));
        });
    }

    #[test]
    fn an_api_level_or_ram_hint_that_is_present_but_wrong_is_refused_not_defaulted() {
        for line in ["PROFILE_API_LEVEL=3O", "PROFILE_API_LEVEL=20", "PROFILE_API_LEVEL=100", "PROFILE_API_LEVEL=34.5", "PROFILE_API_LEVEL=-34"] {
            with_profile(&[line], |root| {
                let error = load_profile(root, "x").unwrap_err().0;
                assert!(error.contains("is not a whole number from 21 to 99"), "{line}: {error}");
            });
        }
        for line in ["PROFILE_RAM_MB=lots", "PROFILE_RAM_MB=512", "PROFILE_RAM_MB=32768"] {
            with_profile(&[line], |root| {
                let error = load_profile(root, "x").unwrap_err().0;
                assert!(error.contains("is not a whole number from 1024 to 16384"), "{line}: {error}");
            });
        }
    }

    #[test]
    fn openemu_compat_is_an_api_34_rom_built_from_google_apis_with_its_own_avd_and_a_ram_hint() {
        let compat = load_profile(&android_root(), "openemu-compat").unwrap();
        assert_eq!(compat.image_tag, "openemu-compat");
        assert_eq!(compat.base_image_tag.as_deref(), Some("google_apis"));
        assert_eq!(compat.api_level, 34);
        assert_eq!(compat.ram_mb, Some(4096));
        assert!(!compat.play_store);
        assert!(compat.system_image.starts_with("system-images;android-34;"));
        for name in ["openemu", "fast", "full", "play"] {
            let profile = load_profile(&android_root(), name).unwrap();
            assert_eq!(profile.api_level, 30, "{name}");
            assert_eq!(profile.ram_mb, None, "{name} takes the measured default");
            assert_ne!(profile.avd_name, compat.avd_name, "its snapshot must never load against another image");
        }
    }
}
