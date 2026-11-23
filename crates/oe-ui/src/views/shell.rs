//! The window's frame: the title bar with its workspaces and device controls, the Android version
//! menu, and the bezel of device buttons.
//!
//! Every panel is in the flow, never floating: the guest's own window is a child window over the
//! device pane, and nothing drawn here can appear above it. The version menu pushes the pane down
//! rather than covering it.

use iced::widget::{button, column, container, row, space, text, tooltip, Column};
use iced::{Alignment, Element, Length};
use oe_core::device::EmuPhase;
use oe_engine::profiles::ProfileId;

use super::{account, action, apps, device, settings, store};
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
        main = main.push(titlebar(app));
        if app.profile_menu {
            main = main.push(profile_menu(app));
        }
    }
    if let Some(toast) = &app.toast {
        main = main.push(container(super::banner(t.ok_bg, t.ok, t.text, toast.clone())).padding([6, 12]));
    }
    main = main.push(container(stage).width(Length::Fill).height(Length::Fill));

    let mut body = row![main.width(Length::Fill)];
    if !app.show_account && (app.workspace == Workspace::Device || app.theater) {
        body = body.push(tool_rail(app));
    }
    container(body).width(Length::Fill).height(Length::Fill).style(theme::fill(t.bg)).into()
}

fn phase_label(app: &App) -> &'static str {
    match app.device.phase {
        EmuPhase::Running if app.device.boot_completed => "Running",
        EmuPhase::Running => "Booting…",
        EmuPhase::Starting => "Starting…",
        EmuPhase::Stopping => "Stopping…",
        EmuPhase::Stopped => "Stopped",
        EmuPhase::Unknown => "Checking…",
    }
}

fn titlebar(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let device = &app.device;
    let brand = row![
        icon(Icon::Brand, 20.0, t.accent),
        text("open-emulator").size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text)
    ]
    .spacing(8)
    .align_y(Alignment::Center);

    let mut nav = row![].spacing(2).align_y(Alignment::Center);
    for (index, workspace) in Workspace::ALL.into_iter().enumerate() {
        let active = app.workspace == workspace && !app.show_account;
        let glyph = match workspace {
            Workspace::Device => Icon::Device,
            Workspace::Apps => Icon::Apps,
            Workspace::Store => Icon::Store,
            Workspace::Settings => Icon::Settings,
        };
        let label = row![
            icon(glyph, 16.0, if active { t.text } else { t.muted }),
            text(workspace.label()).size(theme::TEXT_SM).font(theme::SEMIBOLD)
        ]
        .spacing(6)
        .align_y(Alignment::Center);
        let item = button(label).padding([5, 10]).style(theme::button_style(t, Kind::Nav(active))).on_press(Message::Select(workspace));
        nav = nav.push(tooltip(item, text(format!("{} (Alt+{})", workspace.label(), index + 1)).size(theme::TEXT_XS), tooltip::Position::Bottom));
    }

    let running = device.phase == EmuPhase::Running;
    let dot = match device.phase {
        EmuPhase::Running if device.boot_completed => t.ok,
        EmuPhase::Running | EmuPhase::Starting | EmuPhase::Stopping => t.warn,
        _ => t.idle,
    };
    let mut cluster = row![
        container(space().width(8).height(8)).style(move |_| iced::widget::container::Style {
            background: Some(iced::Background::Color(dot)),
            border: iced::Border { radius: 4.0.into(), ..iced::Border::default() },
            ..iced::widget::container::Style::default()
        }),
        text(phase_label(app)).size(theme::TEXT_SM).color(t.text_dim),
    ]
    .spacing(8)
    .align_y(Alignment::Center);
    if let Some(version) = &device.android_version {
        let meta = match device.api {
            Some(api) => format!("Android {version} · API {api}"),
            None => format!("Android {version}"),
        };
        cluster = cluster.push(text(meta).size(theme::TEXT_XS).color(t.faint));
    }
    if let Some(error) = &device.error {
        cluster = cluster.push(text(error.clone()).size(theme::TEXT_XS).color(t.danger).width(Length::Shrink));
    }
    if !device.provisioned && !device.busy {
        cluster = cluster.push(action(t, "Prepare device", Kind::Primary, Some(Message::DevicePrepare)));
    }
    let (label, kind, message) = match (device.busy, running) {
        (true, _) => ("Working…", Kind::Secondary, None),
        (false, true) => ("Stop", Kind::Danger, Some(Message::DeviceStop)),
        (false, false) => ("Start", Kind::Primary, Some(Message::DeviceStart)),
    };
    cluster = cluster.push(tooltip(action(t, label, kind, message), text(format!("{label} (Alt+S)")).size(theme::TEXT_XS), tooltip::Position::Bottom));
    let profile = row![
        text(device.profile.spec().label).size(theme::TEXT_SM).font(theme::SEMIBOLD),
        icon(Icon::ChevronDown, 14.0, t.muted)
    ]
    .spacing(6)
    .align_y(Alignment::Center);
    cluster = cluster.push(
        button(profile)
            .padding([6, 10])
            .style(theme::button_style(t, Kind::Secondary))
            .on_press_maybe((!device.busy).then_some(Message::ToggleProfileMenu)),
    );

    let account_label = app
        .account
        .state
        .as_ref()
        .map(|state| state.profile.display_name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Account".to_owned());
    let account = button(row![icon(Icon::Key, 14.0, t.muted), text(account_label).size(theme::TEXT_SM)].spacing(6).align_y(Alignment::Center))
        .padding([6, 10])
        .style(theme::button_style(t, Kind::Nav(app.show_account)))
        .on_press(Message::ToggleAccount);

    container(row![brand, space().width(16), nav, space().width(Length::Fill), cluster, space().width(8), account].align_y(Alignment::Center))
        .padding([0, 12])
        .height(theme::TITLEBAR_HEIGHT)
        .center_y(theme::TITLEBAR_HEIGHT)
        .width(Length::Fill)
        .style(theme::chrome(t))
        .into()
}

