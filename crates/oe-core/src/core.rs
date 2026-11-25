//! The app's one handle: everything the UI can ask for, and the events it listens to.
//!
//! The port of the Electron main process's wiring. Each method is one thing a button or a view
//! needs; each [`CoreEvent`] is one thing the UI should redraw for.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oe_engine::acceleration::detect_acceleration;
use oe_engine::client::OpenEmuClient;
use oe_engine::defender::{self, ExclusionState};
use oe_engine::download::MessageHandler;
use oe_engine::engine::AndroidEngine;
use oe_engine::env_file::{load_device, load_profile};
use oe_engine::grpc::{self, EmulatorGrpc, Frame, KeyAction, BUTTON_PRIMARY};
use oe_engine::host::{tune_for_host, HostFacts, TuningOverrides};
use oe_engine::layout::{native_root, SdkLayout};
use oe_engine::mirror::{EngineMirror, DEFAULT_INTERVAL};
use oe_engine::profiles::ProfileId;
use oe_engine::sdk::dependencies::cleanup;
use oe_engine::sdk::sdk_engine::{Performance, SdkEngine, SdkEngineOptions};
use oe_engine::{CommandResult, LogHandler, LogStream};
use oe_store::app_library::InstalledApp;
use oe_store::store::{Store, StoreEvent, StorePaths};
use oe_store::types::{AppDetail, InstallJob, SourceId, StoreApp, StoreState};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::account::{Account, AccountState, FillField, FillResult};
use crate::device::{parse_status, DevicePrefsStore, DeviceState, EmuPhase, StatusReport};
use crate::display::{DisplayScaler, Size};
use crate::settings::{move_download_root, storage_usage, Settings, SettingsStore, StorageUsage};
use crate::setup::{SetupRunner, SetupStepStatus};
use crate::setup_steps::{build_native_steps, NativeSetupContext};
use crate::update::{is_installed_copy, schedule_checks, UpdateFeed, UpdateService, UpdateState};
use crate::{err, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum CoreEvent {
    Device(DeviceState),
    SetupStep(SetupStepStatus),
    Log(LogStream, String),
    /// A mirrored frame, as PNG.
    Frame(Vec<u8>),
    /// A new frame of the natively drawn screen is waiting in [`Core::take_frame`]. Only the
    /// newest is kept, so a busy UI skips frames rather than falling behind.
    FrameReady,
    StoreJob(InstallJob),
    /// An install really landed in the guest: the cue to re-read the app list.
    StoreInstalled(String),
    StoreIndexUpdated(StoreState),
    Update(UpdateState),
    /// The setup download's progress, in bytes.
    SetupProgress(u64, u64),
}

/// Where the app keeps things.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorePaths {
    /// `%APPDATA%\open-emulator`: settings, the account, the store's caches. The Electron app's
    /// folder, so existing users carry over.
    pub user_data: PathBuf,
    /// The tree holding `profiles/`, `devices/` and `config/`.
    pub android_root: PathBuf,
}

impl CorePaths {
    /// The real locations: the user's roaming profile, and `android/` beside the app, or, in a
    /// development run, in the checkout the app was built from.
    pub fn discover() -> Result<CorePaths> {
        // For development and tests: somewhere other than the real profile.
        if let Some(user_data) = std::env::var_os("OPEN_EMULATOR_USER_DATA") {
            return Ok(CorePaths { user_data: PathBuf::from(user_data), android_root: find_android_root()? });
        }
        let roaming = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
            std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
        });
        let user_data = roaming.ok_or_else(|| err!("could not find the user's application data folder"))?.join("open-emulator");
        Ok(CorePaths { user_data, android_root: find_android_root()? })
    }
}

fn find_android_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("OPEN_EMULATOR_ANDROID_ROOT") {
        return Ok(PathBuf::from(root));
    }
    let exe = std::env::current_exe().map_err(|error| err!("could not find the app: {error}"))?;
    exe.ancestors()
        .skip(1)
        .take(8)
        .map(|dir| dir.join("android"))
        .find(|candidate| candidate.join("profiles").is_dir())
        .ok_or_else(|| err!("the android/ folder that ships with the app is missing"))
}

