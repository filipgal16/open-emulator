//! The window's frame, Graphite's header: a full-width announcement strip over the navigation bar,
//! then the page; and, beside the device, the bezel of device buttons.
//!
//! Every panel is in the flow, never floating: the version menu pushes the page down rather than
//! covering it, so nothing is ever drawn over the device's screen.

use iced::widget::{button, column, container, row, space, text, tooltip, Column};
use iced::{Alignment, Color, Element, Length};
use oe_core::device::EmuPhase;
use oe_core::update::UpdatePhase;
use oe_engine::profiles::ProfileId;

use super::{account, action, apps, device, go, keys, more, settings, store, tip};
use crate::app::{App, Message, Workspace};
use crate::icons::{icon, Icon};
use crate::theme::{self, Kind};

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let stage: Element<'_, Message> = if app.show_account {
        account::view(app)
    } else {
        match app.workspace {
            Workspace::Device => device::view(app),
            Workspace::Apps => apps::view(app),
            Workspace::Store => store::view(app),
            Workspace::Settings => settings::view(app),
        }
    };

    let mut main = Column::new();
    if !app.theater {
        main = main.push(strip(app));
        main = main.push(navbar(app));
        main = main.push(hairline(app));
        if app.profile_menu {
            main = main.push(profile_menu(app));
        }
    }
    main = main.push(container(stage).width(Length::Fill).height(Length::Fill));

    let mut body = row![main.width(Length::Fill)];
    if !app.show_account && (app.workspace == Workspace::Device || app.theater) {
        body = body.push(container(space().width(1)).height(Length::Fill).style(theme::rule(t)));
        body = body.push(tool_rail(app));
    }
    container(body).width(Length::Fill).height(Length::Fill).style(theme::fill(t.bg)).into()
}

fn hairline(app: &App) -> Element<'_, Message> {
    container(space().height(1)).width(Length::Fill).style(theme::rule(app.tokens)).into()
}

fn dot<'a>(color: Color) -> Element<'a, Message> {
    container(space().width(7).height(7))
        .style(move |_| iced::widget::container::Style {
            background: Some(iced::Background::Color(color)),
            border: iced::Border { radius: 4.0.into(), ..iced::Border::default() },
            ..iced::widget::container::Style::default()
        })
        .into()
}

/// The announcement strip: what is happening now, in a sentence, and the one thing to do about it.
/// A message from the app wins, then an update, then the device's state.
fn strip(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let device = &app.device;
    let latest = app.update.latest_version.clone().unwrap_or_default();
    let (mark, words, link): (Option<Color>, String, Option<(&str, Message)>) = if let Some(toast) = &app.toast {
        (None, toast.clone(), None)
    } else if app.update.phase == UpdatePhase::Ready {
        (None, format!("open-emulator {latest} is downloaded and ready."), Some(("Restart to update", Message::UpdateInstall)))
    } else if app.update.phase == UpdatePhase::Available {
        (None, format!("open-emulator {latest} is out."), Some(("Download it", Message::UpdateDownload)))
    } else if let Some(error) = &device.error {
        (Some(t.danger), error.clone(), (!device.busy).then_some(("Try again", Message::DeviceStart)))
    } else {
        match device.phase {
            EmuPhase::Running if device.boot_completed => {
                let version = match (&device.android_version, device.api) {
                    (Some(version), Some(api)) => format!("Android {version} (API {api}) is running."),
                    (Some(version), None) => format!("Android {version} is running."),
                    _ => "Android is running.".to_owned(),
                };
                (Some(t.ok), version, Some(("Open your apps", Message::Select(Workspace::Apps))))
            }
            EmuPhase::Running => (Some(t.warn), "Android is booting.".to_owned(), None),
            EmuPhase::Starting => (Some(t.warn), "Android is starting.".to_owned(), None),
            EmuPhase::Stopping => (Some(t.warn), "Android is stopping.".to_owned(), None),
            EmuPhase::Stopped if !device.provisioned => {
                (Some(t.idle), "This device hasn’t been prepared yet.".to_owned(), (!device.busy).then_some(("Prepare it", Message::DevicePrepare)))
            }
            EmuPhase::Stopped => (Some(t.idle), "Android is stopped.".to_owned(), (!device.busy).then_some(("Start it", Message::DeviceStart))),
            EmuPhase::Unknown => (Some(t.idle), "Looking for the device.".to_owned(), None),
        }
    };
    let mut line = row![].spacing(10).align_y(Alignment::Center);
    if let Some(color) = mark {
        line = line.push(dot(color));
    }
    line = line.push(text(words).size(theme::TEXT_SM).font(theme::MEDIUM).color(t.text));
    if let Some((label, message)) = link {
        line = line.push(more(t, label, Some(message)));
    }
    container(line).padding([5, 16]).height(32).center_x(Length::Fill).center_y(32).style(theme::strip(t)).into()
}

