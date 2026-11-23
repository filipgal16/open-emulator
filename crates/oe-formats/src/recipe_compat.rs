//! `openemu-compat`: the ROM for running what people actually install — ARM games — rather than
//! the licence-clean minimum.
//!
//! `openemu` is built from the AOSP image, which is x86-only: an app that ships only ARM libraries
//! (nearly every game) does not install on it. The only ARM translators that exist are Google's
//! and Intel's, and Google's is inside its **Google APIs** image. This recipe therefore starts
//! from that image instead and takes things away, which the builder can do, rather than grafting
//! the translator into the AOSP one, which it cannot: the translator is several hundred files and
//! the AOSP volumes have 88 MB and 174 inodes free.
//!
//! What that costs is written down in `design/openemu-rom.md` ("openemu-compat"): the result
//! contains Google Mobile Services and is derived from a Google binary, so it is built on the
//! user's machine from their own download and is never ours to redistribute.
//!
//! Three rules shape it.
//!
//! **Compatibility first.** Google's identity stays exactly as shipped (`identity: None`): Play
//! services decides from the build fingerprint whether the device may sign in, and a game's
//! "Sign in with Google" goes through it. Anything an app can reach by API — Play services, the
//! services framework, WebView, Chrome (custom tabs are how most games show a login page), the
//! keyboard, text-to-speech, the licence checker, the document and photo pickers — stays, however
//! large.
//!
//! **Every core visible.** The translator tells ARM apps the device has one CPU; see
//! [`crate::arm_cpuinfo`]. Both of its cpuinfo files are rewritten to list the guest's cores.
//!
//! **Lightweight where it is free.** What goes is what a person would open by hand on a phone and
//! never on an emulator, plus the Google services that run in the background for a phone's sake:
//! the Google app (Assistant, hotword, the launcher's feed), Digital Wellbeing, Android System
//! Intelligence and its Private Compute companion, the dialer and SMS app, Android Auto and
//! supervision stubs, and the restore-from-backup flow of a setup wizard this image never shows.
//! Removing an app's directory does not remove a provider other apps query: every `*Provider`
//! stays, as on `openemu`.

use crate::recipe::{under, PerVolume, RomEdit, RomRecipe, Transform, Volume};

const VERSION: u32 = 1;

/// Apps this recipe must never remove, and why. A test holds `debloat` to it, as `KEPT` does for
/// `openemu`.
pub const COMPAT_KEPT: &[(&str, &str)] = &[
    ("PrebuiltGmsCore", "Google Play services: sign-in, push, ads, Play Games — what most games call first"),
    ("GoogleServicesFramework", "Play services cannot register the device or hold an account without it"),
    ("ConfigUpdater", "delivers the server-side configuration Play services runs on"),
    ("GoogleOneTimeInitializer", "sets the Google defaults on first boot; Play services expects them"),
    ("PartnerSetupPrebuilt", "the client id Google apps identify the device by"),
    ("GoogleSdkSetup", "the emulator image's stand-in for the setup wizard; without it the device never finishes provisioning"),
    ("WebViewGoogle", "the WebView provider: in-game browsers, login pages, ads"),
    ("WebViewGoogle-Stub", "the provider's compressed stub, which the framework resolves first"),
    ("TrichromeLibrary", "the shared library WebView and Chrome are both built on"),
    ("TrichromeLibrary-Stub", "its stub, as above"),
    ("Chrome", "custom tabs: how a game opens \"Sign in with …\" and its terms pages"),
    ("Chrome-Stub", "its stub, as above"),
    ("LatinIMEGooglePrebuilt", "the only keyboard on the image"),
    ("GoogleTTS", "the only text-to-speech engine; costs nothing while unused"),
    ("LicenseChecker", "the Play licensing service paid apps bind to"),
    ("ModuleMetadataGoogle", "names the mainline modules; the module updater reads it at boot"),
    ("NexusLauncherRelease", "the home screen"),
    ("SettingsGoogle", "the Settings app, which apps and system dialogs deep-link into"),
    ("SystemUIGoogle", "the status bar, navigation and every system dialog"),
    ("SettingsIntelligenceGooglePrebuilt", "search inside Settings; Settings binds it"),
    ("DocumentsUIGoogle", "the file picker behind ACTION_OPEN_DOCUMENT"),
    ("GooglePackageInstaller", "the install and permission dialogs"),
    ("NetworkStackGoogle", "DHCP and connectivity checks; without it there is no network"),
    ("CaptivePortalLoginGoogle", "opened by the network stack when a sign-in page is detected"),
    ("Camera2", "ACTION_IMAGE_CAPTURE needs a handler"),
    ("ContactsProvider", "removing the Contacts app does not remove its provider, which telephony and other apps use"),
    ("CalendarProvider", "removing the Calendar app does not remove its provider, which other apps use"),
    ("TelephonyProvider", "telephony's own data; the framework starts it regardless of the apps removed"),
    ("BlockedNumberProvider", "Telecom checks incoming calls against it"),
    ("SettingsProvider", "Settings.System/Secure/Global live in it; without it nothing boots"),
    ("DownloadProvider", "DownloadManager is a framework API any app may call — games fetch their data with it"),
    ("MediaProviderLegacy", "migrates media data for the MediaProvider module"),
    ("ExternalStorageProvider", "serves /sdcard to the file picker"),
    ("TeleService", "com.android.phone; the framework starts it regardless of the apps removed"),
    ("Telecom", "call routing in the framework; runs whether or not a dialer is installed"),
    ("NfcNci", "kept until a boot shows whether this image declares android.hardware.nfc; openemu removed it only after checking"),
    ("SecureElement", "paired with NFC; same reason"),
];

