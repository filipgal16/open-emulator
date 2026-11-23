//! A stand-in for the emulator's window: a GPU-rendered window that never stops presenting frames,
//! painted a colour nothing in the host uses, so a screen sample can tell whether it is visible.
//!
//! Used by `embed_spike` while the real emulator cannot run on this machine.

use iced::widget::{center, container, text};
use iced::{window, Color, Element, Length, Subscription, Theme};

/// Pure magenta: the host never paints it.
pub const GUEST_COLOR: Color = Color::from_rgb(1.0, 0.0, 1.0);

#[derive(Default)]
struct Guest {
    frames: u64,
}

#[derive(Debug, Clone)]
enum Message {
    Frame,
}

fn update(guest: &mut Guest, message: Message) {
    match message {
        Message::Frame => guest.frames += 1,
    }
}

fn view(guest: &Guest) -> Element<'_, Message> {
    container(center(text(format!("guest frame {}", guest.frames)).size(28).color(Color::WHITE)))
        .width(Length::Fill)
        .height(Length::Fill)
        .style(|_theme: &Theme| container::Style::default().background(GUEST_COLOR))
        .into()
}

fn subscription(_guest: &Guest) -> Subscription<Message> {
    // Redraw every frame, like a running guest does.
    window::frames().map(|_| Message::Frame)
}

fn main() -> iced::Result {
    iced::application(Guest::default, update, view)
        .title("fake guest")
        .subscription(subscription)
        .window_size((360.0, 640.0))
        .run()
}
