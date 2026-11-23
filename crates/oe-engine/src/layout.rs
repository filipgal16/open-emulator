//! Where the native runtime keeps everything it downloads.
//!
//! The root should be under `%LOCALAPPDATA%`, and **must not contain spaces**: the Android SDK's
//! own tooling has a long history of mishandling them, and `%LOCALAPPDATA%\open-emulator` avoids
//! the question entirely. It is deliberately not the app's settings folder: it is a
//! multi-gigabyte cache the user may want to delete without losing their account and preferences.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkLayout {
    /// `%LOCALAPPDATA%\open-emulator`
    pub root: PathBuf,
    /// The Android SDK: `cmdline-tools/`, `platform-tools/`, `emulator/`, `system-images/`.
    pub sdk_root: PathBuf,
    pub cmdline_tools: PathBuf,
    pub sdk_manager: PathBuf,
    pub avd_manager: PathBuf,
    pub emulator: PathBuf,
    pub adb: PathBuf,
    /// Fetched only when the host has no usable `java` — `sdkmanager` is a Java program.
    pub jre_root: PathBuf,
    /// `ANDROID_AVD_HOME`. One `.avd` directory and `.ini` per profile.
    pub avd_home: PathBuf,
    pub logs: PathBuf,
    /// Per-AVD, never shared: see [`avd_state`].
    pub state_root: PathBuf,
    /// Android-x86 ISOs and QEMU, for the licence-clean engine.
    pub images: PathBuf,
    pub qemu_root: PathBuf,
}

impl SdkLayout {
    /// The layout for this platform.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::for_platform(root, cfg!(windows))
    }

    /// On Windows every SDK entry point is a `.exe` or a `.bat`; elsewhere it is bare.
    pub fn for_platform(root: impl Into<PathBuf>, windows: bool) -> Self {
        let root = root.into();
        let exe = |name: &str| if windows { format!("{name}.exe") } else { name.to_owned() };
        let bat = |name: &str| if windows { format!("{name}.bat") } else { name.to_owned() };
        let sdk_root = root.join("sdk");
        let cmdline_tools = sdk_root.join("cmdline-tools").join("latest");
        SdkLayout {
            sdk_manager: cmdline_tools.join("bin").join(bat("sdkmanager")),
            avd_manager: cmdline_tools.join("bin").join(bat("avdmanager")),
            emulator: sdk_root.join("emulator").join(exe("emulator")),
            adb: sdk_root.join("platform-tools").join(exe("adb")),
            jre_root: root.join("jre"),
            avd_home: root.join("avd"),
            logs: root.join("logs"),
            state_root: root.join("state"),
            images: root.join("images"),
            qemu_root: root.join("qemu"),
            cmdline_tools,
            sdk_root,
            root,
        }
    }
}

/// The state directory for one AVD.
///
/// Per-AVD, not shared. Sharing it across profiles meant a `provisioned_at` written while running
/// one guest vouched for another, so switching to the Play profile would launch an unprovisioned
/// guest that claimed to be ready.
pub fn avd_state(layout: &SdkLayout, avd_name: &str) -> PathBuf {
    layout.state_root.join(avd_name)
}

/// The AVD's own directory, which is where `config.ini` and `snapshots/` live.
pub fn avd_dir(layout: &SdkLayout, avd_name: &str) -> PathBuf {
    layout.avd_home.join(format!("{avd_name}.avd"))
}

pub fn snapshot_dir(layout: &SdkLayout, avd_name: &str, snapshot: &str) -> PathBuf {
    avd_dir(layout, avd_name).join("snapshots").join(snapshot)
}

/// The unpacked system image a profile needs, e.g.
/// `sdk/system-images/android-30/google_apis_playstore/x86_64/system.img`.
///
/// Checking for the image rather than just the emulator binary is what stops a profile switch
/// sailing past the "is Android downloaded?" check and failing much later inside `avdmanager`.
pub fn system_image_path(layout: &SdkLayout, image_tag: &str, api_level: u32) -> PathBuf {
    layout
        .sdk_root
        .join("system-images")
        .join(format!("android-{api_level}"))
        .join(image_tag)
        .join("x86_64")
        .join("system.img")
}

/// The same directory as an AVD's `image.sysdir.1` names it: relative, `/`-separated, trailing
/// slash.
pub fn system_image_dir(image_tag: &str, api_level: u32) -> String {
    format!("system-images/android-{api_level}/{image_tag}/x86_64/")
}

/// Where the native runtime keeps the SDK, images and state: `%LOCALAPPDATA%\open-emulator`, or
/// the folder the user chose.
pub fn native_root(override_root: Option<&Path>) -> PathBuf {
    if let Some(root) = override_root.filter(|r| !r.as_os_str().is_empty()) {
        return root.to_owned();
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| {
        let profile = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\"));
        profile.join("AppData").join("Local")
    });
    base.join("open-emulator")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = r"C:\Users\x\AppData\Local\open-emulator";

    fn win() -> SdkLayout {
        SdkLayout::for_platform(ROOT, true)
    }

    #[test]
    fn every_sdk_entry_point_gets_a_windows_extension() {
        let layout = win();
        assert!(layout.emulator.ends_with("emulator.exe"));
        assert!(layout.adb.ends_with("adb.exe"));
        // sdkmanager and avdmanager ship as .bat wrappers around the Java program, not .exe.
        assert!(layout.sdk_manager.ends_with("sdkmanager.bat"));
        assert!(layout.avd_manager.ends_with("avdmanager.bat"));
    }

    #[test]
    fn the_same_layout_resolves_bare_names_off_windows() {
        let layout = SdkLayout::for_platform("/home/x/.open-emulator", false);
        assert!(layout.emulator.ends_with("emulator"));
        assert!(layout.sdk_manager.ends_with("sdkmanager"));
    }

    #[test]
    fn the_install_root_carries_no_spaces() {
        assert!(!win().sdk_root.to_string_lossy().contains(' '));
    }

    #[test]
    fn avd_state_is_per_avd_so_one_guest_cannot_vouch_for_another() {
        assert_ne!(avd_state(&win(), "OpenEmulator_API30_fast"), avd_state(&win(), "OpenEmulator_API30_play"));
    }

    #[test]
    fn snapshots_live_inside_the_avd_they_belong_to() {
        assert!(snapshot_dir(&win(), "A", "booted").starts_with(avd_dir(&win(), "A")));
    }

    #[test]
    fn the_system_image_path_is_per_image_tag_not_per_profile_name() {
        let aosp = system_image_path(&win(), "default", 30);
        let play = system_image_path(&win(), "google_apis_playstore", 30);
        assert_ne!(aosp, play);
        assert!(aosp.ends_with("system.img"));
        assert!(aosp.to_string_lossy().contains("android-30"));
        assert_eq!(system_image_dir("default", 34), "system-images/android-34/default/x86_64/");
    }

    #[test]
    fn a_chosen_folder_replaces_the_default_root() {
        assert_eq!(native_root(Some(Path::new(r"D:\Android"))), PathBuf::from(r"D:\Android"));
        assert!(native_root(None).ends_with("open-emulator"));
    }
}
