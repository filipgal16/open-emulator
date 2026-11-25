//! Edits Android `build.prop` files as text, changing only the values it is asked to.
//!
//! The image's identity (what Settings → About, `Build.MODEL` and the fingerprint report) lives
//! in the four stock `build.prop`s (system, system_ext, product, vendor). The line rules here
//! follow the parser that reads them, `LoadProperties` in AOSP's `init/property_service.cpp`: a
//! line is `key=value` with whitespace trimmed around both, `#` starts a comment only at the start
//! of a line, and `import <file>` lines pull in other files.
//!
//! **Identity is rewritten in place, never appended.** Which of two definitions of a key wins
//! depends on who reads it: API 30's init loads every file into one map and lets the later one
//! override (logging "Overriding previous 'ro.' property"), older init and anything that reads the
//! file itself (`/system/build.prop` is world-readable) take the first. An appended line leaves
//! two answers and the stock identity still in plain sight; rewriting every occurrence leaves one.
//!
//! Everything this module does not rewrite stays byte-identical: comments, blank lines, order, line
//! endings, and whether the file ends in a newline. A rewritten line keeps its key and the
//! whitespace around its value; only the value between them changes.

use crate::bytes::{js_is_space, json_quote};
use crate::{fail, Result};

// ── Identity ────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RomIdentity {
    /// `ro.product[.<p>].brand`, and the first part of every fingerprint.
    pub brand: String,
    pub manufacturer: String,
    /// `ro.product[.<p>].model`: the name Settings → About shows.
    pub model: String,
    /// `ro.product[.<p>].name`, and the second part of every fingerprint.
    pub name: String,
    /// `ro.product[.<p>].device`, and the third part of every fingerprint.
    pub device: String,
    /// `ro.build.display.id`: the build number line in About.
    pub display_id: String,
    /// `ro.build.description`.
    pub description: String,
    /// `ro.build.product`.
    pub build_product: String,
}

impl RomIdentity {
    /// Every field with the name the TypeScript builder used for it, which is the name error
    /// messages and recipes use.
    fn fields(&self) -> [(&'static str, &str); 8] {
        [
            ("brand", &self.brand),
            ("manufacturer", &self.manufacturer),
            ("model", &self.model),
            ("name", &self.name),
            ("device", &self.device),
            ("displayId", &self.display_id),
            ("description", &self.description),
            ("buildProduct", &self.build_product),
        ]
    }

    fn product_field(&self, field: &str) -> Option<&str> {
        match field {
            "brand" => Some(&self.brand),
            "manufacturer" => Some(&self.manufacturer),
            "model" => Some(&self.model),
            "name" => Some(&self.name),
            "device" => Some(&self.device),
            _ => None,
        }
    }
}

const PARTITIONS: [&str; 6] = ["system", "system_ext", "product", "vendor", "odm", "bootimage"];

/// `ro.product.<field>` and `ro.product.<partition>.<field>` for the five identity fields.
///
/// Deliberately closed on both sides: `ro.product.cpu.abi`, `ro.product.build.date`,
/// `ro.product.board`, `ro.product.first_api_level`, `ro.product.vndk.version` and the rest share
/// the prefix, and rewriting any of them would change what the image *is*, not what it is called:
/// a wrong ABI list is an image that refuses every app.
fn product_key_field(key: &str) -> Option<&str> {
    let rest = key.strip_prefix("ro.product.")?;
    let field = match rest.split_once('.') {
        Some((partition, field)) if PARTITIONS.contains(&partition) => field,
        Some(_) => return None,
        None => rest,
    };
    matches!(field, "brand" | "manufacturer" | "model" | "name" | "device").then_some(field)
}

/// `ro.build.fingerprint` and `ro.<partition>.build.fingerprint`, including `product` and
/// `bootimage`.
fn is_fingerprint_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("ro.") else { return false };
    if rest == "build.fingerprint" {
        return true;
    }
    match rest.strip_suffix(".build.fingerprint") {
        Some(partition) => PARTITIONS.contains(&partition),
        None => false,
    }
}