/// The `openemu-compat` recipe.
pub fn openemu_compat_recipe() -> RomRecipe {
    RomRecipe {
        id: "openemu-compat".into(),
        version: VERSION,
        display_name: "open-emulator Android (Google APIs)".into(),
        base_tag: "google_apis".into(),
        api_level: 34,
        identity: None,
        // Android 14 keeps system_ext's and product's under /etc (checked on a boot of this image);
        // API 30 had them at the volume root.
        build_prop_path: PerVolume {
            system: "/system/build.prop".into(),
            system_ext: "/etc/build.prop".into(),
            product: "/etc/build.prop".into(),
            vendor: "/build.prop".into(),
        },
        debloat: PerVolume {
            system: [
                // The same user-facing extras `openemu` removes, under the names this image gives
                // them: screensavers, the easter egg, Bluetooth MIDI, partner bookmarks, the SIM
                // toolkit screens, print recommendations and the tracing tool. None is needed to
                // boot.
                under(
                    "/system/app",
                    &[
                        "BasicDreams",
                        "BluetoothMidiService",
                        "EasterEgg",
                        "GooglePrintRecommendationService",
                        "PartnerBookmarksProvider",
                        "SimAppDialog",
                        "Stk",
                        "Traceur",
                    ],
                ),
                // The default print plugin (the spooler stays), the call-log backup agent (no
                // dialer left to log calls), legacy cell broadcast, the GSI installer, the audio
                // effects panel, the opportunistic network service, live wallpapers and the NFC tag
                // viewer.
                under(
                    "/system/priv-app",
                    &[
                        "BuiltInPrintService",
                        "CallLogBackup",
                        "CellBroadcastLegacyApp",
                        "DynamicSystemInstallationService",
                        "LiveWallpapersPicker",
                        "MusicFX",
                        "ONS",
                        "TagGoogle",
                    ],
                ),
            ]
            .concat(),
            // The emergency information screen, the accessibility shortcut menu, the "send feedback
            // to Google" reporter and the lock-screen wallet tile: phone features, none bound at
            // boot.
            system_ext: under("/priv-app", &["AccessibilityMenu", "EmergencyInfo", "GoogleFeedback", "QuickAccessWallet"]),
            product: [
                // Google's bundled user apps. Nothing binds them by package: calendar and contact
                // data live in the providers (which stay), a photo is picked through the system
                // picker, and a link opens in Chrome.
                under(
                    "/app",
                    &[
                        "CalendarGooglePrebuilt",
                        "Drive",
                        "GoogleContacts",
                        "Maps",
                        "MarkupGoogle",
                        "NexusWallpapersStubPrebuilt2018",
                        "Photos",
                        "PixelThemesStub",
                        "PrebuiltDeskClockGoogle",
                        "PrebuiltGmail",
                        "YouTube",
                        "YouTubeMusicPrebuilt",
                        "talkback",
                    ],
                ),
                // The Google app (Assistant, hotword, the launcher feed — the heaviest background
                // process on the stock image), Digital Wellbeing, Android System Intelligence and
                // the Private Compute services it talks through, the dialer and the SMS app (no
                // telephony UI on an emulator, as on `openemu`), the Android Auto and supervision
                // stubs, and restore-from-backup, which only the setup wizard this image never
                // shows can start.
                under(
                    "/priv-app",
                    &[
                        "AndroidAutoStubPrebuilt",
                        "DeviceIntelligenceNetworkPrebuilt",
                        "DevicePersonalizationPrebuiltPixel2021",
                        "GoogleDialer",
                        "GoogleRestorePrebuilt",
                        "KidsSupervisionStub",
                        "PrebuiltBugle",
                        "Velvet",
                        "WellbeingPrebuilt",
                    ],
                ),
            ]
            .concat(),
            // Nothing: vendor holds the goldfish HALs.
            vendor: Vec::new(),
        },
        system_props: vec![
            ("ro.openemu.rom".into(), "1".into()),
            ("ro.openemu.rom.version".into(), VERSION.to_string()),
            ("ro.openemu.rom.recipe".into(), "openemu-compat".into()),
            // The one line of identity that is ours: the build number Settings → About shows. It
            // is display text; nothing derives a fingerprint from it.
            ("ro.build.display.id".into(), format!("open-emulator Android 14 (openemu-compat {VERSION})")),
        ],
        edits: Some(vec![
            RomEdit { volume: Volume::System, path: "/system/etc/cpuinfo.arm64.txt".into(), transform: Transform::ArmCpuinfo },
            RomEdit { volume: Volume::System, path: "/system/etc/cpuinfo.arm.txt".into(), transform: Transform::ArmCpuinfo },
        ]),
        files: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipe::{recipe_hash, used_params, validate_recipe, FileKind, RomFile, RomParams, BUILDER_REVISION, MAX_ARM_CPU_CORES};
    use std::collections::HashMap;

    fn basename(p: &str) -> &str {
        &p[p.rfind('/').map_or(0, |i| i + 1)..]
    }

    fn removed(r: &RomRecipe) -> Vec<String> {
        Volume::ALL.iter().flat_map(|&v| r.debloat.get(v)).map(|p| basename(p).to_owned()).collect()
    }

    fn hash(cores: Option<u32>) -> crate::Result<String> {
        recipe_hash(&openemu_compat_recipe(), &HashMap::new(), BUILDER_REVISION, RomParams { arm_cpu_cores: cores })
    }

    #[test]
    fn the_hash_is_the_one_the_typescript_builder_computed() {
        // recipeHash(OPENEMU_COMPAT_RECIPE, {}, 2, { armCpuCores: 6 }) in desktop v0.2.0.
        assert_eq!(hash(Some(6)).unwrap(), "dd894e69e00db009adf1d8874e0f9ac619adcc2805824f4dec36593edb93a8d1");
    }

    #[test]
    fn the_compat_recipe_validates() {
        validate_recipe(&openemu_compat_recipe()).unwrap();
    }

    #[test]
    fn it_is_built_from_the_google_apis_image_the_one_that_carries_the_arm_translator() {
        let r = openemu_compat_recipe();
        assert_eq!(r.id, "openemu-compat");
        assert_eq!(r.base_tag, "google_apis");
        assert_eq!(r.api_level, 34);
        assert_eq!(r.version, 1);
    }

    #[test]
    fn googles_identity_is_left_alone() {
        let r = openemu_compat_recipe();
        assert!(r.identity.is_none());
        // The only identity-looking prop it sets is display text.
        assert!(!r.system_props.iter().any(|(k, _)| k.contains("fingerprint") || k.contains("ro.product.")));
        assert!(r.system_prop("ro.build.display.id").unwrap().contains(&format!("openemu-compat {}", r.version)));
        assert_eq!(r.system_prop("ro.openemu.rom.version"), Some(r.version.to_string().as_str()));
        assert_eq!(r.system_prop("ro.openemu.rom.recipe"), Some(r.id.as_str()));
    }

    #[test]
    fn both_of_the_translators_cpuinfo_files_are_rewritten_and_nothing_else_is() {
        let r = openemu_compat_recipe();
        let paths: Vec<&str> = r.edits().iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["/system/etc/cpuinfo.arm64.txt", "/system/etc/cpuinfo.arm.txt"]);
        assert!(r.files.is_empty());
    }

    #[test]
    fn nothing_on_the_kept_list_is_removed_and_each_keep_says_why() {
        let gone = removed(&openemu_compat_recipe());
        for (name, reason) in COMPAT_KEPT {
            assert!(!gone.iter().any(|g| g == name), "{name} is kept on purpose: {reason}");
            assert!(reason.len() > 10, "{name} needs a reason");
        }
        let providers: Vec<&String> = gone.iter().filter(|n| n.ends_with("Provider")).collect();
        assert_eq!(providers, vec!["PartnerBookmarksProvider"]);
    }

    #[test]
    fn the_heavy_background_google_services_are_what_goes_from_product() {
        let r = openemu_compat_recipe();
        for app in [
            "/priv-app/Velvet",
            "/priv-app/WellbeingPrebuilt",
            "/priv-app/DevicePersonalizationPrebuiltPixel2021",
            "/priv-app/GoogleDialer",
            "/priv-app/PrebuiltBugle",
            "/app/YouTube",
            "/app/Maps",
            "/app/PrebuiltGmail",
            "/app/Photos",
        ] {
            assert!(r.debloat.product.iter().any(|p| p == app), "{app} is removed");
        }
        assert!(r.debloat.vendor.is_empty(), "nothing is removed from vendor, which holds the HALs");
    }

    #[test]
    fn the_core_count_is_part_of_the_hash() {
        let six = hash(Some(6)).unwrap();
        assert_eq!(hash(Some(6)).unwrap(), six);
        assert_ne!(hash(Some(12)).unwrap(), six);
    }

    #[test]
    fn a_recipe_that_rewrites_cpuinfo_cannot_be_hashed_without_the_core_count() {
        assert!(hash(None).unwrap_err().0.contains("how many cores the guest has"));
    }

    #[test]
    fn a_core_count_the_emulator_could_not_start_a_guest_with_is_refused() {
        for bad in [0, MAX_ARM_CPU_CORES + 1] {
            let error = used_params(&openemu_compat_recipe(), RomParams { arm_cpu_cores: Some(bad) }).unwrap_err();
            assert!(error.0.contains("not a whole number from 1 to"));
        }
        let max = RomParams { arm_cpu_cores: Some(MAX_ARM_CPU_CORES) };
        assert_eq!(used_params(&openemu_compat_recipe(), max).unwrap(), Some(max));
    }

    #[test]
    fn an_edit_is_held_to_the_same_path_rules_as_everything_else() {
        let refuses = |mutate: &dyn Fn(&mut RomRecipe), message: &str| {
            let mut r = openemu_compat_recipe();
            mutate(&mut r);
            let error = validate_recipe(&r).expect_err("expected a refusal").0;
            assert!(error.contains(message), "{error} should mention {message}");
        };
        refuses(&|r| r.edits.as_mut().unwrap()[0].path = "system/etc/cpuinfo.arm64.txt".into(), "is not absolute");
        refuses(&|r| r.edits.as_mut().unwrap()[0].path = "/etc/cpuinfo.arm64.txt".into(), "outside /system/");
        refuses(
            &|r| {
                let first = r.edits.as_ref().unwrap()[0].clone();
                r.edits.as_mut().unwrap().push(first);
            },
            "listed twice",
        );
        refuses(&|r| r.debloat.system.push("/system/etc".into()), "is edited, but debloat removes /system/etc");
        refuses(&|r| r.edits.as_mut().unwrap()[0].path = "/system/build.prop".into(), "is the volume's build.prop");
        refuses(
            &|r| {
                r.files.push(RomFile {
                    volume: Volume::System,
                    path: "/system/etc".into(),
                    kind: FileKind::Dir,
                    mode: 0o755,
                    selinux: "u:object_r:system_file:s0".into(),
                    source: None,
                });
                r.files.push(RomFile {
                    volume: Volume::System,
                    path: "/system/etc/cpuinfo.arm64.txt".into(),
                    kind: FileKind::File,
                    mode: 0o644,
                    selinux: "u:object_r:system_file:s0".into(),
                    source: None,
                });
            },
            "both edited in place and created",
        );
    }
}
