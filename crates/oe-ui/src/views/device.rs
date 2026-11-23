//! The device pane: the guest's own window sits over it when embedded; otherwise this shows the
//! mirrored screen, or says where the device is in starting up.

use iced::widget::{column, container, image, mouse_area, row, text, Stack};
use iced::{Alignment, ContentFit, Element, Length};
use oe_core::device::{DeviceState, EmuPhase};

use super::action;
use crate::app::{App, Message};
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

const FIRST_RUN: &str = "First-time setup takes about a minute. You can browse Apps and the Store while this finishes — the device will be ready when you come back.";

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

fn title(kind: Idle, device: &DeviceState) -> &'static str {
    match kind {
        Idle::Checking => "Looking for the device",
        Idle::Idle if device.error.is_some() => "Couldn’t start",
        Idle::Idle => "Your Android device",
        Idle::Starting if device.provisioned => "Starting Android",
        Idle::Booting if device.provisioned => "Booting Android",
        Idle::Starting | Idle::Booting => "Preparing your device",
        Idle::Waiting => "Android is running",
        Idle::Stopping => "Stopping",
    }
}

fn copy(kind: Idle, device: &DeviceState) -> String {
    match kind {
        Idle::Checking => "Checking whether Android is already running.".into(),
        Idle::Idle if device.provisioned => "A real Android phone, on this PC. Start it to install apps and use them here.".into(),
        Idle::Idle => "A real Android phone, on this PC. The first start prepares the device and can take a few minutes; later ones come back from a snapshot.".into(),
        Idle::Starting if !device.provisioned => FIRST_RUN.into(),
        Idle::Starting if device.snapshot => "Coming back from a snapshot — this is usually quick.".into(),
        Idle::Starting => "The first boot can take up to a minute. Later starts resume from a snapshot.".into(),
        Idle::Booting if device.provisioned => "Android is up. Waiting for it to finish booting — this can take a minute the first time.".into(),
        Idle::Booting => FIRST_RUN.into(),
        Idle::Waiting => "Waiting for the first frame.".into(),
        Idle::Stopping => "The device is shutting down.".into(),
    }
}

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let pane = probe(Message::Pane).background(t.bg_deep);
    let mut layers = Stack::new().width(Length::Fill).height(Length::Fill).push(pane);
    // Nothing is drawn over an embedded guest: its window is on top of anything here anyway.
    if !app.embedded {
        let overlay: Element<'_, Message> = match &app.frame {
            Some((handle, _, _)) if app.mirroring => mouse_area(image(handle.clone()).content_fit(ContentFit::Contain).width(Length::Fill).height(Length::Fill))
                .on_move(Message::PointerMoved)
                .on_press(Message::PointerDown)
                .on_release(Message::PointerUp)
                .into(),
            _ => placeholder(t, app),
        };
        layers = layers.push(overlay);
    }
    layers.into()
}

fn placeholder<'a>(t: Tokens, app: &'a App) -> Element<'a, Message> {
    let device = &app.device;
    let kind = kind(device);
    let mut card = column![
        text(title(kind, device)).size(theme::TEXT_2XL).font(theme::SEMIBOLD).color(t.text),
        text(copy(kind, device)).size(theme::TEXT_MD).color(t.text_dim),
    ]
    .spacing(10)
    .align_x(Alignment::Center)
    .max_width(460);

    if let Some(error) = &device.error {
        card = card.push(text(error.clone()).size(theme::TEXT_SM).color(t.danger));
    }
    match kind {
        Idle::Idle => {
            card = card.push(action(
                t,
                if device.error.is_some() { "Try again" } else { "Start device" },
                Kind::Primary,
                (!device.busy).then_some(Message::DeviceStart),
            ));
        }
        Idle::Starting | Idle::Booting | Idle::Waiting => {
            // There is no percentage to give, so this says where the wait is instead.
            let current = match kind {
                Idle::Starting => 0,
                Idle::Booting => 1,
                _ => 2,
            };
            let mut stages = row![].spacing(16).align_y(Alignment::Center);
            for (index, stage) in ["Start", "Boot", "Display"].into_iter().enumerate() {
                let color = match index.cmp(&current) {
                    std::cmp::Ordering::Less => t.ok,
                    std::cmp::Ordering::Equal => t.text,
                    std::cmp::Ordering::Greater => t.faint,
                };
                stages = stages.push(text(stage).size(theme::TEXT_SM).font(theme::SEMIBOLD).color(color));
            }
            card = card.push(stages);
            if let Some(since) = app.busy_since {
                card = card.push(text(format!("{} s", since.elapsed().as_secs())).size(theme::TEXT_XS).color(t.faint));
            }
        }
        _ => {}
    }
    container(card).center(Length::Fill).into()
}
