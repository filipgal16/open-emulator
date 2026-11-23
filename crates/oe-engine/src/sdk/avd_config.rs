//! An AVD's `config.ini`, and the emulator's command line.
//!
//! The config is a *rewrite* of a template rather than a file generated from scratch because the
//! template carries ~40 tuned keys (`hw.device.hash2`, sensor toggles, partition sizes) that
//! nothing here has an opinion about. Only the keys this project actually decides are overridden;
//! everything else is left exactly as shipped.

use oe_formats::recipes::recipe_by_id;

use crate::env_file::{DeviceIdentity, GuestProfile};
use crate::host::GuestTuning;
use crate::layout::system_image_dir;

/// Applies `overrides` to `template`: every line setting one of their keys is rewritten, and a key
/// the template does not mention is appended, in the order given.
pub fn apply_avd_config(template: &str, overrides: &[(String, String)]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    let mut lines: Vec<String> = oe_formats::bytes::split_lines(template)
        .into_iter()
        .map(|line| {
            let trimmed = oe_formats::bytes::js_trim(line);
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return line.to_owned();
            }
            let Some(eq) = trimmed.find('=').filter(|&eq| eq > 0) else { return line.to_owned() };
            let key = oe_formats::bytes::js_trim(&trimmed[..eq]);
            match overrides.iter().find(|(k, _)| k == key) {
                Some((k, value)) => {
                    seen.push(k);
                    format!("{k}={value}")
                }
                None => line.to_owned(),
            }
        })
        .collect();

    // A key the template does not mention still has to land, or an override silently does
    // nothing. `PlayStore.enabled` on a template that omits it is exactly this case.
    for (key, value) in overrides {
        if !seen.contains(&key.as_str()) {
            lines.push(format!("{key}={value}"));
        }
    }

    let last = lines.len().saturating_sub(1);
    let kept: Vec<&String> = lines.iter().enumerate().filter(|(i, line)| !line.is_empty() || *i < last).map(|(_, l)| l).collect();
    format!("{}\n", kept.iter().map(|l| l.as_str()).collect::<Vec<_>>().join("\n"))
}

pub struct AvdConfigInput<'a> {
    pub profile: &'a GuestProfile,
    pub device: &'a DeviceIdentity,
    pub tuning: &'a GuestTuning,
    /// False until `provision` has saved one. Forces the cold-boot path for the first start.
    pub has_snapshot: bool,
    pub snapshot_name: &'a str,
}

/// The keys this project decides, and why each one matters.
///
/// The load-bearing one is **`hw.gpu.mode`**, which must match the `-gpu` flag the emulator is
/// launched with. If they disagree, the snapshot written by one boot records a different renderer
/// than `config.ini` claims, and the next warm start dies with "The emulator hardware cannot load
/// snapshot". Both values come from the same [`GuestTuning`] precisely so they cannot drift — see
/// [`emulator_args`], which reads `tuning.gpu_mode` for the flag.
pub fn avd_config_overrides(input: &AvdConfigInput) -> Vec<(String, String)> {
    let AvdConfigInput { profile, device, tuning, has_snapshot, snapshot_name } = input;
    let mut overrides: Vec<(String, String)> = vec![
        ("AvdId".into(), profile.avd_name.clone()),
        ("avd.ini.displayname".into(), profile.avd_name.clone()),
        ("hw.cpu.ncore".into(), tuning.cores.to_string()),
        ("hw.ramSize".into(), tuning.ram_mb.to_string()),
        ("hw.gpu.mode".into(), tuning.gpu_mode.name().into()),
        ("hw.gpu.enabled".into(), "yes".into()),
        ("image.sysdir.1".into(), system_image_dir(&profile.image_tag, profile.api_level)),
        ("tag.id".into(), profile.image_tag.clone()),
        // Claiming a Play Store the image does not ship is how the old config ended up advertising
        // one on an AOSP image that never had it.
        ("PlayStore.enabled".into(), if profile.play_store { "true" } else { "false" }.into()),
        ("tag.display".into(), display_name_for_tag(&profile.image_tag)),
    ];

    // Panel geometry has to live in config.ini rather than a `-prop`: the framebuffer size is
    // hardware, fixed when the AVD boots.
    if let (Some(width), Some(height), Some(density)) = (device.lcd_width, device.lcd_height, device.lcd_density) {
        overrides.push(("hw.lcd.width".into(), width.to_string()));
        overrides.push(("hw.lcd.height".into(), height.to_string()));
        overrides.push(("hw.lcd.density".into(), density.to_string()));
    }

    // Until `provision` has saved a snapshot there is nothing to fast-boot from, and pointing the
    // AVD at one that does not exist produces a failed restore on the very first start.
    if *has_snapshot {
        overrides.push(("fastboot.forceColdBoot".into(), "no".into()));
        overrides.push(("fastboot.forceFastBoot".into(), "yes".into()));
        overrides.push(("fastboot.forceChosenSnapshotBoot".into(), "yes".into()));
        overrides.push(("fastboot.chosenSnapshotFile".into(), (*snapshot_name).to_owned()));
    } else {
        overrides.push(("fastboot.forceColdBoot".into(), "yes".into()));
        overrides.push(("fastboot.forceFastBoot".into(), "no".into()));
        overrides.push(("fastboot.forceChosenSnapshotBoot".into(), "no".into()));
    }
    overrides
}

