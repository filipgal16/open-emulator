//! The first-run steps for the native Windows runtime.
//!
//! Installing a Linux distribution, apt-getting a JDK, syncing a shell backend into it, and
//! checking for `tar.exe` are all gone: archives are unpacked here, natively. What is left is the
//! work that was always the real cost: acceleration, the download, and the first boot.

use std::sync::Arc;

use oe_engine::acceleration::detect_acceleration;
use oe_engine::client::OpenEmuClient;
use oe_engine::download::{http_client, DownloadProgress, ProgressHandler};
use oe_engine::env_file::GuestProfile;
use oe_engine::host::GuestTuning;
use oe_engine::layout::{system_image_path, SdkLayout};
use oe_engine::rom_profile::{recipe_for_profile, rom_params};
use oe_engine::sdk::dependencies::{acquire_dependencies, cleanup, format_bytes, resolve_dependencies};
use oe_engine::{no_log, LogHandler, LogStream};
use oe_formats::builder::{build_rom, rom_key_dir, rom_state, BuildOptions};
use oe_formats::recipe::RomParams;

use crate::setup::{CheckResult, Step};
use crate::{err, Result};

pub type ProfileSource = Arc<dyn Fn() -> Result<GuestProfile> + Send + Sync>;
pub type TuningSource = Arc<dyn Fn(&GuestProfile) -> GuestTuning + Send + Sync>;
pub type ProgressSink = Arc<dyn Fn(u64, u64) + Send + Sync>;

pub struct NativeSetupContext {
    pub layout: SdkLayout,
    pub client: OpenEmuClient,
    /// The profile setup is for, read live: switching profile changes what "downloaded" means.
    pub profile: ProfileSource,
    /// The tuning the engine will start a profile with: the engine's own, not a second
    /// derivation. `None` gives the ROM no facts rather than made-up ones.
    pub tuning: Option<TuningSource>,
    /// Fires as bytes arrive, so the wizard's single bar tracks the real download.
    pub on_progress: Option<ProgressSink>,
}

pub fn build_native_steps(context: NativeSetupContext) -> Vec<Step> {
    let context = Arc::new(context);
    vec![acceleration_step(), sdk_step(context.clone()), provisioned_step(context)]
}

/// What the ROM is told about the guest, from the facts the engine itself will start with.
///
/// Setup can run before acceleration is enabled, and the core count depends on it. That is fine:
/// at the first start the engine sees params that differ from the build's, rebuilds (it takes
/// seconds), and the new ROM id drops any snapshot taken against the old one.
fn params_for(context: &NativeSetupContext, profile: &GuestProfile) -> RomParams {
    context.tuning.as_ref().map(|tuning| rom_params(&tuning(profile))).unwrap_or_default()
}