/// `brand/name/device:release/id/incremental:type/tags`, every part non-empty and free of
/// whitespace.
fn is_fingerprint(value: &str) -> bool {
    const SEPARATORS: [char; 7] = ['/', '/', ':', '/', '/', ':', '/'];
    let mut separators = Vec::new();
    let mut parts = vec![String::new()];
    for c in value.chars() {
        if c == '/' || c == ':' {
            separators.push(c);
            parts.push(String::new());
        } else {
            parts.last_mut().unwrap().push(c);
        }
    }
    separators == SEPARATORS && parts.iter().all(|part| !part.is_empty() && !part.chars().any(js_is_space))
}

/// What [`rewrite_identity`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewritten {
    pub text: String,
    /// Each key whose value changed, once, in file order, so a second run reports nothing.
    pub changed: Vec<String>,
}

/// Rewrites every identity key the file defines, every occurrence, and appends nothing: a key the
/// file does not have is left for the files that do (init derives the unsuffixed `ro.product.*`
/// and `ro.build.fingerprint` from them).
///
/// A fingerprint keeps everything from its first `:` onward: release, build id, incremental, type and
/// tags stay true to the build underneath; only `brand/name/device` becomes ours.
pub fn rewrite_identity(text: &str, identity: &RomIdentity) -> Result<Rewritten> {
    check_identity(identity)?;
    let result = rewrite_values(text, |key, value| identity_value(key, value, identity))?;
    Ok(Rewritten { text: result.text, changed: result.changed })
}

fn identity_value(key: &str, value: &str, identity: &RomIdentity) -> Result<Option<String>> {
    if let Some(field) = product_key_field(key) {
        return Ok(identity.product_field(field).map(str::to_owned));
    }
    if is_fingerprint_key(key) {
        // A value that is not a fingerprint means this is not the file we measured. Splicing an
        // identity into it anyway would ship a fingerprint nobody can parse, so the build stops.
        if !is_fingerprint(value) {
            fail!("{key}={value} is not a brand/name/device:release/id/incremental:type/tags fingerprint");
        }
        let tail = &value[value.find(':').expect("a fingerprint has a ':'")..];
        return Ok(Some(format!("{}/{}/{}{tail}", identity.brand, identity.name, identity.device)));
    }
    Ok(match key {
        "ro.build.display.id" => Some(identity.display_id.clone()),
        "ro.build.description" => Some(identity.description.clone()),
        "ro.build.product" => Some(identity.build_product.clone()),
        "ro.build.flavor" => {
            // `<product name>-<build type>`: the name is ours, the build type stays what it is.
            match value.rfind('-') {
                Some(dash) if dash > 0 => Some(format!("{}{}", identity.name, &value[dash..])),
                _ => None,
            }
        }
        _ => None,
    })
}

/// Fails unless every identity value can be written as a property, and brand, name and device can
/// sit in a fingerprint: a `/`, `:` or space in one of those shifts every part after it, and
/// anything that splits the fingerprint (attestation, Play's device checks, crash reporters)
/// reads a different release or build id than the image has.
pub fn check_identity(identity: &RomIdentity) -> Result<()> {
    for (field, value) in identity.fields() {
        if value.is_empty() {
            fail!("identity.{field} is empty");
        }
        check_value(&format!("identity.{field}"), value)?;
    }
    for (field, value) in [("brand", &identity.brand), ("name", &identity.name), ("device", &identity.device)] {
        if value.chars().any(|c| c == '/' || c == ':' || js_is_space(c)) {
            fail!(
                "identity.{field} {} contains '/', ':' or whitespace, which would break the fingerprint",
                json_quote(value)
            );
        }
    }
    Ok(())
}

// ── Other properties ────────────────────────────────────────────────────────────────────────────

