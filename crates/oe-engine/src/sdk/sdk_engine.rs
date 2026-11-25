//! Google's SDK emulator, as a native Windows process.
//!
//! This is the port of `android/bin/open-emu` and `android/lib/common.sh`, by way of the Electron
//! app's `sdk-engine.ts`. What it inherits is the set of behaviours that were arrived at by
//! failing: the warm path that does not reboot a running guest, the cold-boot fallback that keeps
//! the snapshot rather than deleting it, per-AVD state, and the refusal to let the emulator write a
//! snapshot while quitting.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use oe_formats::builder::{build_rom, read_manifest, rom_key_dir, rom_paths, rom_state, BuildOptions};
use oe_formats::bytes::{js_is_space, split_lines};
use oe_formats::recipe::RomRecipe;
use oe_formats::time::now_iso8601;
use tokio::process::Child;

use crate::env_file::{load_device, load_profile, DeviceIdentity, GuestProfile};
use crate::host::{tune_for_host, GuestTuning, HostFacts, TuningOverrides};
use crate::layout::{avd_dir, avd_state, snapshot_dir, system_image_path, SdkLayout};
use crate::process::{spawn_detached, ProcessRunner, RunOptions};
use crate::quote::posix_quote;
use crate::rom_profile::{recipe_for_profile, rom_params};
use crate::sdk::adb::Adb;
use crate::sdk::adb_wire::ShellSession;
use crate::sdk::avd::{avd_exists, create_avd, sync_advanced_features, CreateAvdInput};
use crate::sdk::avd_config::{apply_avd_config, avd_config_overrides, emulator_args, AvdConfigInput, EmulatorArgsInput};
use crate::sdk::find_process::{find_qemu_pid, find_qemu_pid_blocking, is_emulator_image};
use crate::sdk::provision::{provision_guest, ProvisionInput, QUICK_BOOT_SNAPSHOT};
use crate::{err, fail, CommandResult, LogHandler, LogStream, Result};

/// Quick Boot's own snapshot name.
///
/// Not a name of our choosing: this is the one the emulator writes on a clean exit and restores on
/// the next start. A custom name saved through `adb emu avd snapshot save` and passed back as
/// `-snapshot <name>` is silently ignored by this emulator, which is why warm starts used to cost a
/// full cold boot.
const SNAPSHOT: &str = QUICK_BOOT_SNAPSHOT;

/// How long a guest asked to quit is given before it is ended.
const EXIT_GRACE: Duration = Duration::from_secs(30);

/// How long "no QEMU is running" is believed. With no emulator running at all, a status poll every
/// few seconds would otherwise query the process list every few seconds.
const NOT_FOUND_FOR: Duration = Duration::from_secs(5);

const DEVICE_POLL: Duration = Duration::from_millis(1000);
const BOOT_POLL: Duration = Duration::from_millis(500);

/// A setting read at the moment it is needed, so changing it in Settings does not need a restart.
pub type Live<T> = Arc<dyn Fn() -> T + Send + Sync>;

/// What the user asked for in Settings. `None` means "decide from this machine": the measured
/// default, or the profile's own hint.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Performance {
    pub cores: Option<f64>,
    pub ram_mb: Option<f64>,
}

pub struct SdkEngineOptions {
    pub layout: SdkLayout,
    /// The tree holding `profiles/`, `devices/` and `config/`.
    pub android_root: PathBuf,
    pub profile: Option<String>,
    /// Which device identity the guest reports as.
    pub device: Option<Live<String>>,
    pub performance: Option<Live<Performance>>,
    /// The user's interface size, as a panel density. `None` keeps the device's own.
    pub density: Option<Live<Option<u32>>>,
    /// Whether a hypervisor the emulator can use is available. Decides accel and renderer.
    pub accelerated: Live<bool>,
    /// False forces `-no-window`; true lets the emulator paint a window we can embed.
    pub windowed: bool,
    /// True shows the emulator's own window, toolbar and all. False, the default, runs it with no
    /// window and its screen served over gRPC, for the app to draw Android itself.
    pub own_window: Option<Live<bool>>,
    pub on_log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

/// Drives one emulator. Cheap to clone: every clone is the same engine.
#[derive(Clone)]
pub struct SdkEngine {
    shared: Arc<Shared>,
}

struct Shared {
    options: SdkEngineOptions,
    adb: Adb,
    state: Mutex<State>,
    /// The guest shell input events are written into, and the serial it belongs to.
    input: tokio::sync::Mutex<Option<(String, ShellSession)>>,
}

#[derive(Default)]
struct State {
    /// The launcher this process started, while it has one.
    emulator: Option<Child>,
    emulator_pid: Option<u32>,
    serial: Option<String>,
    profile_name: Option<String>,
    not_found_until: Option<Instant>,
    /// Set while provisioning, so a start inside it that detects a ROM change does not provision
    /// a second time on its own.
    provisioning: bool,
}

/// What one attempt at a start came to.
enum Attempt {
    Done(CommandResult),
    /// The snapshot was refused: boot again, cold, keeping the snapshot.
    RetryCold,
}

impl SdkEngine {
    pub fn new(options: SdkEngineOptions) -> SdkEngine {
        let adb = Adb::new(options.layout.adb.clone(), Arc::new(ProcessRunner::new()));
        let state = State { profile_name: options.profile.clone(), ..State::default() };
        let input = tokio::sync::Mutex::new(None);
        SdkEngine { shared: Arc::new(Shared { options, adb, state: Mutex::new(state), input }) }
    }

    pub fn layout(&self) -> &SdkLayout {
        &self.shared.options.layout
    }

    pub fn adb(&self) -> &Adb {
        &self.shared.adb
    }

    /// One shell to cross: adb takes argv directly, so only the guest's `sh` re-parses. Quoting
    /// twice here would leave the outer quotes inside the value.
    pub fn quote_guest_arg(&self, value: &str) -> String {
        posix_quote(value)
    }

