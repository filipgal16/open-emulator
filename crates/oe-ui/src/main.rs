//! open-emulator: Android on your PC.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use oe_core::core::{Core, CorePaths};
use oe_ui::app::{App, CORE, EVENTS};

fn main() -> iced::Result {
    // The core's background work — downloads, the status poll, update checks — runs on this
    // runtime, which lives as long as the app.
    let runtime = tokio::runtime::Runtime::new().expect("the async runtime starts");
    let _entered = runtime.enter();
    let paths = match CorePaths::discover() {
        Ok(paths) => paths,
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("open-emulator")
                .set_description(format!("open-emulator can't start: {}", error.0))
                .set_level(rfd::MessageLevel::Error)
                .show();
            return Ok(());
        }
    };
    let (core, events) = Core::start(paths, env!("CARGO_PKG_VERSION"));
    let _ = CORE.set(core);
    *EVENTS.lock().unwrap_or_else(|p| p.into_inner()) = Some(events);

    iced::application(App::boot, App::update, App::view)
        .title("open-emulator")
        .theme(App::theme)
        .subscription(App::subscription)
        .default_font(iced::Font::with_name("Segoe UI"))
        .window(iced::window::Settings {
            size: iced::Size::new(1100.0, 760.0),
            min_size: Some(iced::Size::new(900.0, 620.0)),
            icon: iced::window::icon::from_file_data(include_bytes!("../assets/icon.png"), None).ok(),
            ..iced::window::Settings::default()
        })
        .exit_on_close_request(false)
        .run()
}