async fn reboot_pending() -> bool {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(oe_win::system::is_reboot_pending).await.unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn acceleration_step() -> Step {
    Step {
        id: "acceleration",
        label: "Hardware acceleration",
        // Not blocking: without a hypervisor the guest still runs, just slowly. Refusing to
        // continue would be worse than a slow emulator, and the user may not be able to change
        // their firmware.
        blocking: false,
        working: Some("Turning on the Windows Hypervisor Platform. Windows will ask for permission."),
        defer_fix: false,
        check: Arc::new(|| {
            Box::pin(async {
                let state = detect_acceleration().await;
                if state.available {
                    return Ok(CheckResult::pass(state.detail));
                }
                // A staged feature reports success and does nothing until a restart; saying so at
                // the point of failure is the difference between a dead end and a fix.
                if state.fixable && reboot_pending().await {
                    return Ok(CheckResult::warn(
                        "Windows needs a restart to finish enabling acceleration. Restart, then reopen open-emulator.",
                    ));
                }
                Ok(CheckResult::warn(state.detail))
            })
        }),
        fix: Some(Arc::new(|on_log: LogHandler| {
            Box::pin(async move {
                // Only the fix that can actually work. Running DISM when the real problem is a
                // firmware setting burns a UAC prompt and changes nothing.
                if !detect_acceleration().await.fixable {
                    return Ok(());
                }
                enable_hypervisor_platform(on_log).await
            })
        })),
    }
}

#[cfg(windows)]
async fn enable_hypervisor_platform(on_log: LogHandler) -> Result<()> {
    oe_engine::acceleration::enable_whpx(on_log).await
}

#[cfg(not(windows))]
async fn enable_hypervisor_platform(_on_log: LogHandler) -> Result<()> {
    Err(err!("the Windows Hypervisor Platform exists only on Windows"))
}

fn sdk_step(context: Arc<NativeSetupContext>) -> Step {
    let for_check = context.clone();
    Step {
        id: "sdk",
        label: "Android system image",
        blocking: true,
        working: Some("Downloading Android. This is the long one, and it only happens once."),
        defer_fix: false,
        check: Arc::new(move || {
            let context = for_check.clone();
            Box::pin(async move { sdk_check(&context).await })
        }),
        fix: Some(Arc::new(move |on_log| {
            let context = context.clone();
            Box::pin(async move { sdk_fix(&context, on_log).await })
        })),
    }
}

/// The emulator binary *and* the image the selected profile needs. Checking only the emulator was
/// wrong the moment there was more than one profile: switching to another guest sailed past it and
/// failed much later, long after "download Android" was the obvious remedy.
async fn sdk_check(context: &NativeSetupContext) -> Result<CheckResult> {
    let current = (context.profile)()?;
    let recipe = recipe_for_profile(&current)?;
    let layout = &context.layout;
    let have_emulator = layout.emulator.exists() && layout.adb.exists();
    let have_image = system_image_path(layout, &current.image_tag, current.api_level).exists();

    if have_emulator && have_image {
        let Some(recipe) = recipe else { return Ok(CheckResult::pass("Downloaded")) };
        // Any build passes. An outdated one is rebuilt by the engine at the next start, the one
        // moment Android is known to be stopped; failing setup over it would lock the user out of
        // an app whose guest may be running right now.
        let params = params_for(context, &current);
        let sdk_root = layout.sdk_root.clone();
        let name = recipe.display_name.clone();
        let state = tokio::task::spawn_blocking(move || rom_state(&sdk_root, &recipe, None, params))
            .await
            .map_err(|error| err!("checking the ROM stopped unexpectedly: {error}"))??;
        let version = state.manifest.map_or_else(|| "Built".to_owned(), |manifest| format!("{name} {}", manifest.recipe_version));
        return Ok(CheckResult::pass(if state.up_to_date {
            version
        } else {
            format!("{version}: an update is ready and applies at the next start")
        }));
    }
    if let Some(recipe) = recipe.filter(|recipe| have_emulator && system_image_path(layout, &recipe.base_tag, recipe.api_level).exists()) {
        return Ok(CheckResult::fail(format!("{} has not been built yet", recipe.display_name)));
    }
    Ok(CheckResult::fail(if have_emulator {
        format!("The {} system image is not downloaded yet", current.name)
    } else {
        "Not downloaded yet (about 1.2 GB)".to_owned()
    }))
}

async fn sdk_fix(context: &NativeSetupContext, on_log: LogHandler) -> Result<()> {
    let current = (context.profile)()?;
    let recipe = recipe_for_profile(&current)?;
    let layout = &context.layout;
    // A ROM's base is at the profile's own API level: `recipe_for_profile` has just checked that.
    let base_tag = current.base_image_tag.clone().unwrap_or_else(|| current.image_tag.clone());
    let have_base =
        layout.emulator.exists() && layout.adb.exists() && system_image_path(layout, &base_tag, current.api_level).exists();

    if !have_base {
        let plan = resolve_dependencies(&current, &http_client()).await?;
        on_log(LogStream::Stdout, &format!("{} packages, {} total", plan.archives.len(), format_bytes(plan.total_bytes)));
        let on_progress = context.on_progress.clone().map(|sink| -> ProgressHandler {
            Arc::new(move |progress: &DownloadProgress| sink(progress.bytes_done, progress.bytes_total))
        });
        acquire_dependencies(layout, &plan, on_progress, on_log.clone(), false).await?;

        // Only now, with every extraction done. Archives deleted earlier would make one failed
        // extraction cost the whole download again.
        let freed = cleanup(layout, false);
        if freed.bytes_freed > 0 {
            on_log(LogStream::Stdout, &format!("cleaned up {} of installation files", format_bytes(freed.bytes_freed)));
        }
    }

    // Our own ROM is built from the stock image just fetched. See design/openemu-rom.md.
    if let Some(recipe) = recipe {
        on_log(LogStream::Stdout, &format!("building {} from the {} image", recipe.display_name, recipe.base_tag));
        let options = (layout.sdk_root.clone(), rom_key_dir(&layout.root), params_for(context, &current));
        tokio::task::spawn_blocking(move || {
            let (sdk_root, key_dir, params) = options;
            let log_line = |line: &str| on_log(LogStream::Stdout, line);
            build_rom(&BuildOptions { sdk_root, key_dir, recipe, params, force: false, is_running: None, on_log: Some(&log_line) })
                .map(|_| ())
        })
        .await
        .map_err(|error| err!("the ROM build stopped unexpectedly: {error}"))??;
    }
    Ok(())
}

fn provisioned_step(context: Arc<NativeSetupContext>) -> Step {
    let for_check = context.clone();
    Step {
        id: "provisioned",
        label: "Preparing your device",
        // Not blocking, and that is the point. Everything above can finish without a restart, so
        // setup completes and the download is banked; the one thing that genuinely needs a
        // hypervisor is starting Android.
        blocking: false,
        // Out of the auto-run entirely: the wizard hands the user into the app the moment the
        // download is banked, and the core starts this one-time cold boot in the background.
        defer_fix: true,
        working: Some("Starting Android for the first time and saving a snapshot, so later launches are quick."),
        check: Arc::new(move || {
            let context = for_check.clone();
            Box::pin(async move {
                let status = context.client.status(no_log()).await;
                if status.stdout.iter().any(|line| line.starts_with("provisioned_at=")) {
                    return Ok(CheckResult::pass("Ready"));
                }
                // Preparing means booting, and on Windows the emulator will not boot without a
                // hypervisor; it starts and then sits there. Say what is needed instead.
                let acceleration = detect_acceleration().await;
                if !acceleration.available {
                    return Ok(CheckResult::warn(format!("Everything is downloaded. {}", acceleration.detail)));
                }
                Ok(CheckResult::fail("Not prepared yet"))
            })
        }),
        fix: Some(Arc::new(move |on_log| {
            let context = context.clone();
            Box::pin(async move {
                // Skipped rather than failed: the download succeeded, and a red step for something
                // waiting on a restart misrepresents what happened.
                if !detect_acceleration().await.available {
                    return Ok(());
                }
                let result = context.client.provision(on_log).await;
                if !result.success() {
                    let reason = result.stderr.join(" ");
                    return Err(err!("{}", if reason.is_empty() { "the device could not be prepared".to_owned() } else { reason }));
                }
                Ok(())
            })
        })),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use oe_engine::testing::FakeEngine;

    use super::*;

    fn fast() -> GuestProfile {
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

    fn derived() -> GuestProfile {
        GuestProfile {
            name: "openemu".into(),
            system_image: "system-images;android-30;openemu;x86_64".into(),
            image_tag: "openemu".into(),
            base_image_tag: Some("default".into()),
            avd_name: "OpenEmulator_API30_openemu".into(),
            ..fast()
        }
    }

    fn steps(dir: &Path, profile: GuestProfile, status: &[&str]) -> Vec<Step> {
        let engine = Arc::new(FakeEngine::new().with_status(status));
        build_native_steps(NativeSetupContext {
            layout: SdkLayout::new(dir),
            client: OpenEmuClient::new(engine),
            profile: Arc::new(move || Ok(profile.clone())),
            tuning: None,
            on_progress: None,
        })
    }

    fn step<'a>(steps: &'a [Step], id: &str) -> &'a Step {
        steps.iter().find(|step| step.id == id).unwrap()
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }

    #[test]
    fn the_native_wizard_is_acceleration_the_download_and_the_first_boot() {
        let dir = tempfile::tempdir().unwrap();
        let all = steps(dir.path(), fast(), &[]);
        assert_eq!(all.iter().map(|step| step.id).collect::<Vec<_>>(), ["acceleration", "sdk", "provisioned"]);
    }

    #[test]
    fn only_the_download_blocks_and_every_step_offers_a_fix() {
        let dir = tempfile::tempdir().unwrap();
        let all = steps(dir.path(), fast(), &[]);
        // Acceleration is not blocking: a slow guest beats no guest. Preparing the device is not
        // either: it is the only step that needs a hypervisor, so blocking on it would gate the
        // whole download behind a restart.
        assert!(!step(&all, "acceleration").blocking);
        assert!(step(&all, "sdk").blocking);
        assert!(!step(&all, "provisioned").blocking);
        assert!(step(&all, "provisioned").defer_fix);
        assert!(all.iter().all(|step| step.fix.is_some()));
    }

    #[tokio::test]
    async fn the_sdk_check_wants_the_profile_image_not_just_the_emulator_binary() {
        let dir = tempfile::tempdir().unwrap();
        let layout = SdkLayout::new(dir.path());
        let all = steps(dir.path(), fast(), &[]);
        let sdk = step(&all, "sdk");
        assert!(!(sdk.check)().await.unwrap().pass, "nothing installed");

        touch(&layout.emulator);
        touch(&layout.adb);
        let partial = (sdk.check)().await.unwrap();
        assert!(!partial.pass, "the case that used to sail through and fail later");
        assert!(partial.detail.contains("system image is not downloaded"), "{}", partial.detail);

        touch(&system_image_path(&layout, "default", 30));
        assert!((sdk.check)().await.unwrap().pass);
    }

    #[tokio::test]
    async fn a_derived_image_with_its_base_present_still_reports_as_not_built() {
        let dir = tempfile::tempdir().unwrap();
        let layout = SdkLayout::new(dir.path());
        let all = steps(dir.path(), derived(), &[]);
        let sdk = step(&all, "sdk");
        touch(&layout.emulator);
        touch(&layout.adb);
        touch(&system_image_path(&layout, "default", 30));

        let pending = (sdk.check)().await.unwrap();
        assert!(!pending.pass);
        assert!(pending.detail.contains("not been built"), "{}", pending.detail);

        touch(&system_image_path(&layout, "openemu", 30));
        assert!((sdk.check)().await.unwrap().pass);
    }

    #[tokio::test]
    async fn provisioning_is_judged_by_the_marker_the_engine_reports() {
        let dir = tempfile::tempdir().unwrap();
        let unprovisioned = steps(dir.path(), fast(), &["avd=x", "emulator=stopped"]);
        assert!(!(step(&unprovisioned, "provisioned").check)().await.unwrap().pass);
        let ready = steps(dir.path(), fast(), &["avd=x", "provisioned_at=2026-08-24T00:00:00Z"]);
        assert!((step(&ready, "provisioned").check)().await.unwrap().pass);
    }
}