    pub fn set_profile(&self, profile: Option<String>) {
        let mut state = self.state();
        state.profile_name = profile;
        // The serial belongs to whichever guest was running; it means nothing for a different AVD,
        // and nor does the input channel open to it.
        state.serial = None;
        if let Ok(mut input) = self.shared.input.try_lock() {
            *input = None;
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.shared.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn log(&self, message: &str) {
        if let Some(on_log) = &self.shared.options.on_log {
            on_log(&format!("[sdk] {message}"));
        }
    }

    // ── Configuration ────────────────────────────────────────────────────────────────────────

    pub fn profile(&self) -> Result<GuestProfile> {
        let name = self.state().profile_name.clone();
        load_profile(&self.shared.options.android_root, name.as_deref().unwrap_or("openemu"))
    }

    /// The identity the guest reports as, with the user's interface size laid over its panel.
    ///
    /// The density is the one part of the panel worth exposing. The window decides the pixels (the
    /// display follows it), and what is left is how many of them a button takes, which is what a
    /// person means by "make everything bigger".
    pub fn device(&self) -> Result<DeviceIdentity> {
        let options = &self.shared.options;
        let name = options.device.as_ref().map_or_else(|| "generic".to_owned(), |device| device());
        let mut device = load_device(&options.android_root, &name)?;
        if let Some(density) = options.density.as_ref().and_then(|density| density()) {
            device.lcd_density = Some(density);
        }
        Ok(device)
    }

    fn host_facts(&self) -> HostFacts {
        let options = &self.shared.options;
        HostFacts {
            cpus: std::thread::available_parallelism().map_or(1, |n| u32::try_from(n.get()).unwrap_or(u32::MAX)),
            total_ram_mb: total_ram_mb(),
            accelerated: (options.accelerated)(),
            has_window: options.windowed,
        }
    }

    /// What a start of this profile gives the guest.
    ///
    /// Public because setup builds the ROM before there is any start, and a ROM that rewrites the
    /// ARM translator's cpuinfo has to be told the very core count this hands `hw.cpu.ncore`;
    /// deriving it anywhere else could disagree.
    ///
    /// Three voices, in order: what the user set in Settings, then the profile's own hint (RAM
    /// only), then the measured default for this machine.
    pub fn guest_tuning(&self, profile: &GuestProfile) -> GuestTuning {
        let user = self.shared.options.performance.as_ref().map(|performance| performance()).unwrap_or_default();
        tune_for_host(
            &self.host_facts(),
            TuningOverrides {
                cores: user.cores,
                ram_mb: user.ram_mb.or(profile.ram_mb.map(f64::from)),
                gpu_mode: None,
            },
        )
    }

    /// The same, as if nothing were set in Settings: what "Automatic" means for this profile.
    pub fn automatic_tuning(&self, profile: &GuestProfile) -> GuestTuning {
        tune_for_host(&self.host_facts(), TuningOverrides { ram_mb: profile.ram_mb.map(f64::from), ..TuningOverrides::default() })
    }

    fn state_dir(&self, avd_name: &str) -> Result<PathBuf> {
        let dir = avd_state(self.layout(), avd_name);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    fn has_snapshot(&self, avd_name: &str) -> bool {
        snapshot_dir(self.layout(), avd_name, SNAPSHOT).exists()
    }

    fn pid_file(&self, avd_name: &str) -> PathBuf {
        avd_state(self.layout(), avd_name).join("emulator.pid")
    }

    // ── Is it running? ───────────────────────────────────────────────────────────────────────

    /// Is an emulator running for this AVD, including one this process did not start?
    ///
    /// The in-memory handle is not enough, and the gap is not theoretical. Close the app while
    /// Android is running and reopen it, and the handle is gone while the emulator is very much
    /// still there. Two things then go wrong: `status` reports the guest as stopped while it is
    /// plainly running, and `start` misses the warm path and launches a **second** emulator against
    /// the same AVD, which corrupts the userdata both instances are writing.
    ///
    /// So the pid file is read back and the process checked: that it is running, and that it is
    /// still an emulator rather than an unrelated program that has since been given the same pid.
    /// When the file is missing or stale, the process list is searched: the pid this app spawns is
    /// the launcher's, and the launcher dies with this app's stdio pipes while QEMU keeps running
    /// the guest. A hit is written back so the next poll is a file read again.
    pub async fn running_pid(&self, avd_name: &str) -> Option<u32> {
        if let Some(pid) = self.known_pid(avd_name) {
            return Some(pid);
        }
        if self.recently_not_found() {
            return None;
        }
        let found = find_qemu_pid(avd_name).await;
        self.remember_search(avd_name, found)
    }

    /// [`Self::running_pid`] for a caller on a worker thread: the ROM build asks it.
    fn running_pid_blocking(&self, avd_name: &str) -> Option<u32> {
        if let Some(pid) = self.known_pid(avd_name) {
            return Some(pid);
        }
        if self.recently_not_found() {
            return None;
        }
        let found = find_qemu_pid_blocking(avd_name);
        self.remember_search(avd_name, found)
    }

    fn known_pid(&self, avd_name: &str) -> Option<u32> {
        self.live_child_pid().or_else(|| self.recorded_pid(avd_name))
    }

    fn live_child_pid(&self) -> Option<u32> {
        let mut state = self.state();
        let pid = state.emulator_pid?;
        let child = state.emulator.as_mut()?;
        matches!(child.try_wait(), Ok(None)).then_some(pid)
    }

    fn recently_not_found(&self) -> bool {
        self.state().not_found_until.is_some_and(|until| Instant::now() < until)
    }

    fn remember_search(&self, avd_name: &str, found: Option<u32>) -> Option<u32> {
        match found {
            Some(pid) => {
                self.record_pid(avd_name, pid);
                Some(pid)
            }
            None => {
                self.state().not_found_until = Some(Instant::now() + NOT_FOUND_FOR);
                None
            }
        }
    }

    fn recorded_pid(&self, avd_name: &str) -> Option<u32> {
        let file = self.pid_file(avd_name);
        let pid: u32 = std::fs::read_to_string(&file).ok()?.trim().parse().ok()?;
        if pid > 0 && is_emulator_process(pid) {
            return Some(pid);
        }
        // The process has exited, or the pid now belongs to something else. Clear the stale file
        // so this is not re-checked on every status poll.
        let _ = std::fs::remove_file(&file);
        None
    }

    fn record_pid(&self, avd_name: &str, pid: u32) {
        let written = self.state_dir(avd_name).and_then(|_| Ok(std::fs::write(self.pid_file(avd_name), pid.to_string())?));
        if let Err(error) = written {
            self.log(&format!("could not record the emulator's pid: {error}"));
        }
    }

    // ── Markers ──────────────────────────────────────────────────────────────────────────────

    fn provisioned_at(&self, avd_name: &str) -> Option<String> {
        read_marker(&avd_state(self.layout(), avd_name).join("provisioned_at"))
    }

    /// Records the moment provisioning finished, which is what `status` reports as
    /// `provisioned_at`, and, for our own ROM, which build it finished against.
    ///
    /// The ROM id is written here and nowhere earlier. Written before the invalidation it guards, a
    /// crash in between would leave the new id beside the old snapshot, and the mismatch that
    /// should discard that snapshot would never be seen again.
    pub fn mark_provisioned(&self, avd_name: &str) -> Result<()> {
        let dir = self.state_dir(avd_name)?;
        std::fs::write(dir.join("provisioned_at"), now_iso8601())?;
        let profile = self.profile()?;
        if let Some(recipe) = recipe_for_profile(&profile)? {
            if profile.avd_name == avd_name {
                if let Some(rom_id) = self.current_rom_id(&recipe).filter(|id| !id.is_empty()) {
                    std::fs::write(dir.join("rom_id"), rom_id)?;
                }
            }
        }
        Ok(())
    }

    // ── Our own ROM ──────────────────────────────────────────────────────────────────────────

    /// Builds the ROM if it is missing, was made from another recipe, builder, or base, or was told
    /// a different core count than this start gives the guest.
    async fn ensure_rom(&self, profile: &GuestProfile, recipe: &RomRecipe, tuning: &GuestTuning, on_log: LogHandler) -> Result<()> {
        let engine = self.clone();
        let recipe = recipe.clone();
        let avd_name = profile.avd_name.clone();
        let params = rom_params(tuning);
        let build = tokio::task::spawn_blocking(move || -> Result<()> {
            let layout = engine.layout();
            let state = rom_state(&layout.sdk_root, &recipe, None, params)?;
            if state.up_to_date {
                return Ok(());
            }
            engine.log(&format!("building {}: {}", recipe.display_name, state.reason));
            let is_running = || engine.running_pid_blocking(&avd_name).is_some();
            let log_line = |line: &str| on_log(LogStream::Stdout, line);
            build_rom(&BuildOptions {
                sdk_root: layout.sdk_root.clone(),
                key_dir: rom_key_dir(&layout.root),
                recipe: recipe.clone(),
                params,
                force: false,
                is_running: Some(&is_running),
                on_log: Some(&log_line),
            })?;
            Ok(())
        });
        build.await.map_err(|error| err!("the ROM build stopped unexpectedly: {error}"))?
    }

    /// Discards what an AVD remembers of a *different* ROM build: its Quick Boot snapshot, and the
    /// qcow2 overlays over `system` and `vendor`.
    ///
    /// A snapshot is RAM captured against the old `/system`; restoring it onto the new one is
    /// undefined. The overlays would mask the new base wherever the old one was written to.
    /// Userdata is kept, as an OTA keeps it: `userdata-qemu.img.qcow2` and
    /// `encryptionkey.img.qcow2` are the user's apps and keys. Runs before `sync_avd_config`, which
    /// would otherwise point the AVD at a snapshot about to be deleted.
    fn forget_stale_rom(&self, avd_name: &str, recipe: &RomRecipe) -> Result<bool> {
        let Some(current) = self.current_rom_id(recipe).filter(|id| !id.is_empty()) else { return Ok(false) };
        if self.recorded_rom_id(avd_name).as_deref() == Some(current.as_str()) || !self.has_booted(avd_name) {
            return Ok(false);
        }
        self.log(&format!(
            "ROM changed since {avd_name} was provisioned; discarding its snapshot and system overlays, keeping userdata"
        ));
        let dir = avd_dir(self.layout(), avd_name);
        remove_file_if_present(&dir.join("system.img.qcow2"))?;
        remove_file_if_present(&dir.join("vendor.img.qcow2"))?;
        self.forget_snapshot(avd_name)?;
        Ok(true)
    }

    /// Brings `advancedFeatures.ini` up to date, and treats a change on a booted AVD the way a ROM
    /// change is treated, minus the overlays: the snapshot goes and the AVD is provisioned again.
    ///
    /// The feature set is negotiated when the guest boots, GLES version included, so a snapshot
    /// taken under the old one would restore the old GL state onto a guest launched with the new
    /// flags. The cold-retry path does not cover that: a restore that succeeds with stale state
    /// refuses nothing.
    fn sync_features(&self, avd_name: &str) -> Result<bool> {
        if !avd_exists(self.layout(), avd_name) {
            return Ok(false);
        }
        // Checked before the write, which is what makes the AVD look different afterwards.
        let booted = self.has_booted(avd_name);
        if !sync_advanced_features(self.layout(), avd_name)? || !booted {
            return Ok(false);
        }
        self.log(&format!("emulator features changed for {avd_name}; discarding its snapshot, keeping userdata"));
        self.forget_snapshot(avd_name)?;
        Ok(true)
    }

    /// Drops the snapshot of an AVD whose hardware is about to change: cores, memory, the panel,
    /// the renderer.
    ///
    /// A snapshot is the guest's RAM and device state as that hardware left it, and the emulator
    /// refuses to restore one onto different hardware. The cold-retry path would then boot it, and
    /// keep the snapshot, so every later start would be refused and cold-booted the same way.
    ///
    /// Decided by comparing what `config.ini` says now with what this start is about to write, so
    /// it covers every source of change alike. Runs before `sync_avd_config`, which overwrites the
    /// evidence.
    fn forget_other_hardware(&self, profile: &GuestProfile, tuning: &GuestTuning) -> Result<bool> {
        let avd_name = &profile.avd_name;
        if !avd_exists(self.layout(), avd_name) || !self.has_booted(avd_name) {
            return Ok(false);
        }
        let device = self.device()?;
        let wanted = avd_config_overrides(&AvdConfigInput {
            profile,
            device: &device,
            tuning,
            has_snapshot: false,
            snapshot_name: SNAPSHOT,
        });
        let Ok(current) = std::fs::read_to_string(avd_dir(self.layout(), avd_name).join("config.ini")) else {
            return Ok(false);
        };
        let mut now = HashMap::new();
        for line in split_lines(&current) {
            if let Some(at) = line.find('=').filter(|&at| at > 0) {
                now.insert(line[..at].trim_matches(js_is_space), line[at + 1..].trim_matches(js_is_space));
            }
        }

        // Only the keys that describe hardware. The `fastboot.*` ones follow the snapshot's
        // presence and change on their own.
        let changed: Vec<String> = wanted
            .iter()
            .filter(|(key, value)| key.starts_with("hw.") && now.get(key.as_str()) != Some(&value.as_str()))
            .map(|(key, value)| format!("{key} {} → {value}", now.get(key.as_str()).unwrap_or(&"(unset)")))
            .collect();
        if changed.is_empty() {
            return Ok(false);
        }
        self.log(&format!(
            "hardware changed for {avd_name} ({}); discarding its snapshot, keeping userdata",
            changed.join(", ")
        ));
        self.forget_snapshot(avd_name)?;
        Ok(true)
    }

    /// A brand-new AVD has nothing to forget; recording starts at its first provision.
    fn has_booted(&self, avd_name: &str) -> bool {
        let dir = avd_dir(self.layout(), avd_name);
        ["userdata-qemu.img", "snapshots", "system.img.qcow2"].iter().any(|name| dir.join(name).exists())
    }

    /// Drops the Quick Boot snapshot and the marker that vouches for it. The marker goes too, so a
    /// re-provision that fails is retried by the next launch's background provisioning instead of
    /// the guest cold-booting forever under a marker that says it is ready.
    fn forget_snapshot(&self, avd_name: &str) -> Result<()> {
        let snapshots = avd_dir(self.layout(), avd_name).join("snapshots");
        match std::fs::remove_dir_all(&snapshots) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        remove_file_if_present(&self.state_dir(avd_name)?.join("provisioned_at"))
    }

    fn current_rom_id(&self, recipe: &RomRecipe) -> Option<String> {
        read_manifest(&rom_paths(&self.layout().sdk_root, recipe).image_dir).map(|manifest| manifest.rom_id)
    }

    fn recorded_rom_id(&self, avd_name: &str) -> Option<String> {
        read_marker(&avd_state(self.layout(), avd_name).join("rom_id"))
    }

    /// Whether the AVD's provisioning still stands. For our own ROM it has to have been done
    /// against *this* build: a marker left from an earlier ROM would have the app skip the one
    /// provision that brings back a fast start.
    fn is_provisioned(&self, profile: &GuestProfile, recipe: Option<&RomRecipe>) -> Option<String> {
        let at = self.provisioned_at(&profile.avd_name)?;
        let Some(recipe) = recipe else { return Some(at) };
        (self.recorded_rom_id(&profile.avd_name) == self.current_rom_id(recipe)).then_some(at)
    }

    /// Brings `config.ini` in line with the profile, the device, and this host's tuning.
    ///
    /// Run before every start, not only at creation: cores, RAM, and the renderer are
    /// host-dependent, and `hw.gpu.mode` in particular has to agree with the `-gpu` flag or the
    /// snapshot this boot writes cannot be loaded by the next one.
    fn sync_avd_config(&self, profile: &GuestProfile, tuning: &GuestTuning) -> Result<()> {
        let device = self.device()?;
        // An AVD is only two configuration files; avdmanager used to write them, and lived in the
        // cmdline-tools the native runtime no longer downloads.
        if !avd_exists(self.layout(), &profile.avd_name) {
            create_avd(&CreateAvdInput {
                layout: self.layout(),
                android_root: &self.shared.options.android_root,
                profile,
                device: &device,
                tuning,
                snapshot_name: SNAPSHOT,
            })?;
            self.log(&format!("created AVD {}", profile.avd_name));
            return Ok(());
        }
        let config_path = avd_dir(self.layout(), &profile.avd_name).join("config.ini");
        let overrides = avd_config_overrides(&AvdConfigInput {
            profile,
            device: &device,
            tuning,
            has_snapshot: self.has_snapshot(&profile.avd_name),
            snapshot_name: SNAPSHOT,
        });
        let current = std::fs::read_to_string(&config_path)?;
        std::fs::write(&config_path, apply_avd_config(&current, &overrides))?;
        Ok(())
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

    /// Starts the guest, or adopts the one already running. `cold` boots from scratch instead of
    /// restoring the snapshot.
    pub async fn start(&self, on_log: LogHandler, cold: bool) -> CommandResult {
        let mut cold = cold;
        loop {
            match self.start_once(on_log.clone(), cold).await {
                Ok(Attempt::Done(result)) => return result,
                // A failed restore is recoverable, so it retries cold, but it must NOT delete the
                // snapshot. Deleting it turns one bad restore into a mandatory re-provision.
                Ok(Attempt::RetryCold) if !cold => cold = true,
                Ok(Attempt::RetryCold) => return failed("the emulator refused to boot"),
                Err(error) => return failed(error.0),
            }
        }
    }

    async fn start_once(&self, on_log: LogHandler, cold: bool) -> Result<Attempt> {
        let profile = self.profile()?;
        let avd_name = profile.avd_name.clone();
        let tuning = self.guest_tuning(&profile);
        let recipe = recipe_for_profile(&profile)?;
        let emulator = self.layout().emulator.clone();

        if !emulator.exists() {
            return done_failing(format!("emulator not installed: expected {}", emulator.display()));
        }

        // Warm path: a guest that is already up is not rebooted. Reconnecting to it is the whole
        // reason `start` is safe to call from a button. Adopted on adb's word plus a live pid, not
        // on holding the child handle: after an app restart the handle is gone but the emulator
        // is not, and starting a second one against the same AVD corrupts the userdata both write.
        let existing = self.adb().wait_for_device(Duration::from_secs(2), DEVICE_POLL).await;
        if let Some(existing) = existing {
            if self.running_pid(&avd_name).await.is_some() {
                self.log(&format!("already running on {existing}: warm path, no reboot"));
                let result = ok(vec![format!("adb_device={existing}")]);
                self.state().serial = Some(existing);
                return Ok(Attempt::Done(result));
            }
        }

        // Our own ROM is built here as well as by setup: this is the one moment the guest is known
        // to be stopped, so an app update that changed the recipe lands at the next start rather
        // than needing Android closed at exactly the time setup happens to run.
        if let Some(recipe) = &recipe {
            if let Err(error) = self.ensure_rom(&profile, recipe, &tuning, on_log.clone()).await {
                return done_failing(format!("could not build {}: {}", profile.name, error.0));
            }
        }
        if !system_image_path(self.layout(), &profile.image_tag, profile.api_level).exists() {
            return done_failing(format!("the {} system image is not downloaded yet", profile.name));
        }

        // A start that just threw away a stale snapshot provisions again once booted, so the update
        // costs one slow start rather than turning every later one into a cold boot. All of these
        // run before `sync_avd_config`, which decides from the snapshot's presence whether to point
        // the AVD at it.
        let rom_changed = match &recipe {
            Some(recipe) => self.forget_stale_rom(&avd_name, recipe)?,
            None => false,
        };
        let features_changed = self.sync_features(&avd_name)?;
        let hardware_changed = self.forget_other_hardware(&profile, &tuning)?;
        let reprovision = (rom_changed || features_changed || hardware_changed) && !self.state().provisioning;

        self.sync_avd_config(&profile, &tuning)?;

        let use_snapshot = !cold && self.has_snapshot(&avd_name) && tuning.accel;
        let device = self.device()?;
        let args = emulator_args(&EmulatorArgsInput {
            avd_name: &avd_name,
            tuning: &tuning,
            device: &device,
            use_snapshot: use_snapshot.then_some(SNAPSHOT),
            headless: !self.shared.options.windowed,
            writable_system: false,
            native_display: (!self.shared.options.own_window.as_ref().is_some_and(|own| own()))
                .then(crate::grpc::free_port)
                .flatten(),
        });

        self.log(&format!(
            "starting emulator ({}, gpu={}, accel={})",
            if use_snapshot { "snapshot" } else { "cold" },
            tuning.gpu_mode.name(),
            if tuning.accel { "on" } else { "off" }
        ));

        // The emulator registers with adb at spawn. If the server is not already listening on
        // 5037, it logs "Unable to connect to adb daemon" and the serial stays `offline` forever.
        self.adb().start_server(on_log.clone()).await;

        let refusals = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = refusals.clone();
        let forward = on_log.clone();
        let watch: LogHandler = Arc::new(move |stream, line| {
            if is_snapshot_refusal(line) {
                seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(line.to_owned());
            }
            forward(stream, line);
        });
        let layout = self.layout();
        let options = RunOptions::args(&args)
            .env("ANDROID_SDK_ROOT", &layout.sdk_root)
            .env("ANDROID_HOME", &layout.sdk_root)
            .env("ANDROID_AVD_HOME", &layout.avd_home)
            // Its settings and crash reports: beside the AVDs, not in the user's profile.
            .env("ANDROID_EMULATOR_HOME", layout.root.join("home").join(".android"))
            .on_log(watch);
        // The emulator does not create its home: without it, it cannot write the discovery
        // file the app reads the gRPC address from, and quietly falls back to the profile.
        let emulator_home = layout.root.join("home").join(".android");
        let _ = std::fs::create_dir_all(&emulator_home);
        // adb on Windows always keeps its key pair in the user's profile (it ignores every
        // variable), and the emulator hands the guest the public half from its own home. Without
        // a copy there, Android never trusts adb, which then sees the device `offline` for good.
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let _ = std::fs::copy(PathBuf::from(profile).join(".android").join("adbkey.pub"), emulator_home.join("adbkey.pub"));
        }
        let launched = spawn_detached(&emulator, options)?;
        let pid = launched.pid;
        {
            let mut state = self.state();
            state.emulator = Some(launched.child);
            state.emulator_pid = pid;
        }
        if let Some(pid) = pid {
            self.record_pid(&avd_name, pid);
        }

        // Generous, because a first boot from a slow disk is slow: from a USB stick it took eight
        // minutes to boot fully, and giving up at five left a guest that was about to finish.
        let timeout = Duration::from_secs(if use_snapshot { 120 } else { 600 });
        let Some(serial) = self.adb().wait_for_device(timeout, DEVICE_POLL).await else {
            return done_failing("the emulator started but no adb device appeared");
        };
        self.state().serial = Some(serial.clone());

        // Swap the launcher's pid for QEMU's. The launcher does not survive this app; QEMU does,
        // and it is QEMU that the next app instance has to find, adopt, and embed.
        if let Some(qemu) = find_qemu_pid(&avd_name).await {
            self.record_pid(&avd_name, qemu);
        }

        let refused = !refusals.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_empty();
        if use_snapshot && refused {
            self.log("snapshot restore failed: cold booting, snapshot kept for the next attempt");
            self.stop(on_log).await;
            return Ok(Attempt::RetryCold);
        }

        let boot_timeout = Duration::from_secs(if tuning.accel { 900 } else { 1800 });
        if !self.adb().wait_for_boot(&serial, boot_timeout, BOOT_POLL).await {
            return done_failing("Android did not finish booting");
        }

        self.log(&format!("booted on {serial}"));
        if reprovision {
            self.log(if rom_changed {
                "provisioning again, against the new ROM"
            } else if features_changed {
                "provisioning again, with the new emulator features"
            } else {
                "provisioning again, on the new hardware"
            });
            let provisioned = self.provision_boxed(on_log).await;
            // The guest is up either way; a failed re-provision only costs the fast start, and the
            // next launch's background provisioning tries again because the ROM id was not recorded.
            if !provisioned.success() {
                self.log(&format!("re-provisioning failed: {}", provisioned.stderr.join(" ")));
            }
        }
        Ok(Attempt::Done(ok(vec![format!("adb_device={serial}"), "boot_completed=1".into()])))
    }

    /// Stops the guest: asked first, ended only if it will not go.
    pub async fn stop(&self, on_log: LogHandler) -> CommandResult {
        let profile = match self.profile() {
            Ok(profile) => profile,
            Err(error) => return failed(error.0),
        };
        let avd_name = profile.avd_name;

        // Ask first. A hard kill can interrupt qcow2 or snapshot writes still in flight, which is
        // exactly how the warm-boot path used to destroy its own snapshot.
        let serial = self.state().serial.clone();
        if let Some(serial) = &serial {
            self.adb().emu_kill(serial, on_log).await;
        }

        let had_child = self.state().emulator.is_some();
        if had_child && !self.wait_for_child_exit(EXIT_GRACE).await {
            self.log("emulator still alive after 30s; terminating");
            self.kill_child();
            self.wait_for_child_exit(Duration::from_secs(5)).await;
        }

        // A guest this process did not start has no child handle, so it is found by its pid, and
        // given the same grace a child gets once asked to quit, since ending it at once would
        // interrupt the very writes asking was meant to protect. One this process did start can
        // outlast its launcher too: QEMU is the launcher's child, not this app's.
        if let Some(pid) = self.running_pid(&avd_name).await {
            let gone = serial.is_some() && !had_child && wait_for_pid_exit(pid, EXIT_GRACE).await;
            if !gone && !end_process(pid) {
                self.log(&format!("could not end the emulator process {pid}"));
            }
        }

        {
            let mut state = self.state();
            state.emulator = None;
            state.emulator_pid = None;
            state.serial = None;
        }
        *self.shared.input.lock().await = None;
        let _ = std::fs::remove_file(self.pid_file(&avd_name));
        ok(vec!["emulator=stopped".into()])
    }

    async fn wait_for_child_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.child_has_exited() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn child_has_exited(&self) -> bool {
        match self.state().emulator.as_mut() {
            None => true,
            Some(child) => !matches!(child.try_wait(), Ok(None)),
        }
    }

    fn kill_child(&self) {
        if let Some(child) = self.state().emulator.as_mut() {
            let _ = child.start_kill();
        }
    }

    /// The `key=value` lines the UI reads.
    ///
    /// Shaped to match what `open-emu status` printed, and read by a parser that is deliberately
    /// tolerant of lines that are absent: a missing line leaves a field at its default rather than
    /// reporting "not provisioned" and sending someone through a re-provision they did not need.
    pub async fn status(&self, _on_log: LogHandler) -> CommandResult {
        let (profile, recipe) = match self.profile().and_then(|profile| Ok((recipe_for_profile(&profile)?, profile))) {
            Ok((recipe, profile)) => (profile, recipe),
            Err(error) => return failed(error.0),
        };
        let avd_name = &profile.avd_name;

        let mut lines = vec![format!("avd={avd_name}")];
        // From the pid file, not just the in-memory handle: otherwise a guest that outlived an app
        // restart is reported as stopped while it is plainly running.
        let pid = self.running_pid(avd_name).await;
        lines.push(format!("emulator={}", if pid.is_some() { "running" } else { "stopped" }));
        if let Some(pid) = pid {
            lines.push(format!("pid={pid}"));
        }

        let known = self.state().serial.clone();
        let serial = match known {
            Some(serial) => Some(serial),
            None => self.adb().devices().await.ok().and_then(|serials| serials.into_iter().next()),
        };
        lines.push(format!("adb_device={}", serial.as_deref().unwrap_or("none")));

        if let Some(serial) = serial {
            self.state().serial = Some(serial.clone());
            let adb = self.adb();
            let (boot, release, sdk) = tokio::join!(
                adb.getprop(&serial, "sys.boot_completed"),
                adb.getprop(&serial, "ro.build.version.release"),
                adb.getprop(&serial, "ro.build.version.sdk"),
            );
            lines.push(format!("boot_completed={}", boot.as_deref().unwrap_or("unknown")));
            lines.push(format!(
                "android={} api={}",
                release.as_deref().unwrap_or("unknown"),
                sdk.as_deref().unwrap_or("unknown")
            ));
        }

        lines.push(format!("snapshot={SNAPSHOT} present={}", if self.has_snapshot(avd_name) { "yes" } else { "no" }));
        if let Some(recipe) = &recipe {
            if let Some(manifest) = read_manifest(&rom_paths(&self.layout().sdk_root, recipe).image_dir) {
                let id: String = manifest.rom_id.chars().take(16).collect();
                lines.push(format!("rom={}/{} id={id}", manifest.recipe_id, manifest.recipe_version));
            }
        }
        if let Some(at) = self.is_provisioned(&profile, recipe.as_ref()) {
            lines.push(format!("provisioned_at={at}"));
        }
        ok(lines)
    }

    pub async fn doctor(&self, on_log: LogHandler) -> CommandResult {
        let status = self.status(on_log).await;
        let layout = self.layout();
        let present = |path: &Path| if path.exists() { "present" } else { "missing" };
        let mut lines = status.stdout;
        lines.push(format!("emulator_binary={}", present(&layout.emulator)));
        lines.push(format!("adb_binary={}", present(&layout.adb)));
        lines.push(format!(
            "acceleration={}",
            if (self.shared.options.accelerated)() { "available" } else { "missing: the guest will be very slow" }
        ));
        ok(lines)
    }

    /// First boot, guest tuning, then a snapshot so later starts are quick. Safe to re-run.
    pub async fn provision(&self, on_log: LogHandler) -> CommandResult {
        let profile = match self.profile() {
            Ok(profile) => profile,
            Err(error) => return failed(error.0),
        };

        // Marks the start below as part of a provision, so a ROM change it detects does not make
        // it provision a second time on its own.
        let _provisioning = Provisioning::begin(self);

        let known = self.state().serial.clone();
        if known.is_none() {
            let started = self.start(on_log.clone(), true).await;
            if !started.success() {
                return started;
            }
        }
        let serial = self.state().serial.clone();
        let Some(serial) = serial else { return failed("no guest to provision") };

        let log = |message: &str| self.log(message);
        let result = provision_guest(ProvisionInput {
            adb: self.adb(),
            serial: &serial,
            profile: &profile,
            accelerated: (self.shared.options.accelerated)(),
            on_log,
            log: &log,
        })
        .await;
        if result.success() {
            if let Err(error) = self.mark_provisioned(&profile.avd_name) {
                self.log(&format!("could not record the provisioning: {}", error.0));
            }
        }
        result
    }

    /// `provision`, boxed: a start can provision and a provision can start, and a future that
    /// contains itself has no size.
    fn provision_boxed(&self, on_log: LogHandler) -> Pin<Box<dyn Future<Output = CommandResult> + Send + '_>> {
        Box::pin(self.provision(on_log))
    }

    // ── Guest access ─────────────────────────────────────────────────────────────────────────

    async fn require_serial(&self) -> Option<String> {
        let known = self.state().serial.clone();
        if known.is_some() {
            return known;
        }
        let found = self.adb().devices().await.ok().and_then(|serials| serials.into_iter().next());
        self.state().serial = found.clone();
        found
    }

    /// `adb shell <command>`. The caller quotes its own arguments, with [`Self::quote_guest_arg`].
    pub async fn shell(&self, command: &str, on_log: LogHandler, timeout: Duration) -> CommandResult {
        let Some(serial) = self.require_serial().await else { return failed("no running guest") };
        settle(self.adb().shell(&serial, command, on_log, timeout).await)
    }

    /// Types a string into the guest's focused field without putting it on a command line.
    ///
    /// There is only one shell between here and the guest, the guest's own, so the value is
    /// quoted once for that. It goes to the adb server over its socket, so no process on this
    /// machine ever has it on its command line, which is the property that matters.
    pub async fn type_secret(&self, value: &str, on_log: LogHandler, timeout: Duration) -> CommandResult {
        let Some(serial) = self.require_serial().await else { return failed("no running guest") };
        let command = format!("input text {}", posix_quote(value));
        settle(self.adb().shell(&serial, &command, on_log, timeout).await)
    }

    /// Sends one `input …` command down a guest shell that stays open between taps.
    ///
    /// The Electron app started `adb.exe shell input …` for every tap: a process start on the
    /// host before the guest saw anything, and a place in the command queue behind whatever else
    /// was running, an install included. The shell is opened once and reopened if it has closed;
    /// only when no shell can be opened at all does a command go the slow way, on its own.
    pub async fn send_input(&self, command: &str) -> bool {
        let Some(serial) = self.require_serial().await else { return false };
        let mut channel = self.shared.input.lock().await;
        for _attempt in 0..2 {
            let reusable = matches!(&*channel, Some((open_to, session)) if *open_to == serial && session.is_open());
            if !reusable {
                *channel = self.adb().open_shell(&serial).await.ok().map(|session| (serial.clone(), session));
            }
            let Some((_, session)) = channel.as_mut() else { break };
            if session.send(command).await.is_ok() {
                return true;
            }
            *channel = None;
        }
        drop(channel);
        self.shell(command, crate::no_log(), Duration::from_secs(10)).await.success()
    }

    /// Installs an APK from a path on the Windows filesystem. The path is one argv entry, so spaces
    /// and quotes in it need no escaping at all.
    pub async fn install_apk(&self, host_path: &str, on_log: LogHandler, timeout: Duration) -> CommandResult {
        let Some(serial) = self.require_serial().await else { return failed("no running guest") };
        let args: Vec<String> = ["install", "-r", "-g", "-d", host_path].iter().map(|s| (*s).to_owned()).collect();
        settle(self.adb().exec(&serial, &args, on_log, timeout).await)
    }

    /// Installs one app delivered as several APKs, base first, in a single session.
    pub async fn install_apks(&self, host_paths: &[String], on_log: LogHandler, timeout: Duration) -> CommandResult {
        let Some(serial) = self.require_serial().await else { return failed("no running guest") };
        settle(self.adb().install_multiple(&serial, host_paths, on_log, timeout).await)
    }

    /// Copies a host file to an absolute path in the guest.
    pub async fn push_file(&self, host_path: &str, guest_path: &str, on_log: LogHandler, timeout: Duration) -> CommandResult {
        let Some(serial) = self.require_serial().await else { return failed("no running guest") };
        settle(self.adb().push(&serial, host_path, guest_path, on_log, timeout).await)
    }

    /// The emulator process, whose window is the guest's real GPU-rendered screen. `None` when
    /// launched headless: there is no window to show, so the caller mirrors instead.
    ///
    /// The pid may be the launcher's; the window belongs to a process it started, which is why the
    /// window is found by walking the process tree rather than by pid alone.
    pub async fn display_pid(&self) -> Option<u32> {
        if !self.shared.options.windowed {
            return None;
        }
        let profile = self.profile().ok()?;
        self.running_pid(&profile.avd_name).await
    }

    /// One PNG of the guest's screen, for the mirror. Outside the command queue on purpose.
    pub async fn screencap(&self) -> Result<Vec<u8>> {
        let serial = self.state().serial.clone();
        let Some(serial) = serial else { fail!("no running guest") };
        self.adb().screencap(&serial, Duration::from_secs(20)).await
    }
}

/// Lowers the provisioning flag however the provision ends, cancelled included.
struct Provisioning<'a>(&'a SdkEngine);

impl<'a> Provisioning<'a> {
    fn begin(engine: &'a SdkEngine) -> Provisioning<'a> {
        engine.state().provisioning = true;
        Provisioning(engine)
    }
}

impl Drop for Provisioning<'_> {
    fn drop(&mut self) {
        self.0.state().provisioning = false;
    }
}

fn ok(stdout: Vec<String>) -> CommandResult {
    CommandResult::synthetic(0, stdout, Vec::new())
}

fn failed(message: impl Into<String>) -> CommandResult {
    CommandResult::synthetic(1, Vec::new(), vec![message.into()])
}

fn done_failing(message: impl Into<String>) -> Result<Attempt> {
    Ok(Attempt::Done(failed(message)))
}

/// A command that could not run at all reads as a failed one, with the reason as its output.
fn settle(result: Result<CommandResult>) -> CommandResult {
    result.unwrap_or_else(|error| failed(error.0))
}

fn is_snapshot_refusal(line: &str) -> bool {
    let line = line.to_lowercase();
    line.contains("cannot load snapshot") || line.contains("failed to load snapshot")
}

fn read_marker(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim_matches(js_is_space);
    (!text.is_empty()).then(|| text.to_owned())
}

fn remove_file_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Installed memory in MiB, rounded as `Math.round(os.totalmem() / 1048576)` rounded it.
fn total_ram_mb() -> u64 {
    #[cfg(windows)]
    let bytes = oe_win::system::total_memory_bytes().unwrap_or(8 << 30);
    #[cfg(not(windows))]
    let bytes: u64 = 8 << 30;
    (bytes + (1 << 19)) >> 20
}

fn is_emulator_process(pid: u32) -> bool {
    #[cfg(windows)]
    {
        oe_win::process::running_image_name(pid).is_some_and(|name| is_emulator_image(&name))
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, is_emulator_image);
        false
    }
}

async fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !is_emulator_process(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Ends a process, only ever one already checked to be the emulator.
fn end_process(pid: u32) -> bool {
    #[cfg(windows)]
    {
        oe_win::process::terminate(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::avd_state;

    fn android_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../android")
    }

    #[derive(Default, Clone)]
    struct Settings {
        device: Option<&'static str>,
        cores: Option<f64>,
        ram_mb: Option<f64>,
        density: Option<u32>,
    }

    fn engine_in(dir: &Path, settings: Settings) -> SdkEngine {
        let device = settings.device.unwrap_or("generic");
        SdkEngine::new(SdkEngineOptions {
            layout: SdkLayout::new(dir),
            android_root: android_root(),
            profile: Some("openemu".into()),
            device: Some(Arc::new(move || device.to_owned())),
            performance: Some(Arc::new(move || Performance { cores: settings.cores, ram_mb: settings.ram_mb })),
            density: Some(Arc::new(move || settings.density)),
            accelerated: Arc::new(|| true),
            windowed: true,
            own_window: None,
            on_log: None,
        })
    }

    fn openemu() -> GuestProfile {
        load_profile(&android_root(), "openemu").unwrap()
    }

    fn compat() -> GuestProfile {
        load_profile(&android_root(), "openemu-compat").unwrap()
    }

    /// What the engine itself would decide on the machine running the test, with nothing set.
    fn measured() -> GuestTuning {
        let facts = HostFacts {
            cpus: std::thread::available_parallelism().unwrap().get() as u32,
            total_ram_mb: total_ram_mb(),
            accelerated: true,
            has_window: true,
        };
        tune_for_host(&facts, TuningOverrides::default())
    }

    /// An AVD that has started before: it has userdata, a snapshot, and the marker that vouches
    /// for it.
    fn booted_avd(dir: &Path, engine: &SdkEngine, profile: &GuestProfile) -> (PathBuf, PathBuf) {
        let layout = SdkLayout::new(dir);
        create_avd(&CreateAvdInput {
            layout: &layout,
            android_root: &android_root(),
            profile,
            device: &engine.device().unwrap(),
            tuning: &engine.guest_tuning(profile),
            snapshot_name: SNAPSHOT,
        })
        .unwrap();
        let avd = avd_dir(&layout, &profile.avd_name);
        std::fs::write(avd.join("userdata-qemu.img"), "").unwrap();
        std::fs::create_dir_all(avd.join("snapshots").join(SNAPSHOT)).unwrap();
        let state = avd_state(&layout, &profile.avd_name);
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("provisioned_at"), now_iso8601()).unwrap();
        (avd, state)
    }

    // ── What a start uses ────────────────────────────────────────────────────────────────────

    #[test]
    fn with_nothing_set_a_start_uses_the_measured_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let tuning = engine_in(dir.path(), Settings::default()).guest_tuning(&openemu());
        assert_eq!(tuning.cores, measured().cores);
        assert_eq!(tuning.ram_mb, measured().ram_mb);
    }

    #[test]
    fn cores_and_memory_from_settings_reach_the_guest() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { cores: Some(3.0), ram_mb: Some(5120.0), ..Settings::default() };
        let tuning = engine_in(dir.path(), settings).guest_tuning(&openemu());
        assert_eq!((tuning.cores, tuning.ram_mb), (3, 5120));
    }