/// What a start will give the guest, beside what "Automatic" would.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuningPreview {
    pub cores: u32,
    pub ram_mb: u32,
    pub density: u32,
    pub auto_cores: u32,
    pub auto_ram_mb: u32,
    pub auto_density: u32,
    pub gpu_mode: String,
    pub accelerated: bool,
    /// Plain-language acceleration status, suitable to show directly.
    pub acceleration_detail: String,
    pub host_cpus: u32,
    pub host_ram_mb: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsState {
    pub settings: Settings,
    pub tuning: TuningPreview,
    pub storage: StorageUsage,
    /// Which runtime is driving, so the UI can be honest about it.
    pub engine: String,
    /// What the last action had to say: moving the download folder, say.
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefenderResult {
    pub state: ExclusionState,
    /// Why the change did not go through: the UAC prompt was declined, say.
    pub error: Option<String>,
}

#[derive(Default)]
struct DeviceRuntime {
    last: StatusReport,
    busy: Option<EmuPhase>,
    error: Option<String>,
}

pub struct Core {
    paths: CorePaths,
    layout: SdkLayout,
    settings: Arc<SettingsStore>,
    engine: Arc<SdkEngine>,
    client: OpenEmuClient,
    setup: SetupRunner,
    store: Arc<Store>,
    account: Account,
    updates: Arc<UpdateService>,
    device_prefs: DevicePrefsStore,
    scaler: DisplayScaler,
    mirror: Mutex<Option<EngineMirror>>,
    /// The emulator's screen over gRPC, drawn by the app itself: see [`Core::start_mirror`].
    native: Arc<Mutex<Option<NativeDisplay>>>,
    latest_frame: Arc<Mutex<Option<Frame>>>,
    frame_pending: Arc<AtomicBool>,
    /// Frames drawn since `drawn_since`, for a frame rate in the log every ten seconds.
    drawn: Mutex<(u64, std::time::Instant)>,
    device: Mutex<DeviceRuntime>,
    accelerated: Arc<AtomicBool>,
    provisioning_started: AtomicBool,
    events: UnboundedSender<CoreEvent>,
    #[cfg(windows)]
    guest: Arc<Mutex<oe_win::guest_window::GuestWindow<oe_win::window::Win32Embed>>>,
}

impl Core {
    /// Builds the app and starts its background work. Call from inside a Tokio runtime.
    pub fn start(paths: CorePaths, version: &str) -> (Arc<Core>, UnboundedReceiver<CoreEvent>) {
        let (events, receiver) = unbounded_channel();
        let log: MessageHandler = {
            let events = events.clone();
            Arc::new(move |line: &str| {
                println!("{line}");
                let _ = events.send(CoreEvent::Log(LogStream::Stdout, line.to_owned()));
            })
        };

        let settings = Arc::new(SettingsStore::new(paths.user_data.join("settings.json")));
        let layout = SdkLayout::new(native_root(settings.get().download_root.as_deref()));
        let device_prefs = DevicePrefsStore::new(paths.user_data.join("device.json"), ProfileId::Openemu);
        let accelerated = Arc::new(AtomicBool::new(false));

        let engine = Arc::new(SdkEngine::new(SdkEngineOptions {
            layout: layout.clone(),
            android_root: paths.android_root.clone(),
            profile: Some(device_prefs.get().id().to_owned()),
            device: Some({
                let settings = settings.clone();
                Arc::new(move || settings.get().device.id().to_owned())
            }),
            performance: Some({
                let settings = settings.clone();
                Arc::new(move || {
                    let current = settings.get();
                    Performance { cores: current.cores.map(f64::from), ram_mb: current.ram_mb.map(f64::from) }
                })
            }),
            density: Some({
                let settings = settings.clone();
                Arc::new(move || settings.get().density)
            }),
            accelerated: {
                let accelerated = accelerated.clone();
                Arc::new(move || accelerated.load(Ordering::Relaxed))
            },
            windowed: true,
            own_window: Some({
                let settings = settings.clone();
                Arc::new(move || settings.get().emulator_window)
            }),
            on_log: Some(log.clone()),
        }));
        let client = OpenEmuClient::new(engine.clone() as Arc<dyn AndroidEngine>);

        let setup = SetupRunner::new(build_native_steps(NativeSetupContext {
            layout: layout.clone(),
            client: client.clone(),
            profile: {
                let engine = engine.clone();
                Arc::new(move || engine.profile())
            },
            tuning: Some({
                let engine = engine.clone();
                Arc::new(move |profile| engine.guest_tuning(profile))
            }),
            on_progress: Some({
                let events = events.clone();
                Arc::new(move |done, total| {
                    let _ = events.send(CoreEvent::SetupProgress(done, total));
                })
            }),
        }));

        let store = Store::new(
            client.clone(),
            &StorePaths {
                user_data: paths.user_data.clone(),
                repo_apps: paths.android_root.join("apps"),
                scratch: layout.root.join("downloads"),
            },
            log.clone(),
            {
                let events = events.clone();
                Arc::new(move |event| {
                    let _ = events.send(match event {
                        StoreEvent::Job(job) => CoreEvent::StoreJob(job),
                        StoreEvent::Installed(package) => CoreEvent::StoreInstalled(package),
                        StoreEvent::IndexUpdated(state) => CoreEvent::StoreIndexUpdated(state),
                    });
                })
            },
        );
        let account = Account::new(client.clone(), &paths.user_data, log.clone());

        let feed = is_installed_copy().then(|| {
            let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
            UpdateFeed::github(local.join("open-emulator-updater"))
        });
        let updates = Arc::new(UpdateService::new(version, feed, {
            let events = events.clone();
            move |state: &UpdateState| {
                let _ = events.send(CoreEvent::Update(state.clone()));
            }
        }));

        let core = Arc::new(Core {
            scaler: DisplayScaler::new(client.clone()),
            #[cfg(windows)]
            guest: Arc::new(Mutex::new(
                oe_win::guest_window::GuestWindow::new(oe_win::window::Win32Embed).with_log(|line| println!("[guest-window] {line}")),
            )),
            paths,
            layout,
            settings,
            engine,
            client,
            setup,
            store,
            account,
            updates,
            device_prefs,
            mirror: Mutex::new(None),
            native: Arc::default(),
            latest_frame: Arc::default(),
            frame_pending: Arc::default(),
            drawn: Mutex::new((0, std::time::Instant::now())),
            device: Mutex::default(),
            accelerated,
            provisioning_started: AtomicBool::new(false),
            events,
        });

        // Probed once at launch, and read live by every start, so a hypervisor enabled
        // mid-session counts once the probe has answered.
        let probe = core.clone();
        tokio::spawn(async move {
            let state = detect_acceleration().await;
            probe.accelerated.store(state.available, Ordering::Relaxed);
            probe.log(&format!("[engine] acceleration: {}", state.detail));
        });
        core.store.start();
        schedule_checks(core.updates.clone());
        (core, receiver)
    }

    fn emit(&self, event: CoreEvent) {
        let _ = self.events.send(event);
    }

    fn log(&self, line: &str) {
        println!("{line}");
        self.emit(CoreEvent::Log(LogStream::Stdout, line.to_owned()));
    }

    fn log_handler(&self) -> LogHandler {
        let events = self.events.clone();
        Arc::new(move |stream, line| {
            let _ = events.send(CoreEvent::Log(stream, line.to_owned()));
        })
    }

    pub fn paths(&self) -> &CorePaths {
        &self.paths
    }

    pub fn client(&self) -> &OpenEmuClient {
        &self.client
    }

    pub async fn run_status(&self) -> CommandResult {
        self.client.status(self.log_handler()).await
    }

    // ── Setup ────────────────────────────────────────────────────────────────────────────────

    pub fn setup_steps(&self) -> Vec<SetupStepStatus> {
        self.setup.list()
    }

    pub async fn run_setup_checks(&self) -> Vec<SetupStepStatus> {
        self.setup.run_all(|status| self.emit(CoreEvent::SetupStep(status.clone()))).await
    }

    /// Checks everything and repairs what it can, unattended: the first-run path. Once every
    /// blocking step passes, the one-time first boot starts in the background.
    pub async fn run_setup_auto(self: &Arc<Self>) -> Vec<SetupStepStatus> {
        let results = self
            .setup
            .run_auto(
                |status| {
                    if status.status != crate::setup::StepState::Running {
                        self.log(&format!("[setup] {}: {:?}: {}", status.id, status.status, status.detail));
                    }
                    self.emit(CoreEvent::SetupStep(status.clone()));
                },
                self.log_handler(),
            )
            .await;
        if results.iter().filter(|r| r.blocking).all(|r| r.status == crate::setup::StepState::Pass) {
            let core = self.clone();
            tokio::spawn(async move { core.start_background_provisioning().await });
        }
        results
    }

    pub async fn run_setup_fix(&self, id: &str) -> Result<SetupStepStatus> {
        self.setup.run_fix(id, self.log_handler(), |status| self.emit(CoreEvent::SetupStep(status.clone()))).await
    }

    // ── Device ───────────────────────────────────────────────────────────────────────────────

    fn device_runtime(&self) -> std::sync::MutexGuard<'_, DeviceRuntime> {
        self.device.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn current_device_state(&self) -> DeviceState {
        let runtime = self.device_runtime();
        let mut state = DeviceState { profile: self.device_prefs.get(), ..DeviceState::default() }.with_report(&runtime.last);
        if let Some(busy) = runtime.busy {
            state.phase = busy;
        }
        state.busy = runtime.busy.is_some();
        state.error = runtime.error.clone();
        state
    }

    pub async fn device_state(&self) -> DeviceState {
        if self.device_runtime().busy.is_none() {
            let result = self.client.status(oe_engine::no_log()).await;
            if result.success() {
                self.device_runtime().last = parse_status(&result.stdout);
            }
        }
        self.current_device_state()
    }

    /// Runs one start, stop or prepare, refusing a second while one is in flight. The UI disables
    /// its buttons on `busy`; this is what stands behind that.
    async fn run_device_action<F>(self: &Arc<Self>, phase: EmuPhase, action: impl FnOnce(LogHandler) -> F) -> DeviceState
    where
        F: std::future::Future<Output = Result<()>>,
    {
        {
            let mut runtime = self.device_runtime();
            if runtime.busy.is_some() {
                drop(runtime);
                return self.current_device_state();
            }
            runtime.busy = Some(phase);
            runtime.error = None;
        }
        self.emit(CoreEvent::Device(self.current_device_state()));
        let outcome = action(self.log_handler()).await;
        {
            let mut runtime = self.device_runtime();
            runtime.busy = None;
            if let Err(error) = outcome {
                runtime.error = Some(error.0);
            }
        }
        let state = self.device_state().await;
        self.emit(CoreEvent::Device(state.clone()));
        state
    }

    fn detach_guest(&self) {
        #[cfg(windows)]
        self.guest.lock().unwrap_or_else(|p| p.into_inner()).detach();
    }

    pub async fn device_start(self: &Arc<Self>) -> DeviceState {
        let core = self.clone();
        self.run_device_action(EmuPhase::Starting, |on_log| async move {
            core.scaler.forget();
            core.detach_guest();
            let started = core.client.start(on_log, false).await;
            core.client.key("KEYCODE_WAKEUP").await;
            if started.success() { Ok(()) } else { Err(err!("{}", started.stderr.join(" "))) }
        })
        .await
    }

    pub async fn device_stop(self: &Arc<Self>) -> DeviceState {
        let core = self.clone();
        self.run_device_action(EmuPhase::Stopping, |on_log| async move {
            core.scaler.forget();
            core.detach_guest();
            core.client.stop(on_log).await;
            Ok(())
        })
        .await
    }

    /// First boot and snapshot, so later launches are quick. Safe to re-run.
    pub async fn device_prepare(self: &Arc<Self>) -> DeviceState {
        let core = self.clone();
        self.run_device_action(EmuPhase::Starting, |on_log| async move {
            let status = core.setup.run_fix("provisioned", on_log, |_| {}).await?;
            match status.status {
                crate::setup::StepState::Fail => Err(err!("{}", status.detail)),
                _ => Ok(()),
            }
        })
        .await
    }

    /// The one-time cold boot, started without anyone watching once setup has banked the download.
    async fn start_background_provisioning(self: &Arc<Self>) {
        if self.provisioning_started.load(Ordering::SeqCst) || self.device_runtime().busy.is_some() {
            return;
        }
        let status = self.client.status(oe_engine::no_log()).await;
        if status.stdout.iter().any(|line| line.starts_with("provisioned_at=")) || !detect_acceleration().await.available {
            return;
        }
        if self.provisioning_started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.log("[provision] starting in the background: the user is already in the app");
        self.device_prepare().await;
    }

    /// Refused while the emulator is running; the returned state carries the reason.
    pub async fn device_set_profile(&self, profile: ProfileId) -> DeviceState {
        let running = self.current_device_state();
        if running.busy || running.phase == EmuPhase::Running {
            self.device_runtime().error = Some("Stop the device before switching to a different Android version.".into());
            return self.current_device_state();
        }
        self.device_runtime().error = None;
        self.engine.set_profile(Some(profile.id().to_owned()));
        self.device_prefs.set(profile);
        self.device_runtime().last = StatusReport::default();
        self.device_state().await
    }

    // ── The screen ───────────────────────────────────────────────────────────────────────────

    /// Where the device pane is, in real pixels within `parent`, and whether it should show.
    ///
    /// True when the guest's own window is embedded there, painting at the emulator's own frame
    /// rate, so the caller must not also mirror. False means mirror: the window could not be
    /// embedded, or there is none yet.
    #[cfg(windows)]
    pub async fn report_viewport(self: &Arc<Self>, parent: oe_win::Hwnd, rect: oe_win::Rect, visible: bool) -> bool {
        {
            let mut guest = self.guest.lock().unwrap_or_else(|p| p.into_inner());
            if !visible {
                guest.set_visible(false);
                return guest.is_attached();
            }
            if guest.is_attached() {
                guest.set_bounds(rect);
                guest.set_visible(true);
                return true;
            }
        }
        // The user asked for the emulator's own window: there is nothing to take into the pane.
        if self.settings.get().emulator_window {
            return false;
        }
        if let Some(window) = self.wait_for_guest_window().await {
            let attached = self.guest.lock().unwrap_or_else(|p| p.into_inner()).attach(window, parent, rect);
            if attached {
                self.scaler.set_enabled(false);
                let core = self.clone();
                tokio::spawn(async move {
                    core.scaler.reset().await;
                    core.client.key("KEYCODE_WAKEUP").await;
                });
                self.watch_guest();
                return true;
            }
        }
        self.scaler.set_enabled(true);
        self.scaler.request(Size { width: rect.width.max(0) as u32, height: rect.height.max(0) as u32 });
        false
    }

    /// The emulator's window, waited for while a start is under way and the window may yet appear.
    #[cfg(windows)]
    async fn wait_for_guest_window(&self) -> Option<oe_win::Hwnd> {
        let deadline = std::time::Instant::now() + oe_win::guest_window::ATTACH_TIMEOUT;
        loop {
            if let Some(pid) = self.client.display_pid().await {
                let found = tokio::task::spawn_blocking(move || oe_win::window::find_main_window_for_process_tree(pid)).await.ok().flatten();
                if found.is_some() {
                    return found;
                }
            }
            let starting = self.device_runtime().busy == Some(EmuPhase::Starting);
            if !starting || std::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(oe_win::guest_window::ATTACH_POLL.max(Duration::from_millis(200))).await;
        }
    }

    /// Keeps the embedded window honest every 200 ms: re-placed if it moved, forgotten if it died.
    #[cfg(windows)]
    fn watch_guest(&self) {
        let guest = self.guest.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(oe_win::guest_window::WATCH_INTERVAL).await;
                let mut guest = guest.lock().unwrap_or_else(|p| p.into_inner());
                guest.check();
                if !guest.is_attached() {
                    return;
                }
            }
        });
    }

    /// Gives the emulator's window back to the desktop, before this app's window goes, or Windows
    /// destroys the guest's window with it.
    pub fn release_guest_window(&self) {
        self.detach_guest();
    }

    /// Shows the guest in the device pane.
    ///
    /// Natively when it can: the emulator runs with no window of its own and serves its screen
    /// over gRPC, a frame each time the display changes, which the app draws itself. Only when no
    /// gRPC service turns up (the user chose the emulator's own window, or an emulator from before
    /// this app adopted) does it fall back to PNG screenshots over adb, a few frames a second.
    pub fn start_mirror(self: &Arc<Self>) {
        if self.native.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
            return;
        }
        if self.mirror.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(EngineMirror::is_active) {
            return;
        }
        let core = self.clone();
        let task = tokio::spawn(async move {
            // The discovery file appears a moment after the emulator starts.
            let mut found = None;
            for _ in 0..40 {
                let home = core.layout.root.join("home").join(".android");
                if let Some(endpoint) = grpc::discover("OpenEmulator_", Some(&home)) {
                    found = Some(endpoint);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let connected = match found {
                Some((port, token)) => EmulatorGrpc::connect(port, token).await.ok(),
                None => None,
            };
            let Some(client) = connected else {
                core.native.lock().unwrap_or_else(|p| p.into_inner()).take();
                core.log("[display] no gRPC screen to draw; mirroring screenshots instead");
                core.start_png_mirror();
                return;
            };
            if let Some(native) = core.native.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
                native.client = Some(client.clone());
            }
            core.log("[display] drawing Android natively from the emulator's gRPC screen stream");
            let (latest, pending, events) = (core.latest_frame.clone(), core.frame_pending.clone(), core.events.clone());
            let result = client
                .stream_screenshots(0, 0, move |frame| {
                    *latest.lock().unwrap_or_else(|p| p.into_inner()) = Some(frame);
                    if !pending.swap(true, Ordering::AcqRel) {
                        let _ = events.send(CoreEvent::FrameReady);
                    }
                    true
                })
                .await;
            if let Err(error) = result {
                core.log(&format!("[display] the screen stream ended: {}", error.0));
            }
        });
        *self.native.lock().unwrap_or_else(|p| p.into_inner()) = Some(NativeDisplay { task, client: None });
    }

    fn start_png_mirror(&self) {
        let mut mirror = self.mirror.lock().unwrap_or_else(|p| p.into_inner());
        if mirror.as_ref().is_some_and(EngineMirror::is_active) {
            return;
        }
        let events = self.events.clone();
        *mirror = Some(EngineMirror::start(
            self.engine.clone() as Arc<dyn AndroidEngine>,
            DEFAULT_INTERVAL,
            move |png| {
                let _ = events.send(CoreEvent::Frame(png));
            },
            self.log_handler(),
        ));
    }

    pub fn stop_mirror(&self) {
        if let Some(native) = self.native.lock().unwrap_or_else(|p| p.into_inner()).take() {
            native.task.abort();
        }
        self.latest_frame.lock().unwrap_or_else(|p| p.into_inner()).take();
        self.frame_pending.store(false, Ordering::Release);
        if let Some(mirror) = self.mirror.lock().unwrap_or_else(|p| p.into_inner()).take() {
            mirror.stop();
        }
    }

    /// The newest natively drawn frame, once per [`CoreEvent::FrameReady`].
    pub fn take_frame(&self) -> Option<Frame> {
        let frame = self.latest_frame.lock().unwrap_or_else(|p| p.into_inner()).take();
        self.frame_pending.store(false, Ordering::Release);
        if frame.is_some() {
            let mut drawn = self.drawn.lock().unwrap_or_else(|p| p.into_inner());
            drawn.0 += 1;
            let elapsed = drawn.1.elapsed().as_secs_f64();
            if elapsed >= 10.0 {
                let line = format!("[display] {:.1} fps drawn over the last {elapsed:.0} s", drawn.0 as f64 / elapsed);
                *drawn = (0, std::time::Instant::now());
                drop(drawn);
                self.log(&line);
            }
        }
        frame
    }

    fn native_client(&self) -> Option<EmulatorGrpc> {
        self.native.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|native| native.client.clone())
    }

    /// Whether input can go straight to the emulator: a finger down, held, dragged and lifted as
    /// it happens, rather than a tap or swipe replayed afterwards through adb.
    pub fn has_native_input(&self) -> bool {
        self.native_client().is_some()
    }

    /// The pointer at a display pixel, pressed or not: a finger on the screen while pressed.
    pub async fn pointer(&self, x: i32, y: i32, pressed: bool) -> bool {
        match self.native_client() {
            Some(client) => client.send_mouse(x, y, if pressed { BUTTON_PRIMARY } else { 0 }).await.is_ok(),
            None => false,
        }
    }

    /// A mouse wheel turn, 120 units a click; positive scrolls up.
    pub async fn wheel(&self, dy: i32) -> bool {
        match self.native_client() {
            Some(client) => client.send_wheel(dy).await.is_ok(),
            None => false,
        }
    }

    /// A key typed on this PC's keyboard into Android, by its W3C name ("Enter", "Backspace").
    pub async fn key_name(&self, key: &str) -> bool {
        match self.native_client() {
            Some(client) => client.send_key(key, KeyAction::Press).await.is_ok(),
            None => false,
        }
    }

    /// One PNG of the guest, captured now, at its real resolution.
    pub async fn screenshot(&self) -> Option<Vec<u8>> {
        self.engine.screencap().await.ok().filter(|png| !png.is_empty())
    }

    /// Turns Android itself a quarter turn: apps re-lay out, and it works with the guest's own
    /// window embedded, where there is no picture to transform. The new rotation, 0–3.
    pub async fn rotate_device(&self) -> Option<u8> {
        let current = self.client.shell("settings get system user_rotation", oe_engine::no_log(), None).await;
        let parsed: Option<u8> = current.stdout.join("").trim().parse().ok();
        let next = parsed.map_or(1, |rotation| (rotation + 1) % 4);
        let command = format!("settings put system accelerometer_rotation 0 && settings put system user_rotation {next}");
        self.client.shell(&command, oe_engine::no_log(), None).await.success().then_some(next)
    }

    pub async fn tap(&self, x: f64, y: f64) -> bool {
        self.client.tap(x, y).await
    }

    pub async fn swipe(&self, x1: f64, y1: f64, x2: f64, y2: f64, duration_ms: f64) -> bool {
        self.client.swipe(x1, y1, x2, y2, duration_ms).await
    }

    pub async fn key(&self, keycode: &str) -> bool {
        if let (Some(client), Some(name)) = (self.native_client(), grpc_key_name(keycode)) {
            if client.send_key(name, KeyAction::Press).await.is_ok() {
                return true;
            }
        }
        self.client.key(keycode).await
    }

    pub async fn type_text(&self, value: &str) -> bool {
        if let Some(client) = self.native_client() {
            if client.send_text(value).await.is_ok() {
                return true;
            }
        }
        self.client.text(value).await
    }

    pub async fn list_apps(&self) -> Vec<InstalledApp> {
        self.store.library().list().await
    }

    pub async fn launch_app(&self, package_name: &str) -> bool {
        self.store.library().launch(package_name).await
    }

    // ── Store ────────────────────────────────────────────────────────────────────────────────

    pub fn store_state(&self) -> StoreState {
        self.store.state()
    }

    pub async fn store_probe_guest(&self, force: bool) -> StoreState {
        self.store.probe_guest(force).await
    }

    pub async fn store_refresh_index(&self, force: bool) -> StoreState {
        self.store.refresh_index(force).await
    }

    pub async fn store_search(&self, query: &str, source: Option<SourceId>, limit: Option<usize>) -> Vec<StoreApp> {
        self.store.search(query, source, limit).await
    }

    pub async fn store_detail(&self, source: SourceId, package_name: &str) -> Option<AppDetail> {
        self.store.detail(source, package_name).await
    }

    pub async fn store_install(&self, source: SourceId, package_name: &str, version_code: Option<i64>) -> Option<InstallJob> {
        self.store.install(source, package_name, version_code).await
    }

    pub fn store_jobs(&self) -> Vec<InstallJob> {
        self.store.jobs()
    }

    /// App files already on this PC: dropped on the window, or chosen. One job per file.
    pub async fn store_install_files(&self, paths: &[PathBuf]) -> Vec<InstallJob> {
        self.store.install_files(paths).await
    }

    pub async fn play_open(&self) -> bool {
        self.store.play().open().await
    }

    pub async fn play_search(&self, query: &str) -> bool {
        let query: String = query.chars().take(200).collect();
        self.store.play().search(&query).await
    }

    pub async fn play_details(&self, package_name: &str) -> bool {
        self.store.play().details(package_name).await
    }

    pub async fn play_back(&self) -> bool {
        self.store.play().back().await
    }

    // ── Account ──────────────────────────────────────────────────────────────────────────────

    pub fn account_state(&self) -> AccountState {
        self.account.state()
    }

    pub async fn account_refresh(&self, force: bool) -> AccountState {
        self.account.refresh(self.store.avd_name(), force).await
    }

    pub fn account_set_email(&self, email: Option<&str>) -> AccountState {
        self.account.set_email(email)
    }

    pub fn account_set_display_name(&self, name: &str) -> AccountState {
        self.account.set_display_name(name)
    }

    /// Stores or clears the password. One-way: nothing ever reads it back out to the UI.
    pub fn account_set_password(&self, password: Option<&str>) -> AccountState {
        self.account.set_password(password)
    }

    pub fn account_set_auto_fill(&self, enabled: bool) -> AccountState {
        self.account.set_auto_fill(enabled)
    }

    pub fn account_sign_out(&self) -> AccountState {
        self.account.sign_out()
    }

    pub async fn account_begin_sign_in(&self) -> FillResult {
        self.account.begin_sign_in().await
    }

    pub async fn account_fill(&self, field: FillField) -> FillResult {
        self.account.fill(field).await
    }

    // ── Settings ─────────────────────────────────────────────────────────────────────────────

    pub async fn settings_state(&self) -> SettingsState {
        self.settings_state_with(None).await
    }

    async fn settings_state_with(&self, last_message: Option<String>) -> SettingsState {
        let current = self.settings.get();
        let acceleration = detect_acceleration().await;
        let host_cpus = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
        let host_ram_mb = total_ram_mb();
        let facts = HostFacts { cpus: host_cpus, total_ram_mb: host_ram_mb, accelerated: acceleration.available, has_window: true };
        let profile = self.engine.profile().ok();
        let automatic = profile.as_ref().map_or_else(|| tune_for_host(&facts, TuningOverrides::default()), |p| self.engine.automatic_tuning(p));
        let tuning = profile.as_ref().map_or_else(
            || tune_for_host(&facts, TuningOverrides { cores: current.cores.map(f64::from), ram_mb: current.ram_mb.map(f64::from), gpu_mode: None }),
            |p| self.engine.guest_tuning(p),
        );
        let auto_density = load_device(&self.paths.android_root, current.device.id()).ok().and_then(|d| d.lcd_density).unwrap_or(240);
        SettingsState {
            tuning: TuningPreview {
                cores: tuning.cores,
                ram_mb: tuning.ram_mb,
                density: current.density.unwrap_or(auto_density),
                auto_cores: automatic.cores,
                auto_ram_mb: automatic.ram_mb,
                auto_density,
                gpu_mode: tuning.gpu_mode.name().to_owned(),
                accelerated: acceleration.available,
                acceleration_detail: acceleration.detail,
                host_cpus,
                host_ram_mb,
            },
            storage: storage_usage(
                &self.layout.root,
                &[self.layout.root.join("downloads"), self.layout.sdk_root.join(".temp"), self.layout.sdk_root.join(".downloadIntermediates")],
            ),
            settings: current,
            engine: "sdk".to_owned(),
            last_message,
        }
    }

    /// Applies a change; out-of-range values are clamped rather than stored.
    pub async fn settings_set(&self, change: impl FnOnce(&mut Settings)) -> SettingsState {
        self.settings.update(change);
        self.settings_state().await
    }

    /// Deletes archives and scratch. Never touches the extracted SDK or a guest.
    pub async fn settings_free_space(&self) -> SettingsState {
        let freed = cleanup(&self.layout, false);
        self.log(&format!("[settings] freed {} bytes across {} paths", freed.bytes_freed, freed.removed.len()));
        self.settings_state().await
    }

    /// Moves any existing download into `<chosen>\open-emulator`. Takes effect at the next launch.
    pub async fn settings_move_download_folder(&self, chosen: &Path) -> SettingsState {
        let target = chosen.join("open-emulator");
        let (from, to) = (self.layout.root.clone(), target.clone());
        let moved = tokio::task::spawn_blocking(move || move_download_root(&from, &to)).await;
        let moved = match moved {
            Ok(moved) => moved,
            Err(error) => return self.settings_state_with(Some(format!("Could not move the files: {error}"))).await,
        };
        self.log(&format!("[settings] download folder: {}", moved.message));
        if !moved.ok {
            return self.settings_state_with(Some(moved.message)).await;
        }
        self.settings.update(|settings| settings.download_root = Some(target));
        self.settings_state_with(Some(format!("{} The change takes effect when open-emulator restarts.", moved.message))).await
    }

    pub async fn defender_state(&self) -> ExclusionState {
        defender::exclusion_state(&self.layout.root).await
    }

    /// Adds or removes the exclusion, via a UAC prompt. Only ever called from an explicit request.
    pub async fn defender_set_excluded(&self, enabled: bool) -> DefenderResult {
        let changed = if enabled { defender::add_exclusion(&self.layout.root).await } else { defender::remove_exclusion(&self.layout.root).await };
        DefenderResult { state: self.defender_state().await, error: changed.err().map(|error| error.0) }
    }

    // ── Updates ──────────────────────────────────────────────────────────────────────────────

    pub fn update_state(&self) -> UpdateState {
        self.updates.get()
    }

    /// Looks for a newer version. Never downloads one.
    pub async fn update_check(&self) -> UpdateState {
        self.updates.check().await
    }

    pub async fn update_download(&self) -> UpdateState {
        self.updates.download().await
    }

    /// The downloaded installer, to run as the app quits.
    pub fn update_ready_installer(&self) -> Option<PathBuf> {
        self.updates.ready_installer()
    }
}

