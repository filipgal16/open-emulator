//! Settings: appearance, the identity the device reports, display and performance, storage, the
//! antivirus exclusion, and updates.

use iced::widget::{button, column, container, progress_bar, row, scrollable, slider, space, text, toggler, Column};
use iced::{Alignment, Element, Length};
use oe_core::core::SettingsState;
use oe_core::settings::{DeviceId, ThemeChoice, DENSITY_MAX, DENSITY_MIN, DENSITY_STEP, RAM_MAX_MB, RAM_MIN_MB, RAM_STEP_MB};
use oe_core::update::UpdatePhase;
use oe_engine::defender::ExclusionState;
use oe_store::types::format_bytes;

use super::{action, body, empty, heading, megabytes, quiet, section};
use crate::app::{App, Message};
use crate::theme::{self, Kind, Tokens};

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let Some(state) = &app.settings.state else {
        return empty(t, "Settings", "Loading…".into(), None);
    };
    let mut page = column![heading(t, "Settings")].spacing(24).max_width(720);
    if !state.tuning.accelerated {
        page = page.push(super::banner(
            t.warn_bg,
            t.warn_border,
            t.text,
            format!("Left to do before a fast start: {}", state.tuning.acceleration_detail),
        ));
    }
    page = page.push(appearance(t, state));
    page = page.push(identity(t, state));
    page = page.push(display(app, state));
    page = page.push(performance(app, state));
    page = page.push(storage(app, state));
    page = page.push(antivirus(app));
    page = page.push(updates(app));
    page = page.push(shortcuts(t));
    scrollable(container(page).padding(24).center_x(Length::Fill)).height(Length::Fill).into()
}

fn block<'a>(t: Tokens, title: &'a str, content: Column<'a, Message>) -> Element<'a, Message> {
    column![section(t, title), container(content.spacing(10)).padding(16).width(Length::Fill).style(theme::panel(t))].spacing(8).into()
}

fn appearance(t: Tokens, state: &SettingsState) -> Element<'_, Message> {
    let mut choices = row![].spacing(4);
    for (label, choice) in [("System", ThemeChoice::System), ("Light", ThemeChoice::Light), ("Dark", ThemeChoice::Dark)] {
        choices = choices.push(
            button(text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD))
                .padding([6, 14])
                .style(theme::button_style(t, Kind::Nav(state.settings.theme == choice)))
                .on_press(Message::SetTheme(choice)),
        );
    }
    let note = if state.settings.theme == ThemeChoice::System {
        "Follows Windows. Light or dark is an override that stays put."
    } else {
        "This window only — Windows itself is unchanged."
    };
    block(t, "Appearance", column![choices, quiet(t, note)])
}

fn identity(t: Tokens, state: &SettingsState) -> Element<'_, Message> {
    let mut list = Column::new().spacing(6);
    for device in DeviceId::ALL {
        let chosen = state.settings.device == device;
        list = list.push(
            button(column![
                text(device.label()).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text),
                text(device.description()).size(theme::TEXT_SM).color(t.muted),
            ]
            .spacing(2))
            .width(Length::Fill)
            .padding([8, 10])
            .style(theme::button_style(t, Kind::Nav(chosen)))
            .on_press(Message::SetDevice(device)),
        );
    }
    block(t, "Device identity", list.push(quiet(t, "Takes effect the next time you start the device.")))
}

/// A slider with an Automatic switch: off, the value is the user's; on, it is this machine's.
#[allow(clippy::too_many_arguments)]
fn slider_field<'a>(
    t: Tokens,
    label: &'a str,
    value: f64,
    automatic: bool,
    range: std::ops::RangeInclusive<f64>,
    step: f64,
    shown: String,
    advice: String,
    on_change: fn(f64) -> Message,
    on_auto: fn(bool) -> Message,
) -> Element<'a, Message> {
    let mut field = column![
        row![
            text(label).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text),
            space().width(Length::Fill),
            text(shown).size(theme::TEXT_MD).color(t.text_dim),
        ]
        .align_y(Alignment::Center),
    ]
    .spacing(8);
    if !automatic {
        field = field.push(slider(range, value, on_change).step(step).on_release(Message::CommitSliders));
    }
    field = field.push(toggler(automatic).label("Automatic").size(18).text_size(theme::TEXT_SM).on_toggle(on_auto));
    field = field.push(quiet(t, advice));
    field.into()
}