/// Sets each property: every existing occurrence has its value replaced in place, and a key the
/// file lacks is appended as `key=value` at the end, in the order given.
///
/// Upsert rather than append because appending a key the file already has does nothing a reader
/// can rely on (see the module comment). An appended line always ends in a newline, and a file that
/// did not end in one gets one before it; otherwise the new property is glued onto the last value.
/// When nothing is appended the text keeps whatever ending it had.
///
/// Every key and value is checked before anything is edited, so a refusal changes nothing.
pub fn upsert_props(text: &str, props: &[(&str, &str)]) -> Result<String> {
    // A key given twice keeps its first position and its last value, as an object literal would.
    let mut wanted: Vec<(&str, &str)> = Vec::new();
    for &(key, value) in props {
        match wanted.iter_mut().find(|(k, _)| *k == key) {
            Some(existing) => existing.1 = value,
            None => wanted.push((key, value)),
        }
    }
    for &(key, value) in &wanted {
        check_prop(key, value)?;
    }

    let result = rewrite_values(text, |key, _| {
        Ok(wanted.iter().find(|(k, _)| *k == key).map(|(_, v)| (*v).to_owned()))
    })?;
    let missing: Vec<&(&str, &str)> = wanted.iter().filter(|(key, _)| !result.matched.iter().any(|m| m == key)).collect();
    if missing.is_empty() {
        return Ok(result.text);
    }

    let mut out = result.text;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for (key, value) in missing {
        out.push_str(&format!("{key}={value}\n"));
    }
    Ok(out)
}

/// Fails unless `key=value` would be read back by init as exactly this key and this value.
///
/// A line break or NUL in the value ends the line (or the C string) early and turns the rest into
/// a line of its own; whitespace at either end is trimmed by init, so the property read back would
/// not be the one written. A key outside `[A-Za-z0-9._-]` is not one this module has any reason to
/// write, and an `=` or space in it would move where init splits the line.
pub fn check_prop(key: &str, value: &str) -> Result<()> {
    let valid_key = !key.is_empty()
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if !valid_key {
        fail!("property name {} is not [A-Za-z0-9._-]+", json_quote(key));
    }
    check_value(key, value)
}

fn check_value(what: &str, value: &str) -> Result<()> {
    if value.contains(['\n', '\r', '\0']) {
        fail!(
            "{what}: value {} contains a line break or NUL, which would split the line init reads",
            json_quote(value)
        );
    }
    let padding = |c: char| matches!(c, ' ' | '\t' | '\u{b}' | '\u{c}');
    if value.starts_with(padding) || value.ends_with(padding) {
        fail!("{what}: value {} starts or ends with whitespace, which init trims away", json_quote(value));
    }
    Ok(())
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

/// Properties in the order their keys first appear.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Props {
    entries: Vec<(String, String)>,
}

impl Props {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    fn set(&mut self, key: &str, value: &str) {
        match self.entries.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value.to_owned(),
            None => self.entries.push((key.to_owned(), value.to_owned())),
        }
    }
}

/// Every property the text defines, skipping comments, blank lines, `import` lines and lines
/// without `=`.
///
/// When a key is defined twice, the last definition wins: what API 30's init does, and so what
/// `getprop` reports (see the module comment).
pub fn parse_props(text: &str) -> Props {
    let mut out = Props::default();
    for line in text.split('\n') {
        if let Some(prop) = parse_line(line) {
            out.set(prop.key, &line[prop.value_start..prop.value_end]);
        }
    }
    out
}

// ── Lines ───────────────────────────────────────────────────────────────────────────────────────

struct PropLine<'a> {
    key: &'a str,
    /// The value's bounds in the line, whitespace excluded, so it can be replaced on its own.
    value_start: usize,
    value_end: usize,
}