fn profile_menu(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let mut items = column![super::section(t, "Android version")].spacing(6);
    for profile in ProfileId::ALL {
        let spec = profile.spec();
        let chosen = profile == app.device.profile;
        let mut label = row![text(spec.label).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text)].spacing(6).align_y(Alignment::Center);
        if chosen {
            label = label.push(icon(Icon::Check, 14.0, t.accent));
        }
        let mut entry = column![label, text(spec.description).size(theme::TEXT_SM).color(t.muted)].spacing(2);
        if spec.proprietary {
            entry = entry.push(text("Includes Google software — personal use").size(theme::TEXT_XS).color(t.warn));
        }
        items = items.push(
            button(entry).width(Length::Fill).padding([8, 10]).style(theme::button_style(t, Kind::Nav(chosen))).on_press(Message::SetProfile(profile)),
        );
    }
    items = items.push(super::quiet(
        t,
        format!(
            "Each version keeps its own device and apps. Switching downloads it the first time ({}) and needs the device stopped.",
            ProfileId::Play.spec().download_hint
        ),
    ));
    // Under the button that opened it, on the right.
    container(items.max_width(560))
        .padding(12)
        .width(Length::Fill)
        .align_x(iced::alignment::Horizontal::Right)
        .style(theme::chrome(t))
        .into()
}

fn tool_rail(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let live = app.device.phase == EmuPhase::Running;
    let tool = |name: Icon, hint: &'static str, message: Option<Message>| -> Element<'_, Message> {
        let color = if message.is_some() { t.text_dim } else { t.faint };
        tooltip(
            button(container(icon(name, 18.0, color)).center(theme::BEZEL_BUTTON))
                .padding(0)
                .width(theme::BEZEL_BUTTON)
                .height(theme::BEZEL_BUTTON)
                .style(theme::button_style(t, Kind::Ghost))
                .on_press_maybe(message),
            text(hint).size(theme::TEXT_XS),
            tooltip::Position::Left,
        )
        .into()
    };
    let when_live = |message: Message| live.then_some(message);
    let rail = column![
        tool(Icon::Back, "Back (Alt+←)", when_live(Message::Press("KEYCODE_BACK"))),
        tool(Icon::Home, "Home", when_live(Message::Press("KEYCODE_HOME"))),
        tool(Icon::Recents, "Recents", when_live(Message::Press("KEYCODE_APP_SWITCH"))),
        space().height(12),
        tool(
            if app.theater { Icon::FullscreenExit } else { Icon::Fullscreen },
            if app.theater { "Exit fullscreen (Esc)" } else { "Fullscreen" },
            Some(Message::ToggleTheater)
        ),
        tool(Icon::Rotate, "Rotate", when_live(Message::Rotate)),
        tool(Icon::Screenshot, "Screenshot", when_live(Message::Screenshot)),
        space().height(Length::Fill),
        tool(Icon::VolumeDown, "Volume down", when_live(Message::Press("KEYCODE_VOLUME_DOWN"))),
        tool(Icon::VolumeUp, "Volume up", when_live(Message::Press("KEYCODE_VOLUME_UP"))),
        tool(Icon::Power, "Power", when_live(Message::Press("KEYCODE_POWER"))),
    ]
    .spacing(4)
    .padding([8, 4])
    .align_x(Alignment::Center);
    container(rail).width(theme::BEZEL_WIDTH).height(Length::Fill).style(theme::chrome(t)).into()
}

