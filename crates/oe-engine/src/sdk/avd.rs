//! Creates an AVD without `avdmanager`.
//!
//! `avdmanager` lives in `cmdline-tools`, which the native runtime does not download. That costs
//! nothing, because an AVD is not a rich object: it is a pointer file and a `config.ini`, and the
//! emulator creates the userdata images itself on first boot. Writing the two files directly is
//! both simpler and more predictable than generating them and correcting the result.

use std::path::{Path, PathBuf};

use crate::env_file::{DeviceIdentity, GuestProfile};
use crate::host::GuestTuning;
use crate::layout::{avd_dir, snapshot_dir, SdkLayout};
use crate::sdk::avd_config::{apply_avd_config, avd_config_overrides, AvdConfigInput};
use crate::{err, Result};

/// The `config.ini` template shipped with the project, holding the keys nothing here decides.
pub fn load_template(android_root: &Path) -> Result<String> {
    let file = android_root.join("config").join("avd_config.ini");
    std::fs::read_to_string(&file).map_err(|error| err!("{}: {error}", file.display()))
}

pub struct CreateAvdInput<'a> {
    pub layout: &'a SdkLayout,
    pub android_root: &'a Path,
    pub profile: &'a GuestProfile,
    pub device: &'a DeviceIdentity,
    pub tuning: &'a GuestTuning,
    pub snapshot_name: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvdPaths {
    pub dir: PathBuf,
    pub config_ini: PathBuf,
    pub pointer_ini: PathBuf,
}

pub fn avd_paths(layout: &SdkLayout, avd_name: &str) -> AvdPaths {
    let dir = avd_dir(layout, avd_name);
    AvdPaths { config_ini: dir.join("config.ini"), pointer_ini: layout.avd_home.join(format!("{avd_name}.ini")), dir }
}

/// Whether this profile's AVD already exists and is pointed at correctly.
pub fn avd_exists(layout: &SdkLayout, avd_name: &str) -> bool {
    let paths = avd_paths(layout, avd_name);
    paths.config_ini.exists() && paths.pointer_ini.exists()
}

/// Writes (or refreshes) the AVD.
///
/// Safe to re-run: it rewrites the two configuration files and touches nothing else, so an
/// existing guest keeps its userdata, its snapshot, and its installed apps. That is what lets
/// setup call this on every start to keep cores, RAM, and the renderer in step with the host:
/// `hw.gpu.mode` in particular has to match the `-gpu` flag or the snapshot becomes unloadable.
pub fn create_avd(input: &CreateAvdInput) -> Result<AvdPaths> {
    let paths = avd_paths(input.layout, &input.profile.avd_name);
    std::fs::create_dir_all(&paths.dir)?;

    let overrides = avd_config_overrides(&AvdConfigInput {
        profile: input.profile,
        device: input.device,
        tuning: input.tuning,
        has_snapshot: snapshot_dir(input.layout, &input.profile.avd_name, input.snapshot_name).exists(),
        snapshot_name: input.snapshot_name,
    });
    std::fs::write(&paths.config_ini, apply_avd_config(&load_template(input.android_root)?, &overrides))?;

    // The pointer the emulator reads to find the AVD by name. `path` must be absolute; `path.rel`
    // is what makes the AVD relocatable, and the emulator prefers it when it resolves.
    let pointer = [
        "avd.ini.encoding=UTF-8".to_owned(),
        format!("path={}", paths.dir.display()),
        format!("path.rel=avd/{}.avd", input.profile.avd_name),
        format!("target=android-{}", input.profile.api_level),
        String::new(),
    ]
    .join("\n");
    std::fs::write(&paths.pointer_ini, pointer)?;

    sync_advanced_features(input.layout, &input.profile.avd_name)?;
    Ok(paths)
}

/// Feature flags the guest boots with.
///
/// `Vulkan = off` is not tidying. The emulator's Vulkan path negotiates with the host driver at
/// startup and hangs on a good number of Windows GPUs when the guest has no window in focus, which
/// presents as a boot that never completes rather than as a graphics error.
///
/// `GLESDynamicVersion = on` lets the guest see the OpenGL ES version the host renderer actually
/// supports. Without it the guest reports ES 2.0 on `-gpu host` (measured; 3.1 with it), and Unity
/// games refuse to start on anything below 3.
pub const ADVANCED_FEATURES: &str = "GLDirectMem = on\nGLESDynamicVersion = on\nVulkan = off\nLogcatPipe = on\n";

/// Writes `advancedFeatures.ini` if it differs from [`ADVANCED_FEATURES`], and says whether it did.
///
/// Run on every start as well as at creation, so an AVD made by an older build picks up a flag
/// added since. The caller has to act on `true` for an AVD that has booted: the guest negotiates
/// these at boot, and a snapshot taken under the old set would bring back the old GL state.
pub fn sync_advanced_features(layout: &SdkLayout, avd_name: &str) -> Result<bool> {
    let file = avd_dir(layout, avd_name).join("advancedFeatures.ini");
    if std::fs::read_to_string(&file).ok().as_deref() == Some(ADVANCED_FEATURES) {
        return Ok(false);
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&file, ADVANCED_FEATURES)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::GpuMode;

    fn android_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../android")
    }

    #[test]
    fn an_avd_is_two_files_written_from_the_template() {
        let root = tempfile::tempdir().unwrap();
        let layout = SdkLayout::new(root.path());
        let profile = crate::env_file::load_profile(&android_root(), "openemu").unwrap();
        let device = crate::env_file::load_device(&android_root(), "generic").unwrap();
        let tuning = GuestTuning { cores: 4, ram_mb: 3072, gpu_mode: GpuMode::Host, accel: true };

        assert!(!avd_exists(&layout, &profile.avd_name));
        let paths = create_avd(&CreateAvdInput {
            layout: &layout,
            android_root: &android_root(),
            profile: &profile,
            device: &device,
            tuning: &tuning,
            snapshot_name: "booted",
        })
        .unwrap();

        assert!(avd_exists(&layout, &profile.avd_name));
        let config = std::fs::read_to_string(&paths.config_ini).unwrap();
        assert!(config.contains("hw.cpu.ncore=4\n"));
        assert!(config.contains("image.sysdir.1=system-images/android-30/openemu/x86_64/\n"));
        let pointer = std::fs::read_to_string(&paths.pointer_ini).unwrap();
        assert!(pointer.contains(&format!("path.rel=avd/{}.avd", profile.avd_name)));
        assert!(pointer.contains("target=android-30"));
        assert!(!sync_advanced_features(&layout, &profile.avd_name).unwrap(), "already current");
    }
}