fn total_ram_mb() -> u64 {
    #[cfg(windows)]
    let bytes = oe_win::system::total_memory_bytes().unwrap_or(8 << 30);
    #[cfg(not(windows))]
    let bytes: u64 = 8 << 30;
    (bytes + (1 << 19)) >> 20
}

/// The profile file for an id, for the profile picker, which shows each image's description.
pub fn profile_exists(android_root: &Path, profile: ProfileId) -> bool {
    load_profile(android_root, profile.id()).is_ok()
}

/// The natively drawn screen: the task streaming it, and the connection input goes over.
struct NativeDisplay {
    task: tokio::task::JoinHandle<()>,
    client: Option<EmulatorGrpc>,
}

/// The emulator's gRPC name for an Android keycode the toolbar sends.
fn grpc_key_name(keycode: &str) -> Option<&'static str> {
    Some(match keycode {
        "KEYCODE_HOME" => "GoHome",
        "KEYCODE_BACK" => "GoBack",
        "KEYCODE_APP_SWITCH" => "AppSwitch",
        "KEYCODE_POWER" => "Power",
        "KEYCODE_VOLUME_UP" => "AudioVolumeUp",
        "KEYCODE_VOLUME_DOWN" => "AudioVolumeDown",
        _ => return None,
    })
}
