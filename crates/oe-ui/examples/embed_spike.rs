//! Phase 0's go/no-go check: can an iced window host another process's GPU-rendered window in a
//! rectangle of its layout, the way the app hosts the emulator?
//!
//! Starts `fake_guest`, finds its window, reparents it over the right-hand pane, keeps it placed
//! as the window resizes, and lets the left rail hide and show it. With `--auto` it runs a script
//! and samples the screen in the middle of the guest at each step: after embedding, after the host
//! window is resized, while hidden, and shown again. It exits 0 if the screen showed the guest
//! exactly when it should — the host's renderer never painted over the child, and hiding it really
//! uncovered the host — and 1 if not.
//!
//! `ICED_BACKEND=tiny-skia` runs the host on the software renderer, the fallback if the GPU one
//! paints over child windows; `WGPU_BACKEND=dx12|vulkan|gl` picks the GPU API.

use std::process::{Child, Command};
use std::time::{Duration, Instant};

use iced::widget::{button, column, container, row, text};
use iced::{event, time, window, Color, Element, Length, Rectangle, Size, Subscription, Task, Theme};
use oe_ui::probe::{probe, to_physical};
use oe_win::guest_window::{GuestWindow, ATTACH_POLL, ATTACH_TIMEOUT, WATCH_INTERVAL};
use oe_win::window::{find_main_window_for_process_tree, Win32Embed};
use oe_win::{Hwnd, Rect};
use raw_window_handle::RawWindowHandle;

/// The pane behind the guest: dark grey, never magenta.
const PANE: Color = Color::from_rgb(0.12, 0.12, 0.13);

/// How long each step of the `--auto` script lets the screen settle before sampling it.
const SETTLE: Duration = Duration::from_millis(1500);

/// The steps of the `--auto` script, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Embedded,
    Resized,
    Hidden,
    Shown,
}

struct Spike {
    auto: bool,
    window: Option<window::Id>,
    parent: Option<Hwnd>,
    scale: f32,
    pane: Option<Rectangle>,
    guest_process: Option<Child>,
    guest: GuestWindow<Win32Embed>,
    waiting_since: Option<Instant>,
    visible: bool,
    status: String,
    /// The `--auto` script: the step being checked, when it began, and what went wrong so far.
    step: Step,
    step_since: Option<Instant>,
    first_placement: Option<Rect>,
    failures: Vec<String>,
}

#[derive(Debug, Clone)]
enum Message {
    Window(Option<window::Id>),
    Parent(isize),
    Scale(f32),
    Pane(Rectangle),
    Start,
    Poll,
    Watch,
    Toggle,
    Rescaled(f32),
    CloseRequested,
}

fn boot() -> (Spike, Task<Message>) {
    let auto = std::env::args().any(|arg| arg == "--auto");
    let spike = Spike {
        auto,
        window: None,
        parent: None,
        scale: 1.0,
        pane: None,
        guest_process: None,
        guest: GuestWindow::new(Win32Embed).with_log(|line| println!("[guest] {line}")),
        waiting_since: None,
        visible: true,
        status: "not started".into(),
        step: Step::Embedded,
        step_since: None,
        first_placement: None,
        failures: Vec::new(),
    };
    (spike, window::oldest().map(Message::Window))
}

fn update(spike: &mut Spike, message: Message) -> Task<Message> {
    match message {
        Message::Window(Some(id)) => {
            spike.window = Some(id);
            let parent = window::run(id, |w| match w.window_handle().map(|h| h.as_raw()) {
                Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get(),
                _ => 0,
            });
            let start = if spike.auto { Task::done(Message::Start) } else { Task::none() };
            Task::batch([parent.map(Message::Parent), window::scale_factor(id).map(Message::Scale), start])
        }
        Message::Window(None) => Task::none(),
        Message::Parent(hwnd) => {
            spike.parent = (hwnd != 0).then_some(Hwnd(hwnd));
            println!("[spike] host window {hwnd:#x}");
            Task::none()
        }
        Message::Scale(scale) | Message::Rescaled(scale) => {
            spike.scale = scale;
            reposition(spike);
            Task::none()
        }
        Message::Pane(bounds) => {
            spike.pane = Some(bounds);
            reposition(spike);
            Task::none()
        }
        Message::Start => {
            if spike.guest_process.is_some() {
                return Task::none();
            }
            let exe = std::env::current_exe().unwrap().with_file_name("fake_guest.exe");
            match Command::new(&exe).spawn() {
                Ok(child) => {
                    println!("[spike] started {} as pid {}", exe.display(), child.id());
                    spike.guest_process = Some(child);
                    spike.waiting_since = Some(Instant::now());
                    spike.status = "waiting for the guest window".into();
                }
                Err(error) => spike.status = format!("could not start {}: {error}", exe.display()),
            }
            Task::none()
        }
        Message::Poll => {
            let (Some(process), Some(parent), Some(pane)) = (&spike.guest_process, spike.parent, spike.pane) else {
                return Task::none();
            };
            if spike.waiting_since.is_some_and(|since| since.elapsed() > ATTACH_TIMEOUT) {
                spike.waiting_since = None;
                spike.status = "the guest never showed a window".into();
                return finish(spike, false);
            }
            if let Some(found) = find_main_window_for_process_tree(process.id()) {
                spike.waiting_since = None;
                if spike.guest.attach(found, parent, to_physical(pane, spike.scale)) {
                    spike.step_since = Some(Instant::now());
                    spike.status = format!("embedded at {}", spike.guest.placement().unwrap());
                } else {
                    spike.status = "embedding refused".into();
                    return finish(spike, false);
                }
            }
            Task::none()
        }
        Message::Watch => {
            spike.guest.check();
            if spike.auto { drive_script(spike) } else { Task::none() }
        }
        Message::Toggle => {
            spike.visible = !spike.visible;
            spike.guest.set_visible(spike.visible);
            Task::none()
        }
        Message::CloseRequested => finish(spike, true),
    }
}