fn display<'a>(app: &'a App, state: &'a SettingsState) -> Element<'a, Message> {
    let t = app.tokens;
    let tuning = &state.tuning;
    let automatic = state.settings.density.is_none();
    let density = app.settings.density.unwrap_or(f64::from(tuning.density));
    let advice = if density <= 200.0 {
        "Tablet-sized: small text and a lot of room. Takes effect the next time you start the device."
    } else if density >= 400.0 {
        "Phone-sized: large text and buttons. Takes effect the next time you start the device."
    } else {
        "Takes effect the next time you start the device."
    };
    block(
        t,
        "Display",
        column![slider_field(
            t,
            "Interface size",
            density,
            automatic,
            f64::from(DENSITY_MIN)..=f64::from(DENSITY_MAX),
            f64::from(DENSITY_STEP),
            format!("{} dpi", density.round()),
            advice.into(),
            Message::SliderDensity,
            Message::AutoDensity,
        )],
    )
}

fn performance<'a>(app: &'a App, state: &'a SettingsState) -> Element<'a, Message> {
    let t = app.tokens;
    let tuning = &state.tuning;
    let cores = app.settings.cores.unwrap_or(f64::from(tuning.cores));
    let ram = app.settings.ram.unwrap_or(f64::from(tuning.ram_mb));
    let max_cores = f64::from(tuning.host_cpus.max(1));
    let cores_advice = if !tuning.accelerated {
        "Without acceleration, more than two cores usually makes Android slower, not faster.".to_owned()
    } else if cores >= max_cores {
        "That is every core this PC has. Windows and Android will compete for them, and both get slower.".to_owned()
    } else {
        format!("Uses {} of this PC's {}, leaving the rest for Windows.", cores.round(), tuning.host_cpus)
    };
    let ram_advice = if ram > (tuning.host_ram_mb as f64) / 2.0 {
        format!("More than half of this PC's {}. Windows may slow down while Android is running.", megabytes(tuning.host_ram_mb as u32))
    } else if (ram - f64::from(tuning.auto_ram_mb)).abs() < 1.0 {
        format!("Gives Android {}: enough for most apps, and quick to resume.", megabytes(ram as u32))
    } else if ram > f64::from(tuning.auto_ram_mb) {
        "More memory helps large games. Resuming takes a little longer, because there is more to bring back.".to_owned()
    } else {
        format!("Less than the automatic {}. Lighter on this PC, but large games may close themselves.", megabytes(tuning.auto_ram_mb))
    };
    let graphics = match tuning.gpu_mode.as_str() {
        "host" => "This PC's graphics card",
        "swiftshader_indirect" => "Software (SwiftShader)",
        "angle_indirect" => "Software (ANGLE)",
        other => other,
    };
    let facts = column![
        quiet(t, format!("This PC: {} processors, {}", tuning.host_cpus, megabytes(tuning.host_ram_mb as u32))),
        quiet(t, format!("Graphics: {graphics}")),
        quiet(t, format!("Acceleration: {}", tuning.acceleration_detail)),
        quiet(t, "Running natively on Windows".to_owned()),
    ]
    .spacing(2);
    let host_ram = (tuning.host_ram_mb as f64 - 2048.0).clamp(f64::from(RAM_MIN_MB), f64::from(RAM_MAX_MB));
    block(
        t,
        "Performance",
        column![
            facts,
            slider_field(
                t,
                "Processor",
                cores,
                state.settings.cores.is_none(),
                1.0..=max_cores,
                1.0,
                format!("{} cores", cores.round()),
                cores_advice,
                Message::SliderCores,
                Message::AutoCores,
            ),
            slider_field(
                t,
                "Memory",
                ram,
                state.settings.ram_mb.is_none(),
                f64::from(RAM_MIN_MB)..=host_ram,
                f64::from(RAM_STEP_MB),
                megabytes(ram as u32),
                ram_advice,
                Message::SliderRam,
                Message::AutoRam,
            ),
        ],
    )
}

