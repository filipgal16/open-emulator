//! The app's state and what each message does to it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use iced::futures::SinkExt;
use iced::widget::image;
use iced::{event, keyboard, time, window, Element, Event, Point, Rectangle, Subscription, Task, Theme};
use oe_core::account::{AccountState, FillField, FillResult};
use oe_core::core::{Core, CoreEvent, DefenderResult, SettingsState};
use oe_core::device::{DeviceState, EmuPhase};
use oe_core::settings::{DeviceId, ThemeChoice};
use oe_core::setup::{SetupStepStatus, StepState};
use oe_core::update::{UpdatePhase, UpdateState};
use oe_engine::defender::ExclusionState;
use oe_engine::profiles::ProfileId;
use oe_store::app_library::InstalledApp;
use oe_store::types::{AppDetail, InstallJob, InstallState, SourceId, StoreApp, StoreState};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::theme::{self, Tokens};
use crate::views;

/// The core and its event stream, handed from `main` to the app as it boots.
pub static CORE: OnceLock<Arc<Core>> = OnceLock::new();
pub static EVENTS: Mutex<Option<UnboundedReceiver<CoreEvent>>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Workspace {
    Device,
    Apps,
    Store,
    Settings,
}

impl Workspace {
    pub const ALL: [Workspace; 4] = [Workspace::Device, Workspace::Apps, Workspace::Store, Workspace::Settings];

    pub fn label(self) -> &'static str {
        match self {
            Workspace::Device => "Device",
            Workspace::Apps => "Apps",
            Workspace::Store => "Store",
            Workspace::Settings => "Settings",
        }
    }
}

#[derive(Debug, Clone)]
pub enum Message {
    Core(CoreEvent),
    Window(Option<window::Id>),
    Parent(isize),
    Scale(f32),
    Pane(Rectangle),
    Embedded(bool),
    Tick,
    Poll,
    CloseRequested,
    /// The guest's window is back with the emulator, or did not answer in time: quit.
    FinishClose,
    FileDropped(PathBuf),
    Key(keyboard::Key, keyboard::Modifiers),

    // Setup
    SetupDone(Vec<SetupStepStatus>),
    SetupRetry,
    SetupContinue,
    SetupDetails,

