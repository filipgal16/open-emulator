//! open-emulator: Android on your PC.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use oe_core::core::{Core, CorePaths};
use oe_ui::app::{App, CORE, EVENTS};

fn main() -> iced::Result {
    // The core's background work (downloads, the status poll, update checks) runs on this
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

    // Inter, the closest open font to Graphite's type, built in so it looks the same on every PC.
    let result = iced::application(App::boot, App::update, App::view)
        .title("open-emulator")
        .theme(App::theme)
        .subscription(App::subscription)
        .font(include_bytes!("../assets/fonts/Inter-Regular.ttf").as_slice())
        .font(include_bytes!("../assets/fonts/Inter-Medium.ttf").as_slice())
        .font(include_bytes!("../assets/fonts/Inter-SemiBold.ttf").as_slice())
        .default_font(oe_ui::theme::REGULAR)
        .window(iced::window::Settings {
            size: iced::Size::new(1100.0, 760.0),
            min_size: Some(iced::Size::new(900.0, 620.0)),
            icon: iced::window::icon::from_file_data(include_bytes!("../assets/icon.png"), None).ok(),
            ..iced::window::Settings::default()
        })
        .exit_on_close_request(false)
        .run();
    // Nothing still running in the background may hold a closed app open. Dropping a runtime
    // waits for its blocking work, and a call stuck on the guest (an adb read, a window of the
    // emulator's that does not answer) would keep the process alive, windowless, until it returned.
    drop(_entered);
    runtime.shutdown_background();
    result
}