/// One step of the `--auto` script per call, once the screen has had time to settle: check what
/// the step should show, then make the change the next step checks.
fn drive_script(spike: &mut Spike) -> Task<Message> {
    if !spike.step_since.is_some_and(|since| since.elapsed() > SETTLE) {
        return Task::none();
    }
    spike.step_since = Some(Instant::now());
    let next = match spike.step {
        Step::Embedded => {
            expect(spike, true, "after embedding");
            spike.first_placement = spike.guest.placement();
            // Larger in both directions, so the guest has to move and grow to follow the pane.
            let resize = spike.window.map_or_else(Task::none, |id| window::resize(id, Size::new(1300.0, 860.0)));
            spike.step = Step::Resized;
            return resize;
        }
        Step::Resized => {
            expect(spike, true, "after the host window was resized");
            if spike.guest.placement() == spike.first_placement {
                spike.failures.push("the guest did not follow the resized pane".into());
            }
            spike.visible = false;
            spike.guest.set_visible(false);
            Step::Hidden
        }
        Step::Hidden => {
            expect(spike, false, "while hidden");
            spike.visible = true;
            spike.guest.set_visible(true);
            Step::Shown
        }
        Step::Shown => {
            expect(spike, true, "shown again");
            let ok = spike.failures.is_empty();
            for failure in &spike.failures {
                println!("[spike] FAILED: {failure}");
            }
            println!("[spike] {}", if ok { "all checks passed" } else { "checks failed" });
            return finish(spike, ok);
        }
    };
    spike.step = next;
    Task::none()
}

/// Samples the screen and records a failure if the guest's visibility is not what `when` expects.
fn expect(spike: &mut Spike, guest: bool, when: &str) {
    let seen = sample_is_guest(spike);
    println!("[spike] {when}: guest {}", if seen { "visible" } else { "not visible" });
    if seen != guest {
        spike.failures.push(format!("{when}: expected the guest to be {}", if guest { "visible" } else { "hidden" }));
    }
}

fn reposition(spike: &mut Spike) {
    if let Some(pane) = spike.pane {
        spike.guest.set_bounds(to_physical(pane, spike.scale));
    }
}

/// Gives the guest window back and ends the run. The release has to happen before our window
/// goes, or Windows destroys the guest's window with ours.
fn finish(spike: &mut Spike, ok: bool) -> Task<Message> {
    spike.guest.detach();
    if let Some(mut process) = spike.guest_process.take() {
        let _ = process.kill();
    }
    if spike.auto {
        std::process::exit(if ok { 0 } else { 1 });
    }
    iced::exit()
}

/// Reads the composed screen in the middle of the pane: magenta means the guest is what the user
/// sees there; anything else means the host painted over it.
fn sample_is_guest(spike: &Spike) -> bool {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, GetDC, GetPixel, ReleaseDC};

    let (Some(parent), Some(placed)) = (spike.parent, spike.guest.placement()) else { return false };
    let mut point = POINT { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 };
    // SAFETY: plain GDI calls on the screen DC, released before returning.
    let color = unsafe {
        ClientToScreen(parent.0 as _, &mut point);
        let screen = GetDC(std::ptr::null_mut());
        let color = GetPixel(screen, point.x, point.y);
        ReleaseDC(std::ptr::null_mut(), screen);
        color
    };
    let (r, g, b) = (color & 0xff, (color >> 8) & 0xff, (color >> 16) & 0xff);
    println!("[spike] pixel at {},{} is rgb({r},{g},{b})", point.x, point.y);
    r > 200 && g < 60 && b > 200
}

fn view(spike: &Spike) -> Element<'_, Message> {
    let rail = column![
        text("embed spike").size(18),
        button("Start guest").on_press(Message::Start),
        button(if spike.visible { "Hide guest" } else { "Show guest" }).on_press(Message::Toggle),
        text(&spike.status).size(13),
    ]
    .spacing(12)
    .padding(16)
    .width(220);

    let pane = probe(Message::Pane).background(PANE);

    container(row![rail, pane]).width(Length::Fill).height(Length::Fill).into()
}

fn subscription(spike: &Spike) -> Subscription<Message> {
    let mut subscriptions = vec![event::listen_with(|event, _status, _id| match event {
        iced::Event::Window(window::Event::CloseRequested) => Some(Message::CloseRequested),
        iced::Event::Window(window::Event::Rescaled(scale)) => Some(Message::Rescaled(scale)),
        _ => None,
    })];
    if spike.waiting_since.is_some() {
        subscriptions.push(time::every(ATTACH_POLL).map(|_| Message::Poll));
    }
    if spike.guest.is_attached() {
        subscriptions.push(time::every(WATCH_INTERVAL).map(|_| Message::Watch));
    }
    Subscription::batch(subscriptions)
}

fn main() -> iced::Result {
    iced::application(boot, update, view)
        .title("open-emulator embed spike")
        .theme(|_: &Spike| Theme::Dark)
        .subscription(subscription)
        .exit_on_close_request(false)
        .window_size((1000.0, 720.0))
        .run()
}