    // Shell and device
    Select(Workspace),
    ToggleAccount,
    ToggleProfileMenu,
    SetProfile(ProfileId),
    DeviceStart,
    DeviceStop,
    DevicePrepare,
    Device(DeviceState),
    Press(&'static str),
    Rotate,
    Screenshot,
    ScreenshotSaved(Option<String>),
    ToggleTheater,
    PointerMoved(Point),
    PointerDown,
    PointerUp,
    /// A mouse wheel turn over the device, in lines; positive scrolls up.
    Wheel(f32),
    Typed(bool),

    // Apps
    Apps(Vec<InstalledApp>),
    RefreshApps,
    Launch(String),
    Launched(bool),

    // Store
    StoreQuery(String),
    StoreSearch,
    StoreResults(u64, Vec<StoreApp>),
    StoreSource(Option<SourceId>),
    StoreOpen(SourceId, String),
    StoreDetail(Option<AppDetail>),
    StoreBack,
    StoreInstall(SourceId, String, Option<i64>),
    StoreStarted(Option<InstallJob>),
    StoreState(StoreState),
    InstallFromFile,
    FilesChosen(Vec<PathBuf>),
    FilesQueued(Vec<InstallJob>),
    PlayOpen,
    PlaySearch,
    PlayBack,
    PlayDone(bool),

    // Settings
    Settings(SettingsState),
    SetTheme(ThemeChoice),
    SetDevice(DeviceId),
    SetEmulatorWindow(bool),
    SliderCores(f64),
    SliderRam(f64),
    SliderDensity(f64),
    CommitSliders,
    AutoCores(bool),
    AutoRam(bool),
    AutoDensity(bool),
    ChooseFolder,
    FolderChosen(Option<PathBuf>),
    FreeSpace,
    RestartApp,
    Defender(ExclusionState),
    SetDefender(bool),
    DefenderDone(DefenderResult),
    UpdateCheck,
    UpdateDownload,
    UpdateInstall,
    Update(UpdateState),

    // Account
    Account(AccountState),
    EmailInput(String),
    SaveEmail,
    NameInput(String),
    SaveName,
    PasswordInput(String),
    SavePassword,
    ClearPassword,
    SetAutoFill(bool),
    SignOut,
    BeginSignIn,
    Fill(FillField),
    FillDone(FillResult),
}

#[derive(Default)]
pub struct SetupUi {
    pub steps: Vec<SetupStepStatus>,
    pub running: bool,
    pub finished: bool,
    pub show_details: bool,
    pub log: Vec<String>,
    pub progress: Option<(u64, u64)>,
}

#[derive(Default)]
pub struct StoreUi {
    pub state: StoreState,
    pub query: String,
    pub source: Option<SourceId>,
    pub results: Vec<StoreApp>,
    pub searching: bool,
    pub ticket: u64,
    pub detail: Option<AppDetail>,
    pub jobs: Vec<InstallJob>,
    pub installed: Vec<String>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct SettingsUi {
    pub state: Option<SettingsState>,
    /// Slider positions while dragging; committed on release.
    pub cores: Option<f64>,
    pub ram: Option<f64>,
    pub density: Option<f64>,
    pub defender: Option<ExclusionState>,
    pub defender_message: Option<String>,
    pub working: bool,
}

#[derive(Default)]
pub struct AccountUi {
    pub state: Option<AccountState>,
    pub email: String,
    pub name: String,
    pub password: String,
    pub message: Option<String>,
}

pub struct App {
    pub core: Arc<Core>,
    pub tokens: Tokens,
    pub window: Option<window::Id>,
    pub parent: Option<isize>,
    pub scale: f32,
    pub ready: bool,
    pub setup: SetupUi,
    pub workspace: Workspace,
    pub show_account: bool,
    pub profile_menu: bool,
    pub theater: bool,
    pub device: DeviceState,
    pub busy_since: Option<Instant>,
    pub pane: Option<Rectangle>,
    pub embedded: bool,
    pub mirroring: bool,
    /// Set once a close has been asked for, while the guest's window is handed back.
    pub closing: bool,
    pub frame: Option<(image::Handle, u32, u32)>,
    pub pointer: Option<Point>,
    pub pressed: Option<(Point, Instant)>,
    pub apps: Vec<InstalledApp>,
    pub apps_loaded: bool,
    pub store: StoreUi,
    pub settings: SettingsUi,
    pub update: UpdateState,
    pub account: AccountUi,
    pub toast: Option<String>,
    /// Store art, decoded from the cached files' bytes. The cache names files by a hash with no
    /// extension, and iced decides a file's format from its extension, so a path would not load.
    pub icons: HashMap<PathBuf, image::Handle>,
}

fn core() -> Arc<Core> {
    CORE.get().expect("main starts the core before the window").clone()
}

impl App {
    pub fn boot() -> (App, Task<Message>) {
        let core = core();
        let app = App {
            tokens: theme::DARK,
            window: None,
            parent: None,
            scale: 1.0,
            ready: false,
            setup: SetupUi { steps: core.setup_steps(), running: true, ..SetupUi::default() },
            workspace: Workspace::Device,
            show_account: false,
            profile_menu: false,
            theater: false,
            device: DeviceState::default(),
            busy_since: None,
            pane: None,
            embedded: false,
            mirroring: false,
            closing: false,
            frame: None,
            pointer: None,
            pressed: None,
            apps: Vec::new(),
            apps_loaded: false,
            store: StoreUi { state: core.store_state(), jobs: core.store_jobs(), ..StoreUi::default() },
            settings: SettingsUi::default(),
            update: core.update_state(),
            account: AccountUi::default(),
            toast: None,
            icons: HashMap::new(),
            core: core.clone(),
        };
        let account = core.account_state();
        // `OPEN_EMULATOR_SETUP=check` only checks, and `skip` goes straight to the app: for
        // development runs that must not start a multi-gigabyte download.
        let mode = std::env::var("OPEN_EMULATOR_SETUP").unwrap_or_default();
        let setup = match mode.as_str() {
            "check" | "skip" => perform(&core, |core| async move { core.run_setup_checks().await }, Message::SetupDone),
            _ => perform(&core, |core| async move { core.run_setup_auto().await }, Message::SetupDone),
        };
        let mut app = app;
        app.ready = mode == "skip";
        // `OPEN_EMULATOR_VIEW` opens on one screen, for checking a screen without clicking to it.
        let opening = match std::env::var("OPEN_EMULATOR_VIEW").unwrap_or_default().as_str() {
            "apps" => app.select(Workspace::Apps),
            "store" => app.select(Workspace::Store),
            "settings" => app.select(Workspace::Settings),
            "account" => {
                app.show_account = true;
                Task::none()
            }
            "setup" => {
                app.ready = false;
                Task::none()
            }
            "menu" => {
                app.profile_menu = true;
                Task::none()
            }
            _ => Task::none(),
        };
        let tasks = Task::batch([
            opening,
            window::oldest().map(Message::Window),
            setup,
            perform(&core, |core| async move { core.settings_state().await }, Message::Settings),
            perform(&core, |core| async move { core.device_state().await }, Message::Device),
            Task::done(Message::Account(account)),
        ]);
        (app, tasks)
    }

    pub fn theme(&self) -> Theme {
        theme::iced_theme(self.tokens)
    }

