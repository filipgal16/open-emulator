//! The device pane: Android's screen, drawn here from the emulator's stream, when it is showing;
//! otherwise Graphite's hero, saying where the device is and what to do about it.

use iced::widget::{column, container, image, mouse_area, row, space, text, Row, Stack};
use iced::{Alignment, ContentFit, Element, Length};
use oe_core::device::{DeviceState, EmuPhase};

use super::{action, go, megabytes};
use crate::app::{App, Message};
use crate::icons::neon_mark;
use crate::probe::probe;
use crate::theme::{self, Kind, Tokens};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Idle {
    Checking,
    Idle,
    Starting,
    Booting,
    Waiting,
    Stopping,
}

const FIRST_RUN: &str = "First-time setup takes about a minute. You can browse Apps and the Store while this finishes. The device will be ready when you come back.";

fn kind(device: &DeviceState) -> Idle {
    match device.phase {
        EmuPhase::Stopping => Idle::Stopping,
        EmuPhase::Starting => Idle::Starting,
        _ if device.busy && device.phase != EmuPhase::Running => Idle::Starting,
        EmuPhase::Running if device.boot_completed => Idle::Waiting,
        EmuPhase::Running => Idle::Booting,
        EmuPhase::Unknown => Idle::Checking,
        EmuPhase::Stopped => Idle::Idle,
    }
}

/// The headline: a sentence, with its full stop, as Graphite's is.
fn headline(kind: Idle, device: &DeviceState) -> &'static str {
    match kind {
        Idle::Checking => "Looking for your device.",
        Idle::Idle if device.error.is_some() => "Android couldn’t start.",
        Idle::Idle => "Your Android phone, right on this PC.",
        Idle::Starting if device.provisioned => "Starting Android.",
        Idle::Booting if device.provisioned => "Booting Android.",
        Idle::Starting | Idle::Booting => "Preparing your device.",
        Idle::Waiting => "Android is running.",
        Idle::Stopping => "Stopping Android.",
    }
}

fn copy(kind: Idle, device: &DeviceState) -> String {
    match kind {
        Idle::Checking => "Checking whether Android is already running.".into(),
        Idle::Idle if device.provisioned => "A real Android phone in one window. Start it to install apps from the Store and use them here.".into(),
        Idle::Idle => "A real Android phone in one window. The first start prepares the device and can take a few minutes.".into(),
        Idle::Starting if !device.provisioned => FIRST_RUN.into(),
        Idle::Starting if device.snapshot => "Coming back from a snapshot. This is usually quick.".into(),
        Idle::Starting => "The first boot can take up to a minute. Later starts resume from a snapshot.".into(),
        Idle::Booting if device.provisioned => "Android is up. Waiting for it to finish booting. This can take a minute the first time.".into(),
        Idle::Booting => FIRST_RUN.into(),
        Idle::Waiting => "Waiting for the first frame.".into(),
        Idle::Stopping => "The device is shutting down.".into(),
    }
}

/// The fine print under the buttons.
fn fine_print(kind: Idle, device: &DeviceState) -> Option<&'static str> {
    match kind {
        Idle::Idle if device.provisioned => Some("Starts come back from a snapshot when there is one, usually in seconds."),
        Idle::Idle => Some("You can browse Apps and the Store while the device is prepared."),
        _ => None,
    }
}

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let showing = app.mirroring && app.frame.is_some();
    // The screen sits on a deeper black; the hero on the page itself.
    let pane = probe(Message::Pane).background(if showing { t.bg_deep } else { t.bg });
    let mut layers = Stack::new().width(Length::Fill).height(Length::Fill).push(pane);
    // Nothing is drawn over an embedded guest: its window is on top of anything here anyway.
    if !app.embedded {
        let overlay: Element<'_, Message> = match &app.frame {
            Some((handle, _, _)) if app.mirroring => mouse_area(image(handle.clone()).content_fit(ContentFit::Contain).width(Length::Fill).height(Length::Fill))
                .on_move(Message::PointerMoved)
                .on_press(Message::PointerDown)
                .on_release(Message::PointerUp)
                .on_scroll(|delta| Message::Wheel(match delta {
                    iced::mouse::ScrollDelta::Lines { y, .. } => y,
                    iced::mouse::ScrollDelta::Pixels { y, .. } => y / 40.0,
                }))
                .into(),
            _ => placeholder(t, app),
        };
        layers = layers.push(overlay);
    }
    layers.into()
}