const WORKSPACE_KEYS: [&str; 4] = ["1", "2", "3", "4"];

/// Graphite's bar: the mark and wordmark, sentence-case links with a menu among them, and two
/// buttons at the right: a recessed one with its keycap, and the light one.
fn navbar(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let device = &app.device;
    let brand = row![icon(Icon::Brand, 20.0, t.text), text("open-emulator").size(theme::TEXT_LG).font(theme::SEMIBOLD).color(t.text)]
        .spacing(8)
        .align_y(Alignment::Center);

    let mut links = row![].spacing(2).align_y(Alignment::Center);
    for (index, workspace) in Workspace::ALL.into_iter().enumerate() {
        let current = app.workspace == workspace && !app.show_account;
        let link = button(text(workspace.label()).size(theme::TEXT_MD).font(theme::MEDIUM))
            .padding([6, 10])
            .style(theme::button_style(t, Kind::Link(current)))
            .on_press(Message::Select(workspace));
        links = links.push(tip(t, link, workspace.label(), &["Alt", WORKSPACE_KEYS[index]], tooltip::Position::Bottom));
    }
    // The Android version menu, as Graphite's "Features" opens one.
    let versions = button(row![text("Android").size(theme::TEXT_MD).font(theme::MEDIUM), icon(Icon::ChevronDown, 14.0, t.muted)].spacing(4).align_y(Alignment::Center))
        .padding([6, 10])
        .style(theme::button_style(t, Kind::Link(app.profile_menu)))
        .on_press_maybe((!device.busy).then_some(Message::ToggleProfileMenu));
    links = links.push(tip(t, versions, device.profile.spec().label, &[], tooltip::Position::Bottom));

    let account_label = app
        .account
        .state
        .as_ref()
        .map(|state| state.profile.display_name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Account".to_owned());
    // Recessed, with its shortcut on a keycap: Graphite's "Log in".
    let account = button(row![text(account_label).size(theme::TEXT_SM).font(theme::SEMIBOLD), keys(t, &["Alt", "A"])].spacing(10).align_y(Alignment::Center))
        .padding([5, 6])
        .style(theme::button_style(t, if app.show_account { Kind::Nav(true) } else { Kind::Secondary }))
        .on_press(Message::ToggleAccount);

    let running = device.phase == EmuPhase::Running;
    let power: Element<'_, Message> = match (device.busy, running) {
        (true, _) => action(t, "Working…", Kind::Secondary, None),
        (false, true) => action(t, "Stop", Kind::Secondary, Some(Message::DeviceStop)),
        (false, false) if !device.provisioned => go(t, "Prepare device", Some(Message::DevicePrepare)),
        (false, false) => go(t, "Start", Some(Message::DeviceStart)),
    };
    let power = tip(t, power, if running { "Stop the device" } else { "Start the device" }, &["Alt", "S"], tooltip::Position::Bottom);

    let bar = row![brand, space().width(28), links, space().width(Length::Fill), account, power].spacing(8).align_y(Alignment::Center);
    container(container(bar).max_width(theme::CONTENT_WIDTH).width(Length::Fill))
        .padding([0, 24])
        .height(theme::TITLEBAR_HEIGHT)
        .center_x(Length::Fill)
        .center_y(theme::TITLEBAR_HEIGHT)
        .style(theme::chrome(t))
        .into()
}