    pub fn view(&self) -> Element<'_, Message> {
        views::view(self)
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![
            Subscription::run(core_events),
            event::listen_with(|event, status, _window| match event {
                Event::Window(window::Event::CloseRequested) => Some(Message::CloseRequested),
                Event::Window(window::Event::Rescaled(scale)) => Some(Message::Scale(scale)),
                Event::Window(window::Event::FileDropped(path)) => Some(Message::FileDropped(path)),
                Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) if status == event::Status::Ignored => {
                    Some(Message::Key(key, modifiers))
                }
                _ => None,
            }),
            // The device bar re-reads the guest every ten seconds, as it did.
            time::every(Duration::from_secs(10)).map(|_| Message::Poll),
        ];
        if self.device.busy {
            subscriptions.push(time::every(Duration::from_secs(1)).map(|_| Message::Tick));
        }
        Subscription::batch(subscriptions)
    }

    fn visible(&self) -> bool {
        self.ready && self.workspace == Workspace::Device && !self.show_account
    }

    /// The device pane changed: the app draws Android there itself, so all that follows is
    /// whether the screen stream should run.
    fn report_viewport(&mut self) -> Task<Message> {
        self.embedded = false;
        self.sync_mirror()
    }

    /// Whether the user asked for the emulator's own window instead of Android inside the pane.
    pub fn own_window(&self) -> bool {
        self.settings.state.as_ref().is_some_and(|state| state.settings.emulator_window)
    }

    /// Mirrors only when the guest runs but its own window could not be shown in the pane, and
    /// never while the emulator is showing that window by itself.
    fn sync_mirror(&mut self) -> Task<Message> {
        let want = self.device.phase == EmuPhase::Running && self.visible() && !self.own_window();
        if want && !self.mirroring {
            self.core.start_mirror();
        } else if !want && self.mirroring {
            self.core.stop_mirror();
            self.frame = None;
        }
        self.mirroring = want;
        Task::none()
    }

    fn set_device(&mut self, device: DeviceState) -> Task<Message> {
        if device.busy && self.busy_since.is_none() {
            self.busy_since = Some(Instant::now());
        } else if !device.busy {
            self.busy_since = None;
        }
        let became_live = device.phase != self.device.phase;
        self.device = device;
        if became_live { Task::batch([self.report_viewport(), self.sync_mirror()]) } else { self.sync_mirror() }
    }

    fn select(&mut self, workspace: Workspace) -> Task<Message> {
        self.show_account = false;
        self.profile_menu = false;
        if workspace != Workspace::Device && self.theater {
            self.theater = false;
        }
        self.workspace = workspace;
        let load = match workspace {
            Workspace::Apps => perform(&self.core, |core| async move { core.list_apps().await }, Message::Apps),
            Workspace::Store if self.store.results.is_empty() => Task::batch([
                self.search(),
                perform(&self.core, |core| async move { core.store_probe_guest(false).await }, Message::StoreState),
            ]),
            Workspace::Settings => Task::batch([
                perform(&self.core, |core| async move { core.settings_state().await }, Message::Settings),
                perform(&self.core, |core| async move { core.defender_state().await }, Message::Defender),
            ]),
            _ => Task::none(),
        };
        Task::batch([load, self.report_viewport()])
    }