fn display_name_for_tag(image_tag: &str) -> String {
    if let Some(recipe) = recipe_by_id(image_tag) {
        return recipe.display_name;
    }
    match image_tag {
        "default" => "AOSP",
        "google_apis_playstore" => "Google Play",
        _ => "Google APIs",
    }
    .to_owned()
}

pub struct EmulatorArgsInput<'a> {
    pub avd_name: &'a str,
    pub tuning: &'a GuestTuning,
    pub device: &'a DeviceIdentity,
    /// Restore the named snapshot instead of booting from scratch.
    pub use_snapshot: Option<&'a str>,
    pub headless: bool,
    pub writable_system: bool,
}

/// The emulator's command line.
///
/// Two flags are here for reasons that cost real debugging, and neither is cosmetic:
///
/// **`-gpu <mode>` is never `auto`.** The emulator resolves `auto` to a concrete renderer that
/// varies by system image — swiftshader on `google_apis`, lavapipe on AOSP — and writes the
/// *resolved* name into the snapshot's `hardware.ini`. `config.ini` would still say something
/// else, and the next warm start refuses the snapshot. `tuning.gpu_mode` is the single source for
/// both.
///
/// **`-no-snapshot-save` on a cold boot** is as important as `-no-snapshot-load`. Without it the
/// emulator writes a `default_boot` snapshot while quitting, and a kill arriving shortly after
/// lands mid-write and corrupts the snapshot store.
pub fn emulator_args(input: &EmulatorArgsInput) -> Vec<String> {
    let mut args: Vec<String> = [
        "-avd",
        input.avd_name,
        "-gpu",
        input.tuning.gpu_mode.name(),
        "-accel",
        if input.tuning.accel { "on" } else { "off" },
        "-no-boot-anim",
        "-no-metrics",
        "-netdelay",
        "none",
        "-netspeed",
        "full",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();

    if input.headless {
        // Audio has no sink in a headless run — the emulator logs a driver failure and initialises
        // it anyway. Skipping the subsystem is cheaper than letting it fail.
        args.extend(["-no-window".to_owned(), "-no-audio".to_owned()]);
    }
    if input.writable_system {
        args.push("-writable-system".into());
    }

    // Device identity is baked into the boot, so a snapshot taken afterwards carries it — which is
    // why switching device needs a re-provision rather than just a restart.
    for (key, value) in &input.device.props {
        args.push("-prop".into());
        args.push(format!("{key}={value}"));
    }

    if input.use_snapshot.is_none() {
        // A deliberate cold boot starts clean *and* leaves the saved snapshot untouched, so asking
        // for one cannot cost the user their fast start.
        args.extend(["-no-snapshot-load".to_owned(), "-no-snapshot-save".to_owned()]);
    }
    // A warm start passes nothing at all, and that is deliberate: `-snapshot <name>` is silently
    // ignored by this emulator, which then cold-boots (~32s), while Quick Boot left to itself
    // restores its `default_boot` snapshot in 2.8s. Saving on exit is likewise left enabled, which
    // keeps `default_boot` current; `stop` protects that write by asking the emulator to exit
    // cleanly before resorting to a kill.
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::GpuMode;

    fn profile() -> GuestProfile {
        GuestProfile {
            name: "fast".into(),
            description: String::new(),
            system_image: "system-images;android-30;default;x86_64".into(),
            image_tag: "default".into(),
            api_level: 30,
            ram_mb: None,
            base_image_tag: None,
            play_store: false,
            avd_name: "OpenEmulator_API30_fast".into(),
        }
    }

    fn device() -> DeviceIdentity {
        DeviceIdentity { name: "generic".into(), props: Vec::new(), lcd_width: None, lcd_height: None, lcd_density: None }
    }

    fn tuning() -> GuestTuning {
        GuestTuning { cores: 12, ram_mb: 3072, gpu_mode: GpuMode::Host, accel: true }
    }

    fn get<'a>(overrides: &'a [(String, String)], key: &str) -> Option<&'a str> {
        overrides.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn overrides(profile: &GuestProfile, device: &DeviceIdentity, tuning: &GuestTuning, has_snapshot: bool) -> Vec<(String, String)> {
        avd_config_overrides(&AvdConfigInput { profile, device, tuning, has_snapshot, snapshot_name: "booted" })
    }

    fn args(device: &DeviceIdentity, use_snapshot: Option<&str>, headless: bool, writable_system: bool) -> Vec<String> {
        emulator_args(&EmulatorArgsInput { avd_name: "A", tuning: &tuning(), device, use_snapshot, headless, writable_system })
    }

    fn pair(key: &str, value: &str) -> (String, String) {
        (key.to_owned(), value.to_owned())
    }

    #[test]
    fn only_the_keys_we_decide_are_touched_the_rest_of_the_template_survives() {
        let template = "# a comment\nhw.ramSize=3072\nhw.device.hash2=MD5:abc\nhw.sdCard=yes";
        let out = apply_avd_config(template, &[pair("hw.ramSize", "2048")]);
        assert!(out.lines().any(|l| l == "# a comment"), "comments survive");
        assert!(out.lines().any(|l| l == "hw.device.hash2=MD5:abc"), "untouched keys survive verbatim");
        assert!(out.lines().any(|l| l == "hw.ramSize=2048"));
    }

    #[test]
    fn an_override_for_a_key_the_template_omits_is_appended_not_dropped() {
        let out = apply_avd_config("hw.ramSize=3072", &[pair("PlayStore.enabled", "true")]);
        assert!(out.lines().any(|l| l == "PlayStore.enabled=true"));
    }

    #[test]
    fn the_file_ends_with_exactly_one_newline() {
        let out = apply_avd_config("a=1\nb=2", &[pair("a", "9")]);
        assert!(out.ends_with('\n') && !out.ends_with("\n\n"));
        let from_terminated = apply_avd_config("a=1\nb=2\n", &[pair("a", "9")]);
        assert_eq!(from_terminated, "a=9\nb=2\n");
    }

    #[test]
    fn the_image_directory_and_tag_follow_the_profile_not_the_default() {
        let play = GuestProfile { image_tag: "google_apis_playstore".into(), play_store: true, ..profile() };
        let o = overrides(&play, &device(), &tuning(), false);
        assert_eq!(get(&o, "image.sysdir.1"), Some("system-images/android-30/google_apis_playstore/x86_64/"));
        assert_eq!(get(&o, "tag.id"), Some("google_apis_playstore"));
        assert_eq!(get(&o, "PlayStore.enabled"), Some("true"));
        assert_eq!(get(&o, "tag.display"), Some("Google Play"));
    }

    #[test]
    fn a_profile_without_play_does_not_claim_to_have_it() {
        assert_eq!(get(&overrides(&profile(), &device(), &tuning(), false), "PlayStore.enabled"), Some("false"));
    }

    #[test]
    fn a_rom_profile_shows_the_recipes_name() {
        let openemu = GuestProfile { image_tag: "openemu".into(), ..profile() };
        assert_eq!(get(&overrides(&openemu, &device(), &tuning(), false), "tag.display"), Some("open-emulator Android"));
    }

    #[test]
    fn hw_gpu_mode_comes_from_the_same_tuning_object_as_the_gpu_flag() {
        let soft = GuestTuning { gpu_mode: GpuMode::SwiftshaderIndirect, ..tuning() };
        let config = overrides(&profile(), &device(), &soft, false);
        let args = emulator_args(&EmulatorArgsInput {
            avd_name: "A",
            tuning: &soft,
            device: &device(),
            use_snapshot: None,
            headless: true,
            writable_system: false,
        });
        assert_eq!(get(&config, "hw.gpu.mode"), Some("swiftshader_indirect"));
        assert_eq!(args[args.iter().position(|a| a == "-gpu").unwrap() + 1], "swiftshader_indirect");
    }

    #[test]
    fn the_first_start_is_forced_cold_because_there_is_no_snapshot_to_restore_yet() {
        let fresh = overrides(&profile(), &device(), &tuning(), false);
        assert_eq!(get(&fresh, "fastboot.forceColdBoot"), Some("yes"));
        assert_eq!(get(&fresh, "fastboot.forceChosenSnapshotBoot"), Some("no"));
    }

    #[test]
    fn once_provisioned_the_avd_points_at_the_snapshot_by_name() {
        let ready = overrides(&profile(), &device(), &tuning(), true);
        assert_eq!(get(&ready, "fastboot.forceFastBoot"), Some("yes"));
        assert_eq!(get(&ready, "fastboot.chosenSnapshotFile"), Some("booted"));
    }

    #[test]
    fn panel_geometry_is_written_only_when_the_device_profile_states_it() {
        assert_eq!(get(&overrides(&profile(), &device(), &tuning(), false), "hw.lcd.width"), None);
        let pixel = DeviceIdentity { lcd_width: Some(1080), lcd_height: Some(2340), lcd_density: Some(440), ..device() };
        let o = overrides(&profile(), &pixel, &tuning(), false);
        assert_eq!(get(&o, "hw.lcd.width"), Some("1080"));
        assert_eq!(get(&o, "hw.lcd.density"), Some("440"));
    }

    #[test]
    fn a_cold_boot_neither_loads_nor_saves_a_snapshot() {
        let cold = args(&device(), None, true, false);
        assert!(cold.contains(&"-no-snapshot-load".into()) && cold.contains(&"-no-snapshot-save".into()));
        assert_ne!(cold[cold.iter().position(|a| a == "-gpu").unwrap() + 1], "auto");
    }

    #[test]
    fn a_warm_start_passes_no_snapshot_flags_so_quick_boot_restores_its_own() {
        let warm = args(&device(), Some("default_boot"), true, false);
        assert!(!warm.contains(&"-snapshot".into()), "naming a snapshot is what broke the warm path");
        assert!(!warm.contains(&"-no-snapshot-load".into()), "loading must stay enabled or there is no warm start");
        assert!(!warm.contains(&"-no-snapshot-save".into()), "saving on exit is what keeps default_boot current");
    }

    #[test]
    fn a_headless_run_drops_the_window_and_the_audio_subsystem() {
        let head = args(&device(), None, true, false);
        assert!(head.contains(&"-no-window".into()) && head.contains(&"-no-audio".into()));
        assert!(!args(&device(), None, false, false).contains(&"-no-window".into()), "a native run has a real window to embed");
    }

    #[test]
    fn a_writable_system_is_an_explicit_flag_not_the_default() {
        assert!(!args(&device(), None, true, false).contains(&"-writable-system".into()));
        assert!(args(&device(), None, true, true).contains(&"-writable-system".into()));
    }

    #[test]
    fn device_identity_is_passed_as_prop_pairs_and_generic_passes_none() {
        assert!(!args(&device(), None, true, false).contains(&"-prop".into()));
        let pixel = DeviceIdentity { props: vec![pair("ro.product.model", "Pixel 5"), pair("ro.product.brand", "google")], ..device() };
        let a = args(&pixel, None, true, false);
        assert!(a.contains(&"-prop".into()));
        assert!(a.contains(&"ro.product.model=Pixel 5".into()));
    }
}