/// C's `isspace`, which is what init trims with. `\r` is in it: a CRLF line reads the same as LF.
fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// The property a line defines, located the way init locates it, or `None` for any other line.
///
/// Every byte this looks at is ASCII, so the indices it returns are always char boundaries.
fn parse_line(line: &str) -> Option<PropLine<'_>> {
    let bytes = line.as_bytes();
    let mut start = 0;
    while start < bytes.len() && is_space(bytes[start]) {
        start += 1;
    }
    if start == bytes.len() || bytes[start] == b'#' {
        return None;
    }
    if line[start..].starts_with("import ") {
        return None;
    }

    let eq = start + line[start..].find('=')?;

    let mut key_end = eq;
    while key_end > start && is_space(bytes[key_end - 1]) {
        key_end -= 1;
    }
    if key_end == start {
        return None;
    }

    let mut value_end = bytes.len();
    while value_end > eq + 1 && is_space(bytes[value_end - 1]) {
        value_end -= 1;
    }
    let mut value_start = eq + 1;
    while value_start < value_end && is_space(bytes[value_start]) {
        value_start += 1;
    }

    Some(PropLine { key: &line[start..key_end], value_start, value_end })
}

struct Rewrite {
    text: String,
    matched: Vec<String>,
    changed: Vec<String>,
}