    fn search(&mut self) -> Task<Message> {
        self.store.ticket += 1;
        self.store.searching = true;
        let (ticket, query, source) = (self.store.ticket, self.store.query.clone(), self.store.source);
        perform(&self.core, move |core| async move { (ticket, core.store_search(&query, source, None).await) }, |(t, r)| {
            Message::StoreResults(t, r)
        })
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Core(event) => self.on_core_event(event),
            Message::Window(Some(id)) => {
                self.window = Some(id);
                let parent = window::run(id, |w| {
                    use raw_window_handle::RawWindowHandle;
                    match w.window_handle().map(|h| h.as_raw()) {
                        Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get(),
                        _ => 0,
                    }
                });
                Task::batch([parent.map(Message::Parent), window::scale_factor(id).map(Message::Scale)])
            }
            Message::Window(None) => Task::none(),
            Message::Parent(hwnd) => {
                self.parent = (hwnd != 0).then_some(hwnd);
                self.tint_frame();
                self.report_viewport()
            }
            Message::Scale(scale) => {
                self.scale = scale;
                self.report_viewport()
            }
            Message::Pane(bounds) => {
                self.pane = Some(bounds);
                self.report_viewport()
            }
            Message::Embedded(embedded) => {
                self.embedded = embedded;
                self.sync_mirror()
            }
            Message::Tick => Task::none(),
            Message::Poll => perform(&self.core, |core| async move { core.device_state().await }, Message::Device),
            Message::CloseRequested => {
                if self.closing {
                    return Task::none();
                }
                self.closing = true;
                self.core.stop_mirror();
                // Handed back off this thread, which keeps answering messages meanwhile. Giving the
                // emulator its window back is a conversation with the emulator's own UI thread, and
                // with the guest-window watchdog that holds the same lock; blocking this thread in
                // the middle of it is how closing used to hang, window frozen, for good. A guest
                // that has not answered in three seconds is left to the exit.
                let core = self.core.clone();
                let (done, finished) = tokio::sync::oneshot::channel::<()>();
                std::thread::spawn(move || {
                    core.release_guest_window();
                    let _ = done.send(());
                });
                Task::perform(
                    async move {
                        let _ = tokio::time::timeout(Duration::from_secs(3), finished).await;
                    },
                    |()| Message::FinishClose,
                )
            }
            Message::FinishClose => {
                if let Some(installer) = self.core.update_ready_installer() {
                    let _ = oe_core::update::run_installer(&installer);
                }
                // Ended here rather than through `iced::exit`. Everything worth keeping is already
                // on disk, and the toolkit's shutdown waits for any background work still inside a
                // blocking call, an adb read or a guest preparation, which can take minutes. That
                // wait was the app freezing on close, window and all.
                std::process::exit(0)
            }
            Message::FileDropped(path) => {
                self.workspace = Workspace::Store;
                perform(&self.core, move |core| async move { core.store_install_files(&[path]).await }, Message::FilesQueued)
            }
            Message::Key(key, modifiers) => self.on_key(key, modifiers),

            Message::SetupDone(results) => {
                self.setup.running = false;
                self.setup.finished = true;
                for status in results {
                    if let Some(step) = self.setup.steps.iter_mut().find(|s| s.id == status.id) {
                        *step = status;
                    }
                }
                if self.setup_passed() {
                    self.ready = true;
                }
                self.report_viewport()
            }
            Message::SetupRetry => {
                self.setup.running = true;
                self.setup.finished = false;
                perform(&self.core, |core| async move { core.run_setup_auto().await }, Message::SetupDone)
            }
            Message::SetupContinue => {
                self.ready = true;
                self.report_viewport()
            }
            Message::SetupDetails => {
                self.setup.show_details = !self.setup.show_details;
                Task::none()
            }

            Message::Select(workspace) => self.select(workspace),
            Message::ToggleAccount => {
                self.show_account = !self.show_account;
                self.profile_menu = false;
                let refresh = if self.show_account {
                    perform(&self.core, |core| async move { core.account_refresh(false).await }, Message::Account)
                } else {
                    Task::none()
                };
                Task::batch([refresh, self.report_viewport()])
            }
            Message::ToggleProfileMenu => {
                self.profile_menu = !self.profile_menu;
                Task::none()
            }
            Message::SetProfile(profile) => {
                self.profile_menu = false;
                perform(&self.core, move |core| async move { core.device_set_profile(profile).await }, Message::Device)
            }
            Message::DeviceStart => perform(&self.core, |core| async move { core.device_start().await }, Message::Device),
            Message::DeviceStop => perform(&self.core, |core| async move { core.device_stop().await }, Message::Device),
            Message::DevicePrepare => perform(&self.core, |core| async move { core.device_prepare().await }, Message::Device),
            Message::Device(device) => self.set_device(device),
            Message::Press(keycode) => perform(&self.core, move |core| async move { core.key(keycode).await }, |_| Message::Tick),
            Message::Rotate => perform(&self.core, |core| async move { core.rotate_device().await }, |_| Message::Tick),
            Message::Screenshot => perform(
                &self.core,
                |core| async move {
                    let png = core.screenshot().await?;
                    let name = format!("open-emulator-{}.png", oe_core::now_ms());
                    let file = rfd::AsyncFileDialog::new().set_file_name(&name).add_filter("PNG image", &["png"]).save_file().await?;
                    std::fs::write(file.path(), png).ok()?;
                    Some(file.path().display().to_string())
                },
                Message::ScreenshotSaved,
            ),
            Message::ScreenshotSaved(saved) => {
                self.toast = saved.map(|path| format!("Screenshot saved to {path}"));
                Task::none()
            }
            Message::ToggleTheater => {
                self.theater = !self.theater;
                match self.window {
                    Some(id) => window::set_mode(id, if self.theater { window::Mode::Fullscreen } else { window::Mode::Windowed }),
                    None => Task::none(),
                }
            }
            Message::PointerMoved(point) => {
                self.pointer = Some(point);
                if self.pressed.is_some() && self.core.has_native_input() {
                    return self.send_pointer(point, true);
                }
                Task::none()
            }
            Message::PointerDown => {
                self.pressed = self.pointer.map(|point| (point, Instant::now()));
                match self.pointer {
                    Some(point) if self.core.has_native_input() => self.send_pointer(point, true),
                    _ => Task::none(),
                }
            }
            Message::PointerUp => {
                if self.core.has_native_input() {
                    self.pressed = None;
                    return match self.pointer {
                        Some(point) => self.send_pointer(point, false),
                        None => Task::none(),
                    };
                }
                self.on_pointer_up()
            }
            Message::Wheel(lines) => {
                let dy = (lines * 120.0).round() as i32;
                perform(&self.core, move |core| async move { core.wheel(dy).await }, |_| Message::Tick)
            }
            Message::Typed(_) => Task::none(),

            Message::Apps(apps) => {
                self.apps = apps;
                self.apps_loaded = true;
                Task::none()
            }
            Message::RefreshApps => perform(&self.core, |core| async move { core.list_apps().await }, Message::Apps),
            Message::Launch(package) => {
                self.workspace = Workspace::Device;
                Task::batch([
                    perform(&self.core, move |core| async move { core.launch_app(&package).await }, Message::Launched),
                    self.report_viewport(),
                ])
            }
            Message::Launched(_) => Task::none(),

            Message::StoreQuery(query) => {
                self.store.query = query;
                self.store.detail = None;
                self.search()
            }
            Message::StoreSearch => self.search(),
            Message::StoreResults(ticket, results) => {
                if ticket == self.store.ticket {
                    let icons: Vec<PathBuf> = results.iter().filter_map(|app| app.icon.clone()).collect();
                    self.remember_images(&icons);
                    self.store.results = results;
                    self.store.searching = false;
                }
                Task::none()
            }
            Message::StoreSource(source) => {
                self.store.source = source;
                self.store.detail = None;
                if source == Some(SourceId::Play) {
                    return Task::none();
                }
                self.search()
            }
            Message::StoreOpen(source, package) => {
                perform(&self.core, move |core| async move { core.store_detail(source, &package).await }, Message::StoreDetail)
            }
            Message::StoreDetail(detail) => {
                if let Some(detail) = &detail {
                    let images: Vec<PathBuf> = detail.app.icon.iter().chain(&detail.screenshots).cloned().collect();
                    self.remember_images(&images);
                }
                self.store.detail = detail;
                Task::none()
            }
            Message::StoreBack => {
                self.store.detail = None;
                Task::none()
            }
            Message::StoreInstall(source, package, version) => {
                perform(&self.core, move |core| async move { core.store_install(source, &package, version).await }, Message::StoreStarted)
            }
            Message::StoreStarted(job) => {
                if let Some(job) = job {
                    self.upsert_job(job);
                } else {
                    self.store.message = Some("That app could not be found in the catalogue.".into());
                }
                Task::none()
            }
            Message::StoreState(state) => {
                self.store.state = state;
                Task::none()
            }
            Message::InstallFromFile => Task::perform(
                async {
                    rfd::AsyncFileDialog::new()
                        .set_title("Choose an app to install")
                        .add_filter("Android apps", &["apk", "xapk", "apks"])
                        .pick_files()
                        .await
                        .map(|files| files.into_iter().map(|file| file.path().to_owned()).collect())
                        .unwrap_or_default()
                },
                Message::FilesChosen,
            ),
            Message::FilesChosen(paths) if paths.is_empty() => Task::none(),
            Message::FilesChosen(paths) => {
                perform(&self.core, move |core| async move { core.store_install_files(&paths).await }, Message::FilesQueued)
            }
            Message::FilesQueued(jobs) => {
                for job in jobs {
                    self.upsert_job(job);
                }
                Task::none()
            }
            Message::PlayOpen => perform(&self.core, |core| async move { core.play_open().await }, Message::PlayDone),
            Message::PlaySearch => {
                let query = self.store.query.clone();
                perform(&self.core, move |core| async move { core.play_search(&query).await }, Message::PlayDone)
            }
            Message::PlayBack => perform(&self.core, |core| async move { core.play_back().await }, Message::PlayDone),
            Message::PlayDone(ok) => {
                if ok {
                    self.workspace = Workspace::Device;
                    return self.report_viewport();
                }
                self.store.message = Some("Play didn’t open. Start the device, then try again.".into());
                Task::none()
            }

            Message::Settings(state) => {
                self.tokens = theme::resolve(state.settings.theme);
                self.tint_frame();
                self.settings.cores = None;
                self.settings.ram = None;
                self.settings.density = None;
                self.settings.working = false;
                self.settings.state = Some(state);
                Task::none()
            }
            Message::SetTheme(choice) => self.change_settings(move |s| s.theme = choice),
            Message::SetDevice(device) => self.change_settings(move |s| s.device = device),
            Message::SetEmulatorWindow(on) => self.change_settings(move |s| s.emulator_window = on),
            Message::SliderCores(value) => {
                self.settings.cores = Some(value);
                Task::none()
            }
            Message::SliderRam(value) => {
                self.settings.ram = Some(value);
                Task::none()
            }
            Message::SliderDensity(value) => {
                self.settings.density = Some(value);
                Task::none()
            }
            Message::CommitSliders => {
                let (cores, ram, density) = (self.settings.cores, self.settings.ram, self.settings.density);
                self.change_settings(move |s| {
                    if let Some(cores) = cores {
                        s.cores = Some(cores.round() as u32);
                    }
                    if let Some(ram) = ram {
                        s.ram_mb = Some(ram.round() as u32);
                    }
                    if let Some(density) = density {
                        s.density = Some(density.round() as u32);
                    }
                })
            }
            Message::AutoCores(auto) => {
                let value = self.settings.state.as_ref().map(|s| s.tuning.auto_cores);
                self.change_settings(move |s| s.cores = if auto { None } else { value })
            }
            Message::AutoRam(auto) => {
                let value = self.settings.state.as_ref().map(|s| s.tuning.auto_ram_mb);
                self.change_settings(move |s| s.ram_mb = if auto { None } else { value })
            }
            Message::AutoDensity(auto) => {
                let value = self.settings.state.as_ref().map(|s| s.tuning.auto_density);
                self.change_settings(move |s| s.density = if auto { None } else { value })
            }
            Message::ChooseFolder => Task::perform(
                async {
                    rfd::AsyncFileDialog::new().set_title("Where should Android be downloaded?").pick_folder().await.map(|f| f.path().to_owned())
                },
                Message::FolderChosen,
            ),
            Message::FolderChosen(None) => Task::none(),
            Message::FolderChosen(Some(folder)) => {
                self.settings.working = true;
                perform(&self.core, move |core| async move { core.settings_move_download_folder(&folder).await }, Message::Settings)
            }
            Message::FreeSpace => {
                self.settings.working = true;
                perform(&self.core, |core| async move { core.settings_free_space().await }, Message::Settings)
            }
            Message::RestartApp => {
                self.core.stop_mirror();
                self.core.release_guest_window();
                if let Some(installer) = self.core.update_ready_installer() {
                    let _ = oe_core::update::run_installer(&installer);
                } else if let Ok(exe) = std::env::current_exe() {
                    let _ = std::process::Command::new(exe).spawn();
                }
                iced::exit()
            }
            Message::Defender(state) => {
                self.settings.defender = Some(state);
                Task::none()
            }
            Message::SetDefender(enabled) => {
                self.settings.defender_message = None;
                perform(&self.core, move |core| async move { core.defender_set_excluded(enabled).await }, Message::DefenderDone)
            }
            Message::DefenderDone(result) => {
                self.settings.defender = Some(result.state);
                self.settings.defender_message = result.error.map(|_| "Change cancelled".to_owned());
                Task::none()
            }
            Message::UpdateCheck => perform(&self.core, |core| async move { core.update_check().await }, Message::Update),
            Message::UpdateDownload => perform(&self.core, |core| async move { core.update_download().await }, Message::Update),
            Message::UpdateInstall => self.update(Message::RestartApp),
            Message::Update(state) => {
                self.update = state;
                Task::none()
            }

            Message::Account(state) => {
                self.account.email = state.profile.email.clone().unwrap_or_default();
                self.account.name = state.profile.display_name.clone();
                self.account.state = Some(state);
                Task::none()
            }
            Message::EmailInput(value) => {
                self.account.email = value;
                Task::none()
            }
            Message::SaveEmail => {
                let email = self.account.email.clone();
                let state = self.core.account_set_email(Some(&email));
                self.update(Message::Account(state))
            }
            Message::NameInput(value) => {
                self.account.name = value;
                Task::none()
            }
            Message::SaveName => {
                let name = self.account.name.clone();
                let state = self.core.account_set_display_name(&name);
                self.update(Message::Account(state))
            }
            Message::PasswordInput(value) => {
                self.account.password = value;
                Task::none()
            }
            Message::SavePassword => {
                let password = std::mem::take(&mut self.account.password);
                let state = self.core.account_set_password(Some(&password));
                self.account.message = Some(if state.profile.has_stored_password {
                    "Password saved in the Windows keychain.".into()
                } else {
                    "The password could not be stored on this PC.".into()
                });
                self.update(Message::Account(state))
            }
            Message::ClearPassword => {
                let state = self.core.account_set_password(None);
                self.update(Message::Account(state))
            }
            Message::SetAutoFill(enabled) => {
                let state = self.core.account_set_auto_fill(enabled);
                self.update(Message::Account(state))
            }
            Message::SignOut => {
                let state = self.core.account_sign_out();
                self.update(Message::Account(state))
            }
            Message::BeginSignIn => perform(&self.core, |core| async move { core.account_begin_sign_in().await }, Message::FillDone),
            Message::Fill(field) => perform(&self.core, move |core| async move { core.account_fill(field).await }, Message::FillDone),
            Message::FillDone(result) => {
                self.account.message = Some(result.message);
                Task::none()
            }
        }
    }

    /// Reads each image file once, so drawing never touches the disk.
    fn remember_images(&mut self, paths: &[PathBuf]) {
        for path in paths {
            if !self.icons.contains_key(path) {
                if let Ok(bytes) = std::fs::read(path) {
                    self.icons.insert(path.clone(), image::Handle::from_bytes(bytes));
                }
            }
        }
    }

    pub fn image_for(&self, path: &Path) -> Option<&image::Handle> {
        self.icons.get(path)
    }

    pub fn setup_passed(&self) -> bool {
        self.setup.steps.iter().filter(|s| s.blocking).all(|s| s.status == StepState::Pass)
    }

    fn change_settings(&mut self, change: impl FnOnce(&mut oe_core::settings::Settings) + Send + 'static) -> Task<Message> {
        perform(&self.core, move |core| async move { core.settings_set(change).await }, Message::Settings)
    }

    fn upsert_job(&mut self, job: InstallJob) {
        match self.store.jobs.iter_mut().find(|known| known.id == job.id) {
            Some(known) => *known = job,
            None => self.store.jobs.insert(0, job),
        }
    }

    fn on_core_event(&mut self, event: CoreEvent) -> Task<Message> {
        match event {
            CoreEvent::Device(device) => self.set_device(device),
            CoreEvent::SetupStep(status) => {
                if let Some(step) = self.setup.steps.iter_mut().find(|s| s.id == status.id) {
                    *step = status;
                }
                Task::none()
            }
            CoreEvent::Log(_, line) => {
                if !self.ready {
                    self.setup.log.push(line);
                    let excess = self.setup.log.len().saturating_sub(400);
                    self.setup.log.drain(..excess);
                }
                Task::none()
            }
            CoreEvent::FrameReady => {
                if let Some(frame) = self.core.take_frame() {
                    self.frame = Some((image::Handle::from_rgba(frame.width, frame.height, frame.rgba), frame.width, frame.height));
                }
                Task::none()
            }
            CoreEvent::Frame(png) => {
                let size = png_size(&png);
                if let Some((width, height)) = size {
                    self.frame = Some((image::Handle::from_bytes(png), width, height));
                }
                Task::none()
            }
            CoreEvent::StoreJob(job) => {
                self.upsert_job(job);
                Task::none()
            }
            CoreEvent::StoreInstalled(package) => {
                if !self.store.installed.contains(&package) {
                    self.store.installed.push(package);
                }
                perform(&self.core, |core| async move { core.list_apps().await }, Message::Apps)
            }
            CoreEvent::StoreIndexUpdated(state) => {
                self.store.state = state;
                if self.workspace == Workspace::Store { self.search() } else { Task::none() }
            }
            CoreEvent::Update(state) => {
                self.update = state;
                Task::none()
            }
            CoreEvent::SetupProgress(done, total) => {
                self.setup.progress = Some((done, total));
                Task::none()
            }
        }
    }

    /// Windows' own title bar and edge in the strip's colour, so the window's top reads as one
    /// band, the way Graphite's page begins.
    fn tint_frame(&self) {
        #[cfg(windows)]
        if let Some(hwnd) = self.parent {
            let t = self.tokens;
            let windows_colour = |color: iced::Color| {
                let [r, g, b, _] = color.into_rgba8();
                oe_win::window::colorref(r, g, b)
            };
            oe_win::window::tint_frame(oe_win::Hwnd(hwnd), windows_colour(t.raised), windows_colour(t.text_dim), windows_colour(t.border_subtle), t.dark);
        }
    }

    fn on_key(&mut self, key: keyboard::Key, modifiers: keyboard::Modifiers) -> Task<Message> {
        use keyboard::key::Named;
        match key.as_ref() {
            keyboard::Key::Named(Named::Escape) => {
                if self.theater {
                    return self.update(Message::ToggleTheater);
                }
                if self.profile_menu {
                    self.profile_menu = false;
                    return Task::none();
                }
                if self.show_account {
                    return self.update(Message::ToggleAccount);
                }
                Task::none()
            }
            keyboard::Key::Named(Named::ArrowLeft) if modifiers.alt() && !modifiers.control() => self.update(Message::Press("KEYCODE_BACK")),
            _ if self.visible() && !modifiers.alt() && !modifiers.control() && self.core.has_native_input() => {
                let name = match key.as_ref() {
                    keyboard::Key::Named(Named::Enter) => Some("Enter"),
                    keyboard::Key::Named(Named::Backspace) => Some("Backspace"),
                    keyboard::Key::Named(Named::Delete) => Some("Delete"),
                    keyboard::Key::Named(Named::Tab) => Some("Tab"),
                    keyboard::Key::Named(Named::ArrowLeft) => Some("ArrowLeft"),
                    keyboard::Key::Named(Named::ArrowRight) => Some("ArrowRight"),
                    keyboard::Key::Named(Named::ArrowUp) => Some("ArrowUp"),
                    keyboard::Key::Named(Named::ArrowDown) => Some("ArrowDown"),
                    keyboard::Key::Named(Named::Home) => Some("Home"),
                    keyboard::Key::Named(Named::End) => Some("End"),
                    _ => None,
                };
                if let Some(name) = name {
                    return perform(&self.core, move |core| async move { core.key_name(name).await }, |_| Message::Tick);
                }
                match key.as_ref() {
                    keyboard::Key::Character(text) => {
                        let text = text.to_owned();
                        perform(&self.core, move |core| async move { core.type_text(&text).await }, |_| Message::Tick)
                    }
                    keyboard::Key::Named(Named::Space) => perform(&self.core, |core| async move { core.type_text(" ").await }, |_| Message::Tick),
                    _ => Task::none(),
                }
            }
            keyboard::Key::Character(c) if modifiers.alt() && !modifiers.control() && self.ready => match c {
                "1" => self.select(Workspace::Device),
                "2" => self.select(Workspace::Apps),
                "3" => self.select(Workspace::Store),
                "4" => self.select(Workspace::Settings),
                "a" | "A" => self.update(Message::ToggleAccount),
                "s" | "S" if !self.device.busy => {
                    self.update(if self.device.phase == EmuPhase::Running { Message::DeviceStop } else { Message::DeviceStart })
                }
                _ => Task::none(),
            },
            _ => Task::none(),
        }
    }

    /// A press and release on the mirrored screen: a tap if it barely moved, a swipe otherwise.
    /// The pointer as a finger on Android's own display, sent as it happens.
    fn send_pointer(&self, point: Point, pressed: bool) -> Task<Message> {
        let (Some((_, width, height)), Some(pane)) = (self.frame.as_ref(), self.pane) else { return Task::none() };
        let (width, height) = (*width as f32, *height as f32);
        let fit = fitted(pane.width, pane.height, width, height);
        let x = ((point.x - fit.x) / fit.width * width).clamp(0.0, width - 1.0) as i32;
        let y = ((point.y - fit.y) / fit.height * height).clamp(0.0, height - 1.0) as i32;
        perform(&self.core, move |core| async move { core.pointer(x, y, pressed).await }, |_| Message::Tick)
    }

    fn on_pointer_up(&mut self) -> Task<Message> {
        let (Some((start, at)), Some(end), Some((_, width, height)), Some(pane)) =
            (self.pressed.take(), self.pointer, self.frame.as_ref().map(|(h, w, ht)| (h.clone(), *w, *ht)), self.pane)
        else {
            return Task::none();
        };
        let fit = fitted(pane.width, pane.height, width as f32, height as f32);
        let to_guest = |p: Point| ((p.x - fit.x) / fit.width * width as f32, (p.y - fit.y) / fit.height * height as f32);
        let ((x1, y1), (x2, y2)) = (to_guest(start), to_guest(end));
        let moved = (end.x - start.x).hypot(end.y - start.y);
        let held = at.elapsed().as_millis().clamp(60, 1500) as f64;
        if moved < 12.0 {
            perform(&self.core, move |core| async move { core.tap(f64::from(x1), f64::from(y1)).await }, |_| Message::Tick)
        } else {
            perform(&self.core, move |core| async move { core.swipe(f64::from(x1), f64::from(y1), f64::from(x2), f64::from(y2), held).await }, |_| {
                Message::Tick
            })
        }
    }

    pub fn job_for(&self, source: SourceId, package: &str) -> Option<&InstallJob> {
        self.store.jobs.iter().find(|job| job.source == source && job.package_name == package)
    }

    pub fn is_installed(&self, package: &str) -> bool {
        self.store.installed.iter().any(|p| p == package) || self.apps.iter().any(|app| app.package_name == package)
            || self.store.jobs.iter().any(|job| job.state == InstallState::Done && job.resolved_package.as_deref() == Some(package))
    }

    pub fn update_phase(&self) -> UpdatePhase {
        self.update.phase
    }
}