fn storage<'a>(app: &'a App, state: &'a SettingsState) -> Element<'a, Message> {
    let t = app.tokens;
    let storage = &state.storage;
    let size = if storage.total_bytes > 0 { format!("{} is here right now.", format_bytes(storage.total_bytes)) } else { "Nothing is here yet.".into() };
    let mut content = column![
        text("Where Android is downloaded").size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text),
        text(storage.root.display().to_string()).size(theme::TEXT_SM).font(theme::MONO).color(t.text_dim),
        quiet(t, format!("This is several gigabytes — the largest thing the app puts on a disk. Changing the folder moves what has already been downloaded; nothing is re-downloaded. {size}")),
        row![
            action(t, if app.settings.working { "Working…" } else { "Change folder" }, Kind::Secondary, (!app.settings.working).then_some(Message::ChooseFolder)),
            if storage.reclaimable_bytes > 0 {
                action(t, format!("Free {}", format_bytes(storage.reclaimable_bytes)), Kind::Secondary, (!app.settings.working).then_some(Message::FreeSpace))
            } else {
                quiet(t, "Nothing to free")
            },
        ]
        .spacing(8)
        .align_y(Alignment::Center),
    ];
    if let Some(message) = &state.last_message {
        content = content.push(body(t, message.clone()));
        if message.contains("restarts") {
            content = content.push(action(t, "Restart to apply", Kind::Primary, Some(Message::RestartApp)));
        }
    }
    block(t, "Storage", content)
}

fn antivirus(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let state = app.settings.defender;
    let excluded = state == Some(ExclusionState::Excluded);
    let mut content = column![
        body(t, "Windows Defender scans every write, and a starting device writes a lot. Excluding the emulator's own folder makes starts quicker. Windows will ask for permission."),
    ];
    content = match state {
        Some(ExclusionState::Unknown) | None => content.push(quiet(t, "Defender's settings could not be read on this PC.")),
        Some(_) => content.push(toggler(excluded).label("Exclude the emulator folder from scanning").text_size(theme::TEXT_SM).on_toggle(Message::SetDefender)),
    };
    if let Some(message) = &app.settings.defender_message {
        content = content.push(quiet(t, message.clone()));
    }
    block(t, "Antivirus", content)
}

fn updates(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let state = &app.update;
    let current = &state.current_version;
    let (title, detail) = match state.phase {
        UpdatePhase::Unsupported => (format!("Version {current}"), state.message.clone()),
        UpdatePhase::Idle => (format!("Version {current}"), Some("New versions are looked for in the background. Nothing is downloaded until you choose to.".into())),
        UpdatePhase::Checking => ("Checking for updates…".into(), None),
        UpdatePhase::UpToDate => (format!("Version {current} is the latest"), None),
        UpdatePhase::Available => (
            format!("Version {} is available", state.latest_version.clone().unwrap_or_default()),
            Some(format!("You have {current}. It downloads only when you press the button.")),
        ),
        UpdatePhase::Downloading => (format!("Downloading {}… {}%", state.latest_version.clone().unwrap_or_else(|| "the update".into()), state.percent.unwrap_or(0)), None),
        UpdatePhase::Ready => (format!("{} is ready to install", state.latest_version.clone().unwrap_or_else(|| "The update".into())), None),
        UpdatePhase::Error => (state.message.clone().unwrap_or_else(|| "Updating failed.".into()), None),
    };
    let mut content = column![text(title).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text)];
    if let Some(detail) = detail {
        content = content.push(quiet(t, detail));
    }
    if state.phase == UpdatePhase::Downloading {
        content = content.push(progress_bar(0.0..=100.0, f32::from(state.percent.unwrap_or(0))).girth(6));
    }
    let button = match state.phase {
        UpdatePhase::Unsupported | UpdatePhase::Checking | UpdatePhase::Downloading => None,
        UpdatePhase::Available => Some(action(t, "Download", Kind::Primary, Some(Message::UpdateDownload))),
        UpdatePhase::Ready => Some(action(t, "Restart to update", Kind::Primary, Some(Message::UpdateInstall))),
        UpdatePhase::Error => Some(action(t, "Try again", Kind::Secondary, Some(Message::UpdateCheck))),
        UpdatePhase::UpToDate => Some(action(t, "Check again", Kind::Secondary, Some(Message::UpdateCheck))),
        UpdatePhase::Idle => Some(action(t, "Check for updates", Kind::Secondary, Some(Message::UpdateCheck))),
    };
    if let Some(button) = button {
        content = content.push(button);
    }
    block(t, "Updates", content)
}

fn shortcuts(t: Tokens) -> Element<'static, Message> {
    let mut list = Column::new().spacing(4);
    for (keys, what) in [
        ("Alt+1", "Device"),
        ("Alt+2", "Apps"),
        ("Alt+3", "Store"),
        ("Alt+4", "Settings"),
        ("Alt+S", "Start or stop the device"),
        ("Alt+←", "Android Back"),
        ("Esc", "Close the current panel, menu, or fullscreen"),
    ] {
        list = list.push(row![text(keys).size(theme::TEXT_SM).font(theme::MONO).color(t.text).width(90), quiet(t, what)].spacing(12));
    }
    block(t, "Keyboard", list)
}