fn profile_menu(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let mut items = column![super::section(t, "Android version")].spacing(4);
    for profile in ProfileId::ALL {
        let spec = profile.spec();
        let chosen = profile == app.device.profile;
        let mut label = row![text(spec.label).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text)].spacing(6).align_y(Alignment::Center);
        if chosen {
            label = label.push(icon(Icon::Check, 14.0, t.accent));
        }
        let mut entry = column![label, text(spec.description).size(theme::TEXT_SM).color(t.muted)].spacing(2);
        if spec.proprietary {
            entry = entry.push(text("Includes Google software: personal use").size(theme::TEXT_XS).color(t.warn));
        }
        items = items.push(
            button(entry).width(Length::Fill).padding([8, 10]).style(theme::button_style(t, Kind::Nav(chosen))).on_press(Message::SetProfile(profile)),
        );
    }
    items = items.push(
        container(super::quiet(
            t,
            format!(
                "Each version keeps its own device and apps. Switching downloads it the first time ({}) and needs the device stopped.",
                ProfileId::Play.spec().download_hint
            ),
        ))
        .padding([6, 10]),
    );
    // Under the bar, at the start of the content column, where its link is.
    let menu = container(items).padding(8).max_width(560).style(theme::menu(t));
    container(container(menu).max_width(theme::CONTENT_WIDTH).width(Length::Fill)).padding([8, 24]).center_x(Length::Fill).into()
}

fn tool_rail(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let live = app.device.phase == EmuPhase::Running;
    let tool = |name: Icon, hint: &'static str, shortcut: &[&'static str], message: Option<Message>| -> Element<'_, Message> {
        let color = if message.is_some() { t.text_dim } else { t.faint };
        tip(
            t,
            button(container(icon(name, 18.0, color)).center(theme::BEZEL_BUTTON))
                .padding(0)
                .width(theme::BEZEL_BUTTON)
                .height(theme::BEZEL_BUTTON)
                .style(theme::button_style(t, Kind::Ghost))
                .on_press_maybe(message),
            hint,
            shortcut,
            tooltip::Position::Left,
        )
    };
    let when_live = |message: Message| live.then_some(message);
    let rail = column![
        tool(Icon::Back, "Back", &["Alt", "←"], when_live(Message::Press("KEYCODE_BACK"))),
        tool(Icon::Home, "Home", &[], when_live(Message::Press("KEYCODE_HOME"))),
        tool(Icon::Recents, "Recents", &[], when_live(Message::Press("KEYCODE_APP_SWITCH"))),
        space().height(12),
        if app.theater {
            tool(Icon::FullscreenExit, "Exit fullscreen", &["Esc"], Some(Message::ToggleTheater))
        } else {
            tool(Icon::Fullscreen, "Fullscreen", &[], Some(Message::ToggleTheater))
        },
        tool(Icon::Rotate, "Rotate", &[], when_live(Message::Rotate)),
        tool(Icon::Screenshot, "Screenshot", &[], when_live(Message::Screenshot)),
        space().height(Length::Fill),
        tool(Icon::VolumeDown, "Volume down", &[], when_live(Message::Press("KEYCODE_VOLUME_DOWN"))),
        tool(Icon::VolumeUp, "Volume up", &[], when_live(Message::Press("KEYCODE_VOLUME_UP"))),
        tool(Icon::Power, "Power", &[], when_live(Message::Press("KEYCODE_POWER"))),
    ]
    .spacing(4)
    .padding([10, 6])
    .align_x(Alignment::Center);
    container(rail).width(theme::BEZEL_WIDTH).height(Length::Fill).style(theme::chrome(t)).into()
}