/// Offers every property line to `replace`; a returned string becomes the line's new value, and
/// `None` leaves the line alone.
///
/// Splits on `\n` only and rejoins with `\n`, so every line `replace` declines (and the file's
/// final newline, or its absence) comes back byte-for-byte.
fn rewrite_values(text: &str, mut replace: impl FnMut(&str, &str) -> Result<Option<String>>) -> Result<Rewrite> {
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let mut matched: Vec<String> = Vec::new();
    let mut changed: Vec<String> = Vec::new();

    for line in &mut lines {
        let Some(prop) = parse_line(line) else { continue };
        let key = prop.key.to_owned();
        let (value_start, value_end) = (prop.value_start, prop.value_end);

        let value = &line[value_start..value_end];
        let Some(next) = replace(&key, value)? else { continue };

        if !matched.contains(&key) {
            matched.push(key.clone());
        }
        if next == value {
            continue;
        }
        *line = format!("{}{next}{}", &line[..value_start], &line[value_end..]);
        if !changed.contains(&key) {
            changed.push(key);
        }
    }

    Ok(Rewrite { text: lines.join("\n"), matched, changed })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stock `build.prop`s from Google's `default` API 30 image, byte-exact.
    fn stock(volume: &str) -> String {
        let path = format!("{}/testdata/build.prop.{volume}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(path).unwrap()
    }

    fn identity() -> RomIdentity {
        RomIdentity {
            brand: "open-emulator".into(),
            manufacturer: "open-emulator".into(),
            model: "OpenEmulator One".into(),
            name: "openemu_x86_64".into(),
            device: "openemu".into(),
            display_id: "open-emulator Android 11 (openemu 1)".into(),
            description: "openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys".into(),
            build_product: "openemu".into(),
        }
    }

    const TAIL: &str = ":11/RSR1.210722.013.A2/10067904:userdebug/test-keys";

    fn fingerprint() -> String {
        format!("open-emulator/openemu_x86_64/openemu{TAIL}")
    }

    fn product_keys(p: &str) -> Vec<(String, String)> {
        vec![
            (format!("ro.product.{p}.brand"), "open-emulator".into()),
            (format!("ro.product.{p}.device"), "openemu".into()),
            (format!("ro.product.{p}.manufacturer"), "open-emulator".into()),
            (format!("ro.product.{p}.model"), "OpenEmulator One".into()),
            (format!("ro.product.{p}.name"), "openemu_x86_64".into()),
        ]
    }

    /// Every identity key each stock file has, in file order, with what it must read after the
    /// rewrite. Written out rather than derived from the module's own patterns, so a pattern that
    /// misses a key, or grabs one too many, fails here.
    fn expected(volume: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        match volume {
            "system" => {
                out.push(("ro.system.build.fingerprint".into(), fingerprint()));
                out.extend(product_keys("system"));
                out.push(("ro.build.display.id".into(), "open-emulator Android 11 (openemu 1)".into()));
                out.push(("ro.build.flavor".into(), "openemu_x86_64-userdebug".into()));
                out.push(("ro.build.product".into(), "openemu".into()));
                out.push((
                    "ro.build.description".into(),
                    "openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys".into(),
                ));
            }
            "system_ext" => {
                out.push(("ro.system_ext.build.fingerprint".into(), fingerprint()));
                out.extend(product_keys("system_ext"));
            }
            "product" => {
                out.push(("ro.product.build.fingerprint".into(), fingerprint()));
                out.extend(product_keys("product"));
            }
            "vendor" => {
                out.push(("ro.vendor.build.fingerprint".into(), fingerprint()));
                out.extend(product_keys("vendor"));
                out.push(("ro.bootimage.build.fingerprint".into(), fingerprint()));
            }
            _ => unreachable!(),
        }
        out
    }

    const VOLUMES: [&str; 4] = ["system", "system_ext", "product", "vendor"];

    /// Keys that share a prefix with identity keys and must come through untouched.
    const LOOKALIKES: [&str; 5] =
        ["ro.product.cpu.abilist", "ro.product.build.date", "ro.product.board", "ro.product.vndk.version", "ro.setupwizard.mode"];

    /// `^([^#=][^=]*)=`
    fn key_of(line: &str) -> Option<&str> {
        let first = line.chars().next()?;
        if first == '#' || first == '=' {
            return None;
        }
        line.find('=').map(|eq| &line[..eq])
    }

    #[test]
    fn every_identity_key_each_file_has_is_rewritten_and_nothing_else() {
        for volume in VOLUMES {
            let before = stock(volume);
            let Rewritten { text: after, changed } = rewrite_identity(&before, &identity()).unwrap();
            let expected = expected(volume);

            let keys: Vec<String> = expected.iter().map(|(k, _)| k.clone()).collect();
            assert_eq!(changed, keys, "{volume}: changed lists exactly the identity keys, in file order");

            let props = parse_props(&after);
            for (key, value) in &expected {
                assert_eq!(props.get(key), Some(value.as_str()), "{volume}: {key}");
            }

            let before_lines: Vec<&str> = before.split('\n').collect();
            let after_lines: Vec<&str> = after.split('\n').collect();
            assert_eq!(after_lines.len(), before_lines.len(), "{volume}: no line added or removed");
            for (i, (b, a)) in before_lines.iter().zip(&after_lines).enumerate() {
                match key_of(b) {
                    Some(key) if keys.iter().any(|k| k == key) => assert_eq!(key_of(a), Some(key), "line {} keeps its key", i + 1),
                    _ => assert_eq!(a, b, "{volume} line {} is not identity and must be byte-identical", i + 1),
                }
            }
            assert_eq!(after.ends_with('\n'), before.ends_with('\n'), "trailing newline status kept");
            assert!(!after.contains('\r'), "LF stays LF");
        }
    }

    #[test]
    fn fingerprints_keep_the_builds_own_tail() {
        for volume in VOLUMES {
            let before = parse_props(&stock(volume));
            let after = parse_props(&rewrite_identity(&stock(volume), &identity()).unwrap().text);
            let mut fingerprints = 0;
            for (key, value) in after.iter() {
                if !key.ends_with(".build.fingerprint") {
                    continue;
                }
                fingerprints += 1;
                assert!(before.get(key).unwrap().ends_with(TAIL), "{key} stock tail is what the fixture says");
                assert!(value.ends_with(TAIL), "{key} keeps release, id, incremental, type and tags");
                assert!(value.starts_with("open-emulator/openemu_x86_64/openemu:"), "{key} has our brand/name/device");
            }
            assert!(fingerprints >= 1, "every stock file has at least one fingerprint");
        }
    }

    #[test]
    fn a_second_rewrite_changes_nothing() {
        for volume in VOLUMES {
            let once = rewrite_identity(&stock(volume), &identity()).unwrap().text;
            let twice = rewrite_identity(&once, &identity()).unwrap();
            assert_eq!(twice.text, once);
            assert!(twice.changed.is_empty());
        }
    }

    #[test]
    fn keys_that_only_look_like_identity_keys_are_untouched_in_the_real_files() {
        let mut seen: Vec<&str> = Vec::new();
        for volume in VOLUMES {
            let before = parse_props(&stock(volume));
            let after = parse_props(&rewrite_identity(&stock(volume), &identity()).unwrap().text);
            for key in LOOKALIKES {
                if !before.contains_key(key) {
                    continue;
                }
                if !seen.contains(&key) {
                    seen.push(key);
                }
                assert_eq!(after.get(key), before.get(key), "{volume}: {key}");
            }
            // And the vendor's `ro.vendor.product.cpu.*`, which has `product` in the middle.
            for (key, value) in before.iter() {
                if key.starts_with("ro.vendor.product.") {
                    assert_eq!(after.get(key), Some(value), "{key}");
                }
            }
        }
        seen.sort();
        let mut all = LOOKALIKES.to_vec();
        all.sort();
        assert_eq!(seen, all, "each lookalike is really in one of the files");
    }

    #[test]
    fn the_stock_files_hold_the_values_this_test_assumes() {
        assert_eq!(parse_props(&stock("system")).get("ro.product.system.model"), Some("mainline"));
        assert_eq!(parse_props(&stock("vendor")).get("ro.product.vendor.model"), Some("Android SDK built for x86_64"));
        assert_eq!(parse_props(&stock("system_ext")).get("ro.setupwizard.mode"), Some("DISABLED"));
    }

    #[test]
    fn unsuffixed_and_odm_bootimage_product_keys_are_identity_too_other_ro_product_keys_are_not() {
        let text = [
            "ro.product.model=a",
            "ro.product.brand=a",
            "ro.product.odm.device=a",
            "ro.product.bootimage.name=a",
            "ro.build.fingerprint=Android/sdk/generic:11/X/1:user/release-keys",
            "ro.odm.build.fingerprint=Android/sdk/generic:11/X/1:user/release-keys",
            "ro.product.cpu.abi=x86_64",
            "ro.product.locale=en-US",
            "ro.product.first_api_level=30",
            "ro.product.model.for_attestation=a",
            "ro.product.systemx.model=a",
            "ro.product.build.date=today",
            "ro.system.build.display.id=a",
            "ro.build.fingerprint.extra=a",
            "",
        ]
        .join("\n");

        let Rewritten { text: out, changed } = rewrite_identity(&text, &identity()).unwrap();
        assert_eq!(
            changed,
            vec![
                "ro.product.model",
                "ro.product.brand",
                "ro.product.odm.device",
                "ro.product.bootimage.name",
                "ro.build.fingerprint",
                "ro.odm.build.fingerprint"
            ]
        );
        let props = parse_props(&out);
        assert_eq!(props.get("ro.build.fingerprint"), Some("open-emulator/openemu_x86_64/openemu:11/X/1:user/release-keys"));
        for key in ["ro.product.model.for_attestation", "ro.product.systemx.model", "ro.system.build.display.id", "ro.build.fingerprint.extra"] {
            assert_eq!(props.get(key), Some("a"), "{key} is not an identity key");
        }
        assert_eq!(props.get("ro.product.cpu.abi"), Some("x86_64"));
    }

    #[test]
    fn every_occurrence_of_an_identity_key_is_rewritten_and_a_comment_is_not_an_occurrence() {
        let text = "ro.product.model=first\n# ro.product.model=commented\nx=1\nro.product.model=second\n";
        let Rewritten { text: out, changed } = rewrite_identity(text, &identity()).unwrap();
        assert_eq!(out, "ro.product.model=OpenEmulator One\n# ro.product.model=commented\nx=1\nro.product.model=OpenEmulator One\n");
        assert_eq!(changed, vec!["ro.product.model"], "listed once");
    }

    #[test]
    fn a_rewritten_line_keeps_the_whitespace_and_line_ending_around_its_value() {
        let out = rewrite_identity("  ro.product.model =  old  \r\nro.product.brand=x", &identity()).unwrap();
        assert_eq!(out.text, "  ro.product.model =  OpenEmulator One  \r\nro.product.brand=open-emulator");
    }

    #[test]
    fn a_file_with_no_identity_keys_comes_back_identical() {
        let text = "# nothing\nfoo=bar";
        assert_eq!(rewrite_identity(text, &identity()).unwrap(), Rewritten { text: text.into(), changed: vec![] });
        assert_eq!(rewrite_identity("", &identity()).unwrap(), Rewritten { text: String::new(), changed: vec![] });
    }

    #[test]
    fn a_fingerprint_that_is_not_one_is_refused() {
        for bad in ["garbage", "a/b:11/X/1:user/keys", "a/b/c/d:11/X/1:user/keys", "a/b/c:11/X/1", ""] {
            let result = rewrite_identity(&format!("ro.vendor.build.fingerprint={bad}\n"), &identity());
            assert!(result.unwrap_err().to_string().contains("fingerprint"), "{bad:?}");
        }
    }

    #[test]
    fn identity_values_that_would_break_a_fingerprint_or_a_line_are_refused() {
        let cases: Vec<(Box<dyn Fn(&mut RomIdentity)>, &str)> = vec![
            (Box::new(|i| i.brand = "open/emulator".into()), "identity.brand"),
            (Box::new(|i| i.name = "openemu:x86_64".into()), "identity.name"),
            (Box::new(|i| i.device = "open emu".into()), "identity.device"),
            (Box::new(|i| i.model = "One\nro.debuggable=1".into()), "identity.model"),
            (Box::new(|i| i.display_id = "x\r".into()), "identity.displayId"),
            (Box::new(|i| i.description = "a\0b".into()), "identity.description"),
            (Box::new(|i| i.build_product = String::new()), "identity.buildProduct is empty"),
            (Box::new(|i| i.manufacturer = " padded".into()), "identity.manufacturer"),
        ];
        for (change, message) in cases {
            let mut bad = identity();
            change(&mut bad);
            assert!(check_identity(&bad).unwrap_err().to_string().contains(message), "{message}");
            assert!(rewrite_identity("ro.product.model=x\n", &bad).unwrap_err().to_string().contains(message));
        }
        // Spaces are fine where no fingerprint is built from the value.
        check_identity(&identity()).unwrap();
    }

    // ── upsert_props ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn upsert_replaces_a_present_key_in_place_and_appends_nothing() {
        assert_eq!(upsert_props("# head\na=1\nb=2\nc=3\n", &[("b", "two")]).unwrap(), "# head\na=1\nb=two\nc=3\n");
    }

    #[test]
    fn upsert_appends_an_absent_key_at_the_end_keeping_one_trailing_newline() {
        assert_eq!(upsert_props("a=1\n", &[("z", "26")]).unwrap(), "a=1\nz=26\n");
        assert_eq!(upsert_props("a=1", &[("z", "26")]).unwrap(), "a=1\nz=26\n", "a missing final newline is added");
        assert_eq!(upsert_props("", &[("z", "26")]).unwrap(), "z=26\n");
        assert_eq!(upsert_props("a=1\n\n", &[("z", "26")]).unwrap(), "a=1\n\nz=26\n", "a trailing blank line is kept");
    }

    #[test]
    fn upsert_replaces_every_occurrence_of_a_duplicated_key_and_appends_no_third() {
        assert_eq!(upsert_props("k=1\nx=0\nk=2\n", &[("k", "new")]).unwrap(), "k=new\nx=0\nk=new\n");
    }

    #[test]
    fn upsert_handles_present_and_absent_keys_together_appending_in_the_order_given() {
        assert_eq!(upsert_props("b=1\n", &[("c", "3"), ("b", "2"), ("a", "1")]).unwrap(), "b=2\nc=3\na=1\n");
    }

    #[test]
    fn upsert_with_nothing_to_append_keeps_the_ending_the_text_had() {
        assert_eq!(upsert_props("a=1", &[("a", "2")]).unwrap(), "a=2");
        assert_eq!(upsert_props("a=1\n", &[]).unwrap(), "a=1\n");
    }

    #[test]
    fn upsert_does_not_count_a_commented_out_key_as_present() {
        assert_eq!(upsert_props("# ro.x=old\n", &[("ro.x", "new")]).unwrap(), "# ro.x=old\nro.x=new\n");
    }

    #[test]
    fn upsert_allows_an_empty_value_as_stock_files_have() {
        assert_eq!(upsert_props("ro.board.platform=x\n", &[("ro.board.platform", "")]).unwrap(), "ro.board.platform=\n");
    }

    #[test]
    fn upsert_refuses_bad_keys_and_values() {
        for key in ["", "ro.a b", "ro.a=b", "ro/a", "ro.a\n", "ró.a"] {
            let error = upsert_props("a=1\n", &[("ok", "1"), (key, "v")]).unwrap_err().to_string();
            assert!(error.contains("property name"), "{key:?}");
        }
        for value in ["a\nb", "a\rb", "a\0b", "trailing\n", " leading", "trailing\t"] {
            assert!(upsert_props("a=1\n", &[("a", value)]).unwrap_err().to_string().contains("value"), "{value:?}");
            assert!(check_prop("a", value).unwrap_err().to_string().contains("value"));
        }
    }

    #[test]
    fn upsert_of_the_recipe_props_into_the_real_system_build_prop_only_appends_them() {
        let before = stock("system");
        let ours = [
            ("ro.openemu.rom", "1"),
            ("ro.openemu.rom.version", "1"),
            ("ro.config.wallpaper", "/system/media/openemu/wallpaper.png"),
        ];
        let after = upsert_props(&before, &ours).unwrap();

        assert!(after.starts_with(&before), "the stock text is untouched");
        assert_eq!(
            &after[before.len()..],
            "ro.openemu.rom=1\nro.openemu.rom.version=1\nro.config.wallpaper=/system/media/openemu/wallpaper.png\n"
        );
        assert_eq!(upsert_props(&after, &ours).unwrap(), after, "a second upsert is a no-op");
    }

    #[test]
    fn upserting_a_key_system_ext_already_has_with_the_same_value_changes_nothing() {
        let before = stock("system_ext");
        assert_eq!(upsert_props(&before, &[("ro.setupwizard.mode", "DISABLED")]).unwrap(), before);
    }

    // ── parse_props ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn parse_props_keeps_the_last_definition_of_a_key_as_api_30_init_does() {
        assert_eq!(parse_props("a=1\nb=x\na=2\n").get("a"), Some("2"));
    }

    #[test]
    fn ro_build_flavor_takes_our_product_name_and_keeps_the_build_type() {
        let Rewritten { text, changed } = rewrite_identity(&stock("system"), &identity()).unwrap();
        assert_eq!(parse_props(&text).get("ro.build.flavor"), Some("openemu_x86_64-userdebug"));
        assert!(changed.iter().any(|k| k == "ro.build.flavor"));
    }

    #[test]
    fn parse_props_skips_comments_blank_lines_import_lines_and_lines_without_eq() {
        let props = parse_props(
            &[
                "# a=comment",
                "   # b=indented comment",
                "",
                "   ",
                "import /vendor/etc/extra.prop",
                "import /odm/etc/build.prop ro.*",
                "no equals sign here",
                "=no key",
                "  spaced.key =  spaced value  ",
                "empty=",
                "eq=a=b",
                "crlf=value\r",
                "last=no newline",
            ]
            .join("\n"),
        );
        let entries: Vec<(&str, &str)> = props.iter().collect();
        assert_eq!(
            entries,
            vec![("spaced.key", "spaced value"), ("empty", ""), ("eq", "a=b"), ("crlf", "value"), ("last", "no newline")]
        );
    }

    #[test]
    fn parse_props_reads_every_property_line_of_the_real_files() {
        for volume in VOLUMES {
            let text = stock(volume);
            let lines = text.split('\n').filter(|line| !line.is_empty() && !line.starts_with('#')).count();
            assert_eq!(parse_props(&text).len(), lines, "{volume}");
        }
        assert_eq!(parse_props(&stock("system")).get("ro.build.id"), Some("RSR1.210722.013.A2"));
        assert_eq!(parse_props(&stock("vendor")).get("ro.bootimage.build.date"), Some("Thu May 4 15:17:11 UTC 2023"));
    }
}