/// The largest rectangle of the image's shape inside the pane, centred: where the mirror draws.
pub fn fitted(pane_width: f32, pane_height: f32, width: f32, height: f32) -> Rectangle {
    let scale = (pane_width / width).min(pane_height / height);
    let (w, h) = (width * scale, height * scale);
    Rectangle { x: (pane_width - w) / 2.0, y: (pane_height - h) / 2.0, width: w, height: h }
}

/// A PNG's dimensions, from its header.
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[1..4] != b"PNG" {
        return None;
    }
    let width = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(png[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

/// Runs `work` against the core and turns its answer into a message.
pub fn perform<T, F>(core: &Arc<Core>, work: impl FnOnce(Arc<Core>) -> F, to_message: impl Fn(T) -> Message + Send + 'static) -> Task<Message>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    Task::perform(work(core.clone()), to_message)
}

/// The core's events, for as long as the window is open.
fn core_events() -> impl iced::futures::Stream<Item = Message> {
    iced::stream::channel(256, async |mut output| {
        let receiver = EVENTS.lock().unwrap_or_else(|p| p.into_inner()).take();
        let Some(mut receiver) = receiver else { return };
        while let Some(event) = receiver.recv().await {
            if output.send(Message::Core(event)).await.is_err() {
                return;
            }
        }
    })
}