    #[test]
    fn the_users_memory_wins_over_a_profiles_hint_and_the_hint_wins_over_the_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(compat().ram_mb, Some(4096), "the shipped compat profile asks for 4 GB");
        assert_eq!(engine_in(dir.path(), Settings::default()).guest_tuning(&compat()).ram_mb, 4096);
        let more = Settings { ram_mb: Some(6144.0), ..Settings::default() };
        assert_eq!(engine_in(dir.path(), more).guest_tuning(&compat()).ram_mb, 6144);
        let cores = Settings { cores: Some(2.0), ..Settings::default() };
        assert_eq!(engine_in(dir.path(), cores).guest_tuning(&compat()).ram_mb, 4096, "setting cores leaves memory to the hint");
    }

    #[test]
    fn automatic_is_what_a_start_would_use_if_nothing_were_set_whatever_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine_in(dir.path(), Settings { cores: Some(2.0), ram_mb: Some(8192.0), ..Settings::default() });
        assert_eq!(engine.automatic_tuning(&openemu()).cores, measured().cores);
        assert_eq!(engine.automatic_tuning(&openemu()).ram_mb, measured().ram_mb);
        assert_eq!(engine.automatic_tuning(&compat()).ram_mb, 4096);
    }

    #[test]
    fn the_interface_size_replaces_the_devices_density_and_nothing_else_about_it() {
        let dir = tempfile::tempdir().unwrap();
        let stock = engine_in(dir.path(), Settings::default()).device().unwrap();
        let larger = engine_in(dir.path(), Settings { density: Some(320), ..Settings::default() }).device().unwrap();
        assert_eq!(stock.lcd_density, Some(240), "the generic device ships at 240 dpi");
        assert_eq!(larger.lcd_density, Some(320));
        assert_eq!((larger.lcd_width, larger.lcd_height), (stock.lcd_width, stock.lcd_height));
        assert_eq!(larger.props, stock.props);
    }

    // ── A snapshot does not outlive the hardware it was taken on ─────────────────────────────

    #[test]
    fn a_start_on_the_same_hardware_keeps_the_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine_in(dir.path(), Settings::default());
        let profile = openemu();
        let (avd, state) = booted_avd(dir.path(), &engine, &profile);
        assert!(!engine.forget_other_hardware(&profile, &engine.guest_tuning(&profile)).unwrap());
        assert!(avd.join("snapshots").join(SNAPSHOT).exists());
        assert!(state.join("provisioned_at").exists());
    }

    #[test]
    fn other_hardware_drops_the_snapshot_and_the_marker_and_keeps_the_users_data() {
        for (what, change) in [
            ("more cores", Settings { cores: Some(2.0), ..Settings::default() }),
            ("more memory", Settings { ram_mb: Some(6144.0), ..Settings::default() }),
            ("another interface size", Settings { density: Some(320), ..Settings::default() }),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let profile = openemu();
            let (avd, state) = booted_avd(dir.path(), &engine_in(dir.path(), Settings::default()), &profile);
            let changed = engine_in(dir.path(), change);
            assert!(changed.forget_other_hardware(&profile, &changed.guest_tuning(&profile)).unwrap(), "{what}");
            assert!(!avd.join("snapshots").exists(), "{what}: the snapshot would be refused on this hardware");
            assert!(!state.join("provisioned_at").exists(), "{what}: so the start provisions again and saves a new one");
            assert!(avd.join("userdata-qemu.img").exists(), "{what}: apps and files are not hardware");
        }
    }

    #[test]
    fn an_avd_that_has_never_started_has_nothing_to_forget() {
        let dir = tempfile::tempdir().unwrap();
        let profile = openemu();
        let first = engine_in(dir.path(), Settings::default());
        create_avd(&CreateAvdInput {
            layout: first.layout(),
            android_root: &android_root(),
            profile: &profile,
            device: &first.device().unwrap(),
            tuning: &first.guest_tuning(&profile),
            snapshot_name: SNAPSHOT,
        })
        .unwrap();
        let changed = engine_in(dir.path(), Settings { cores: Some(2.0), ..Settings::default() });
        assert!(!changed.forget_other_hardware(&profile, &changed.guest_tuning(&profile)).unwrap());
        let fast = load_profile(&android_root(), "fast").unwrap();
        assert!(!changed.forget_other_hardware(&fast, &measured()).unwrap(), "nor does one that does not exist");
    }

    #[test]
    fn the_comparison_is_on_hardware_alone_not_the_snapshot_keys() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine_in(dir.path(), Settings::default());
        let profile = openemu();
        let (avd, _) = booted_avd(dir.path(), &engine, &profile);
        let config = avd.join("config.ini");
        // What a start writes once a snapshot exists.
        let text = std::fs::read_to_string(&config).unwrap();
        let rewritten: Vec<String> = split_lines(&text)
            .into_iter()
            .map(|line| match line {
                l if l.starts_with("fastboot.forceColdBoot=") => "fastboot.forceColdBoot=no".to_owned(),
                l if l.starts_with("fastboot.forceFastBoot=") => "fastboot.forceFastBoot=yes".to_owned(),
                l => l.to_owned(),
            })
            .collect();
        std::fs::write(&config, rewritten.join("\n")).unwrap();
        assert!(!engine.forget_other_hardware(&profile, &engine.guest_tuning(&profile)).unwrap());
    }

    // ── Markers ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_stale_pid_file_is_cleared_rather_than_believed() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine_in(dir.path(), Settings::default());
        let file = engine.pid_file("Some_AVD");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // This test's own pid: certainly running, and certainly not an emulator.
        std::fs::write(&file, std::process::id().to_string()).unwrap();
        assert_eq!(engine.recorded_pid("Some_AVD"), None, "a pid held by another program is not the guest");
        assert!(!file.exists(), "and the file is cleared so it is not re-checked on every poll");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "not a pid").unwrap();
        assert_eq!(engine.recorded_pid("Some_AVD"), None);
    }

    #[test]
    fn provisioning_stands_for_a_stock_image_on_the_marker_alone() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine_in(dir.path(), Settings::default());
        let fast = load_profile(&android_root(), "fast").unwrap();
        assert_eq!(engine.is_provisioned(&fast, None), None);
        let state = avd_state(engine.layout(), &fast.avd_name);
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("provisioned_at"), "2026-08-24T10:00:00.000Z\n").unwrap();
        assert_eq!(engine.is_provisioned(&fast, None).as_deref(), Some("2026-08-24T10:00:00.000Z"));
    }

    #[test]
    fn for_our_rom_provisioning_must_have_been_against_this_build() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine_in(dir.path(), Settings::default());
        let profile = openemu();
        let recipe = recipe_for_profile(&profile).unwrap().expect("openemu is built from a recipe");
        let state = avd_state(engine.layout(), &profile.avd_name);
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("provisioned_at"), "2026-08-24T10:00:00.000Z").unwrap();
        // No ROM built and no id recorded: the two agree on "none", as they did in the TypeScript.
        assert!(engine.is_provisioned(&profile, Some(&recipe)).is_some());
        std::fs::write(state.join("rom_id"), "an-older-build").unwrap();
        assert_eq!(engine.is_provisioned(&profile, Some(&recipe)), None, "a marker from another build does not count");
    }

    #[test]
    fn a_snapshot_refusal_is_recognised_in_either_wording() {
        assert!(is_snapshot_refusal("WARNING | Cannot load snapshot default_boot"));
        assert!(is_snapshot_refusal("ERROR: failed to load snapshot"));
        assert!(!is_snapshot_refusal("INFO | Successfully loaded snapshot 'default_boot'"));
    }
}