/// What this device is, in one muted row, where Graphite lines up its customers' logos.
fn facts<'a>(t: Tokens, app: &'a App) -> Element<'a, Message> {
    let device = &app.device;
    let mut items = vec![device.profile.spec().label.to_owned()];
    if let Some(version) = &device.android_version {
        items.push(format!("Android {version}"));
    }
    if let Some(api) = device.api {
        items.push(format!("API {api}"));
    }
    if let Some(state) = &app.settings.state {
        items.push(format!("{} cores", state.tuning.cores));
        items.push(format!("{} memory", megabytes(state.tuning.ram_mb)));
    }
    let mut line = Row::new().spacing(22).align_y(Alignment::Center).push(text("This device").size(theme::TEXT_XS).color(t.faint));
    for item in items {
        line = line.push(text(item).size(theme::TEXT_SM).font(theme::SEMIBOLD).color(t.faint));
    }
    line.into()
}

/// Graphite's hero: a text stack holding about half the width, and the neon mark floating in the
/// open space at the right.
fn hero<'a>(t: Tokens, left: iced::widget::Column<'a, Message>) -> Element<'a, Message> {
    let split = row![
        container(left.max_width(500)).width(Length::FillPortion(11)),
        container(neon_mark(300.0, t.dark)).center_x(Length::FillPortion(9)),
    ]
    .spacing(32)
    .align_y(Alignment::Center);
    container(container(split).max_width(theme::CONTENT_WIDTH).width(Length::Fill).padding([0, 56])).center(Length::Fill).into()
}

fn placeholder<'a>(t: Tokens, app: &'a App) -> Element<'a, Message> {
    let device = &app.device;
    let words = |title: &'a str, copy: String| {
        column![text(title).size(theme::DISPLAY_XL).font(theme::HEADLINE).color(t.text), text(copy).size(theme::TEXT_LG).color(t.muted)].spacing(18)
    };
    if app.own_window() && device.phase == EmuPhase::Running {
        let left = words(
            "Android is in its own window.",
            "“Show the emulator's own window” is on in Settings, so Android opens in a window of its own. Turn it off to see Android here.".into(),
        );
        return hero(t, left);
    }
    let kind = kind(device);
    let mut left = words(headline(kind, device), copy(kind, device));

    if let Some(error) = &device.error {
        left = left.push(text(error.clone()).size(theme::TEXT_SM).color(t.danger));
    }
    match kind {
        Idle::Idle => {
            left = left.push(
                row![
                    go(t, if device.error.is_some() { "Try again" } else { "Start device" }, (!device.busy).then_some(Message::DeviceStart)),
                    action(t, "Android version", Kind::Secondary, (!device.busy).then_some(Message::ToggleProfileMenu)),
                ]
                .spacing(10)
                .align_y(Alignment::Center),
            );
        }
        Idle::Starting | Idle::Booting | Idle::Waiting => {
            // There is no percentage to give, so this says where the wait is instead.
            let current = match kind {
                Idle::Starting => 0,
                Idle::Booting => 1,
                _ => 2,
            };
            let mut stages = row![].spacing(18).align_y(Alignment::Center);
            for (index, stage) in ["Start", "Boot", "Display"].into_iter().enumerate() {
                let color = match index.cmp(&current) {
                    std::cmp::Ordering::Less => t.ok,
                    std::cmp::Ordering::Equal => t.text,
                    std::cmp::Ordering::Greater => t.faint,
                };
                stages = stages.push(text(stage).size(theme::TEXT_SM).font(theme::SEMIBOLD).color(color));
            }
            if let Some(since) = app.busy_since {
                stages = stages.push(text(format!("{} s", since.elapsed().as_secs())).size(theme::TEXT_XS).color(t.faint));
            }
            left = left.push(stages);
        }
        _ => {}
    }
    if let Some(fine) = fine_print(kind, device) {
        left = left.push(text(fine).size(theme::TEXT_SM).color(t.faint));
    }
    left = left.push(space().height(14)).push(facts(t, app));
    hero(t, left)
}
