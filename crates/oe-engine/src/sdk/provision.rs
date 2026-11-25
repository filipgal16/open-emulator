//! Guest settings applied once, before the snapshot is taken.
//!
//! Each group earns its place: a guest that boots into a setup wizard, sleeps after a minute, and
//! refuses sideloaded APKs is technically working and practically unusable. These are shell
//! commands because they run inside Android, where `sh` is what there is.

use std::time::Duration;

use oe_formats::recipes::recipe_by_id;

use crate::env_file::GuestProfile;
use crate::sdk::adb::Adb;
use crate::{CommandResult, LogHandler};

/// Ordered deliberately: the wizard and lockscreen first, because everything after them assumes
/// the home screen is reachable.
const SETTINGS: &[(&str, &[&str])] = &[
    (
        "setup wizard and lockscreen",
        &[
            "settings put global device_provisioned 1",
            "settings put secure user_setup_complete 1",
            "locksettings set-disabled true",
            "wm dismiss-keyguard",
        ],
    ),
    (
        "allow sideloaded installs",
        &[
            "settings put global package_verifier_enable 0",
            "settings put global verifier_verify_adb_installs 0",
            "settings put global install_non_market_apps 1",
            "settings put secure install_non_market_apps 1",
        ],
    ),
    (
        "stay awake and feel responsive",
        &[
            "settings put global window_animation_scale 0.5",
            "settings put global transition_animation_scale 0.5",
            "settings put global animator_duration_scale 0.5",
            // Never. A screen that times out inside an embedded window is a black rectangle with no
            // explanation, and `stay_on_while_plugged_in` alone did not keep it awake.
            "settings put system screen_off_timeout 2147483647",
            "settings put global stay_on_while_plugged_in 3",
        ],
    ),
    (
        "networking",
        &[
            "settings put global airplane_mode_on 0",
            "svc wifi enable",
            "svc data enable",
            "settings put global private_dns_mode off",
        ],
    ),
];

/// Packages compiled ahead of the snapshot, so a restored guest starts with warm ART instead of
/// JIT-ing on every warm boot.
///
/// Deliberately short. Compiling more dirties more guest pages, which grows the snapshot's
/// `ram.bin`, and warm start is dominated by restoring that file, so a longer list makes every
/// subsequent start *slower*.
const DEXOPT_PACKAGES: &[&str] = &["com.android.settings", "com.android.systemui"];

/// Extra userdata settings for every ROM of ours: the things Android keeps in userdata and the
/// snapshot then preserves. Animations off rather than halved: a desktop emulator is driven with a
/// mouse, and transitions read as lag there. Bluetooth off by default: nothing on a PC pairs with
/// the guest's virtual radio. The screensaver off: both recipes remove the stock dreams, and one
/// that started anyway would cover the game. All stay changeable in Settings.
const ROM_SETTINGS: &[&str] = &[
    "settings put global window_animation_scale 0",
    "settings put global transition_animation_scale 0",
    "settings put global animator_duration_scale 0",
    "settings put global bluetooth_on 0",
    "settings put secure screensaver_enabled 0",
];

/// Quick Boot's own snapshot name. Saved under any other name, the emulator ignores it on launch
/// and cold-boots instead, which is what made provisioning look successful while every later
/// start still took half a minute.
pub const QUICK_BOOT_SNAPSHOT: &str = "default_boot";

pub struct ProvisionInput<'a> {
    pub adb: &'a Adb,
    pub serial: &'a str,
    pub profile: &'a GuestProfile,
    pub accelerated: bool,
    pub on_log: LogHandler,
    pub log: &'a (dyn Fn(&str) + Send + Sync),
}

pub async fn provision_guest(input: ProvisionInput<'_>) -> CommandResult {
    let ProvisionInput { adb, serial, profile, accelerated, on_log, log } = input;
    // Best-effort by design. Several of these are absent on some images (`svc data` on an AOSP
    // build with no telephony), and a missing one is not a reason to fail provisioning.
    let shell = |command: String, timeout: Duration| {
        let on_log = on_log.clone();
        async move {
            let _ = adb.shell(serial, &command, on_log, timeout).await;
        }
    };

    for (why, commands) in SETTINGS {
        log(&format!("provisioning: {why}"));
        for command in *commands {
            shell((*command).to_owned(), Duration::from_secs(30)).await;
        }
    }

    if recipe_by_id(&profile.image_tag).is_some() {
        log("provisioning: open-emulator image tunings");
        for command in ROM_SETTINGS {
            shell((*command).to_owned(), Duration::from_secs(30)).await;
        }
    }

    // Play and GMS exist only on the Google images. A ROM built from a Google image counts:
    // `openemu-compat` keeps Play services, and a game's sign-in goes through it.
    if profile.base_image_tag.as_deref().unwrap_or(&profile.image_tag).starts_with("google") {
        log(&format!("enabling Play and GMS (profile {})", profile.name));
        for package in ["com.android.vending", "com.google.android.gms"] {
            shell(format!("pm enable {package}"), Duration::from_secs(60)).await;
        }
    }

    if accelerated {
        log(&format!("compiling {}", DEXOPT_PACKAGES.join(", ")));
        for package in DEXOPT_PACKAGES {
            shell(format!("cmd package compile -m speed-profile -f {package}"), Duration::from_secs(300)).await;
        }
    } else {
        // On a software CPU this costs many minutes and buys back less than it spends.
        log("no acceleration; skipping ahead-of-time compilation");
    }

    shell("input keyevent KEYCODE_HOME".to_owned(), Duration::from_secs(30)).await;

    log("saving the snapshot");
    let args: Vec<String> = ["emu", "avd", "snapshot", "save", QUICK_BOOT_SNAPSHOT].iter().map(|s| (*s).to_owned()).collect();
    let saved = adb.exec(serial, &args, on_log.clone(), Duration::from_secs(180)).await;
    if !saved.as_ref().is_ok_and(CommandResult::success) {
        return CommandResult::synthetic(1, Vec::new(), vec!["could not save the snapshot".into()]);
    }
    log("provisioned");
    CommandResult::synthetic(0, vec!["provisioned=1".into()], Vec::new())
}
