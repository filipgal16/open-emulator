//! The guest's real window, reparented into ours.
//!
//! This is what makes the device run at the emulator's own frame rate instead of ~2.8fps. The
//! emulator already renders the guest on the GPU into a Qt window; embedding shows that window
//! directly, so there is no capture, no PNG encode, no decode, and no polling interval to cap it.
//! Mouse and keyboard reach the emulator directly too, rather than paying an adb round trip per
//! gesture.
//!
//! **The emulator owns its shape.** The Qt window keeps the device panel's aspect ratio no matter
//! what size it is given: asked to fill a landscape pane, it comes back a moment later as a
//! portrait rectangle of its own choosing. Fighting that on a timer made the window flicker between
//! the two shapes forever. So this controller never dictates a shape; it fits the largest
//! rectangle of the emulator's *current* aspect into the pane, centres it, and when the emulator
//! changes shape on its own (a rotation, a display change) it adopts the new aspect and re-fits
//! once. The pane's own background shows around it, which is what every desktop emulator does.
//!
//! **Every operation is allowed to fail.** `SetParent` across processes can be refused, a driver
//! can dislike a reparented Qt surface, and the emulator can exit underneath us at any moment. So
//! nothing here panics: each method reports success, and a false answer means the caller should
//! fall back to mirroring rather than show the user an empty rectangle.
//!
//! Everything runs on the UI thread, driven by it: the UI polls for the window and calls
//! [`GuestWindow::attach`] once it exists, reports its viewport, and calls
//! [`GuestWindow::check`] every [`WATCH_INTERVAL`].

use std::time::Duration;

use crate::{Hwnd, Rect, WindowStyles};

/// The Win32 calls this controller needs, injected so it can be tested without a real window.
pub trait EmbedApi {
    fn embed_window(&self, child: Hwnd, parent: Hwnd, bounds: Rect) -> Result<(), String>;
    fn move_window(&self, child: Hwnd, bounds: Rect) -> bool;
    fn set_window_visible(&self, child: Hwnd, visible: bool) -> bool;
    fn is_live_window(&self, child: Hwnd) -> bool;
    fn capture_window_styles(&self, child: Hwnd) -> Option<WindowStyles>;
    fn release_window(&self, child: Hwnd, styles: Option<WindowStyles>) -> bool;
    /// Where the child actually is, in the parent's client coordinates.
    fn child_bounds(&self, child: Hwnd, parent: Hwnd) -> Option<Rect>;
    /// The child's own client size: how the emulator has shaped itself.
    fn client_size(&self, child: Hwnd) -> Option<(i32, i32)>;
    /// Hides the floating tool windows the child owns. Returns how many it hid.
    fn hide_owned_windows(&self, child: Hwnd) -> u32;
}

/// Qt reshapes the window two or three times while the emulator is starting; each is visible until
/// the next tick puts it back, so the tick is the ceiling on how long a misplaced frame is shown.
pub const WATCH_INTERVAL: Duration = Duration::from_millis(200);

/// How long to wait for the emulator to paint before giving up and mirroring instead.
pub const ATTACH_TIMEOUT: Duration = Duration::from_secs(60);

/// How often to look for the window while waiting for it. Enumerating windows costs well under a
/// millisecond, and the interval is the ceiling on how long the window flashes as a separate
/// top-level one before it is taken.
pub const ATTACH_POLL: Duration = Duration::from_millis(40);

/// Rectangles this close are the same rectangle: Qt rounds, and so do we.
const TOLERANCE_PX: i32 = 2;

pub struct GuestWindow<E: EmbedApi> {
    embed: E,
    child: Option<Hwnd>,
    /// Captured before embedding, so `detach` can put the window back as it found it.
    styles: Option<WindowStyles>,
    /// The pane the UI reported: where the guest is allowed to be.
    viewport: Option<Rect>,
    /// The rectangle this controller last set: the fit of `viewport` at `aspect`.
    placed: Option<Rect>,
    /// Width over height of the emulator's window, as it last shaped itself.
    aspect: Option<f64>,
    parent: Option<Hwnd>,
    visible: bool,
    log: Option<Box<dyn Fn(&str) + Send>>,
}

impl<E: EmbedApi> GuestWindow<E> {
    pub fn new(embed: E) -> Self {
        GuestWindow {
            embed,
            child: None,
            styles: None,
            viewport: None,
            placed: None,
            aspect: None,
            parent: None,
            visible: false,
            log: None,
        }
    }

    pub fn with_log(mut self, log: impl Fn(&str) + Send + 'static) -> Self {
        self.log = Some(Box::new(log));
        self
    }

    fn log(&self, message: &str) {
        if let Some(log) = &self.log {
            log(message);
        }
    }

    pub fn embed(&self) -> &E {
        &self.embed
    }

    /// True once a real window is embedded and being tracked.
    pub fn is_attached(&self) -> bool {
        self.child.is_some_and(|child| self.embed.is_live_window(child))
    }

    /// Where the guest is drawn right now, in the parent's client coordinates.
    pub fn placement(&self) -> Option<Rect> {
        self.placed
    }

    /// The embedded window, if any.
    pub fn child(&self) -> Option<Hwnd> {
        self.child
    }

    /// Reparents the emulator's window into `parent`, fitted inside `viewport`. When a window is
    /// already attached, just repositions it.
    pub fn attach(&mut self, window: Hwnd, parent: Hwnd, viewport: Rect) -> bool {
        if self.is_attached() {
            self.set_bounds(viewport);
            return true;
        }

        // The emulator's own shape, read before anything is moved, so the very first placement is
        // already the right one rather than a full-pane rectangle Qt immediately shrinks.
        let aspect = self
            .embed
            .client_size(window)
            .filter(|&(w, h)| w > 0 && h > 0)
            .map(|(w, h)| f64::from(w) / f64::from(h));
        let target = fit(viewport, aspect);

        // Captured before embed_window overwrites them, or detach has nothing to restore.
        self.styles = self.embed.capture_window_styles(window);
        if let Err(reason) = self.embed.embed_window(window, parent, target) {
            self.log(&format!("embedding failed: {reason}; mirroring instead"));
            self.styles = None;
            return false;
        }

        self.child = Some(window);
        self.parent = Some(parent);
        self.viewport = Some(viewport);
        self.placed = Some(target);
        self.aspect = aspect;
        // embed_window's SetWindowPos carries SWP_SHOWWINDOW, so it is on screen as of now.
        // Recording that rather than assuming false keeps the first set_visible(true) from being
        // skipped as a no-op when the state is already correct.
        self.visible = true;
        self.log(&format!(
            "guest window embedded at {}x{}, running at the emulator’s own frame rate",
            target.width, target.height
        ));
        self.tidy();
        true
    }

    /// Hides the emulator's own floating toolbar; ours has every button on it.
    fn tidy(&self) {
        if let Some(child) = self.child {
            let hidden = self.embed.hide_owned_windows(child);
            if hidden > 0 {
                self.log(&format!("hid {hidden} floating emulator toolbar window(s)"));
            }
        }
    }

    /// One watchdog tick: notices the emulator reshaping itself.
    ///
    /// It does so after a rotation, after the guest's display configuration changes, and once
    /// shortly after being embedded. Nothing above notices, because the *requested* viewport never
    /// changed. One `GetWindowRect` per tick is cheap; the toolbar re-hide rides along because Qt
    /// re-shows it on some of the same events.
    pub fn check(&mut self) {
        if !self.is_attached() || !self.visible {
            return;
        }
        let (Some(child), Some(viewport), Some(placed), Some(parent)) = (self.child, self.viewport, self.placed, self.parent)
        else {
            return;
        };
        let Some(actual) = self.embed.child_bounds(child, parent) else { return };
        if actual.width <= 0 || actual.height <= 0 {
            return;
        }

        if !nearly(actual, placed) {
            // The emulator reshaped itself. Its new shape is the truth; our job is only where it
            // sits.
            //
            // Its *exact* size is kept, not re-derived from the aspect ratio. Qt believes this
            // window is top-level, and when it corrects a size it dislikes, even by one pixel of
            // rounding, it re-applies its geometry in screen coordinates, which for a child window
            // are parent-relative. The window then lands offset by the parent's origin, gets moved
            // back, and Qt corrects it again: a visible bounce twice a second, forever. Handing
            // back a size Qt already agrees with gives it nothing to correct. Only a shape too
            // large for the pane is scaled down.
            let aspect = f64::from(actual.width) / f64::from(actual.height);
            self.aspect = Some(aspect);
            let fits = actual.width <= viewport.width && actual.height <= viewport.height;
            let target = if fits { centre(viewport, actual.width, actual.height) } else { fit(viewport, Some(aspect)) };
            if nearly(target, actual) {
                // Already the size we would have chosen, just possibly off-centre by rounding.
                self.placed = Some(actual);
            } else {
                self.log(&format!(
                    "guest window reshaped to {actual} (was placed at {placed}); fitting it as {target}"
                ));
                if self.embed.move_window(child, target) {
                    self.placed = Some(target);
                }
            }
        }
        self.tidy();
    }

    /// Fits the window into a new viewport.
    ///
    /// Skipped when nothing would move. The UI reports on every layout, including ones that leave
    /// the viewport where it was, and every `SetWindowPos` on a live GPU surface is a real repaint.
    pub fn set_bounds(&mut self, viewport: Rect) -> bool {
        if !self.is_attached() {
            return false;
        }
        self.viewport = Some(viewport);

        let target = fit(viewport, self.aspect);
        if self.placed == Some(target) {
            return true;
        }
        let child = self.child.expect("attached");
        let moved = self.embed.move_window(child, target);
        if moved {
            self.placed = Some(target);
        }
        moved
    }

    /// Shows or hides the window: the airspace escape hatch.
    ///
    /// A child HWND paints over the parent, so anything the UI draws that would overlap the device
    /// is invisible until this is called with false. Workspace switches and dialogs depend on it.
    pub fn set_visible(&mut self, visible: bool) -> bool {
        if !self.is_attached() {
            return false;
        }
        if self.visible == visible {
            return true;
        }
        let ok = self.embed.set_window_visible(self.child.expect("attached"), visible);
        if ok {
            self.visible = visible;
        }
        ok
    }

    /// Gives the window back to the desktop and forgets it.
    ///
    /// Merely dropping the reference is not enough, and getting this wrong is expensive: Windows
    /// destroys child windows along with their parent, so a guest window left parented to ours
    /// when the app closes is destroyed with it, while the emulator keeps running, now with no
    /// screen. Observed exactly that way, and it poisons every later start, which finds no window
    /// to embed.
    pub fn detach(&mut self) {
        if let Some(child) = self.child {
            if self.embed.is_live_window(child) && !self.embed.release_window(child, self.styles) {
                self.log("could not release the guest window");
            }
        }
        self.child = None;
        self.styles = None;
        self.viewport = None;
        self.placed = None;
        self.aspect = None;
        self.parent = None;
        self.visible = false;
    }
}

impl<E: EmbedApi> Drop for GuestWindow<E> {
    /// The window goes back to the desktop however the controller goes away: see `detach`.
    fn drop(&mut self) {
        self.detach();
    }
}

/// JavaScript's `Math.round`, which the TypeScript controller used: halves round up.
fn js_round(value: f64) -> i32 {
    let floor = value.floor();
    (if value - floor >= 0.5 { floor + 1.0 } else { floor }) as i32
}

/// The largest rectangle of the given aspect that fits inside `viewport`, centred in it.
///
/// With no aspect known yet, the viewport itself: the emulator will reshape it, and the watchdog
/// fits it properly a tick later.
pub fn fit(viewport: Rect, aspect: Option<f64>) -> Rect {
    let Some(aspect) = aspect.filter(|a| a.is_finite() && *a > 0.0) else { return viewport };
    if viewport.width <= 0 || viewport.height <= 0 {
        return viewport;
    }
    let mut width = viewport.width;
    let mut height = js_round(f64::from(width) / aspect);
    if height > viewport.height {
        height = viewport.height;
        width = js_round(f64::from(height) * aspect);
    }
    centre(viewport, width, height)
}

/// A rectangle of exactly this size, centred in the viewport.
pub fn centre(viewport: Rect, width: i32, height: i32) -> Rect {
    Rect {
        x: viewport.x + js_round(f64::from(viewport.width - width) / 2.0),
        y: viewport.y + js_round(f64::from(viewport.height - height) / 2.0),
        width,
        height,
    }
}

fn nearly(a: Rect, b: Rect) -> bool {
    (a.x - b.x).abs() <= TOLERANCE_PX
        && (a.y - b.y).abs() <= TOLERANCE_PX
        && (a.width - b.width).abs() <= TOLERANCE_PX
        && (a.height - b.height).abs() <= TOLERANCE_PX
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const RECT: Rect = Rect::new(0, 40, 800, 600);
    const PARENT: Hwnd = Hwnd(7);
    const WINDOW: Hwnd = Hwnd(42);

    /// A fake Win32 layer that records what it was asked to do.
    #[derive(Clone, Default)]
    struct Fake {
        calls: Rc<RefCell<Vec<String>>>,
        /// Where the window actually is. `None` means "unknown", so the watchdog does nothing.
        actual: Option<Rect>,
        /// The emulator's own size before embedding.
        natural: Option<(i32, i32)>,
        refuse_embed: bool,
        dead: Rc<RefCell<bool>>,
        owned_windows: u32,
    }

    impl Fake {
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }

        fn clear(&self) {
            self.calls.borrow_mut().clear();
        }

        fn push(&self, call: String) {
            self.calls.borrow_mut().push(call);
        }
    }

    impl EmbedApi for Fake {
        fn embed_window(&self, _child: Hwnd, _parent: Hwnd, bounds: Rect) -> Result<(), String> {
            if self.refuse_embed {
                return Err("SetParent failed (Win32 error 5)".into());
            }
            self.push(format!("embed:{}x{}", bounds.width, bounds.height));
            Ok(())
        }

        fn move_window(&self, _child: Hwnd, bounds: Rect) -> bool {
            self.push(format!("move:{},{},{}x{}", bounds.x, bounds.y, bounds.width, bounds.height));
            true
        }

        fn set_window_visible(&self, _child: Hwnd, visible: bool) -> bool {
            self.push(format!("visible:{visible}"));
            true
        }

        fn is_live_window(&self, child: Hwnd) -> bool {
            child == WINDOW && !*self.dead.borrow()
        }

        fn capture_window_styles(&self, _child: Hwnd) -> Option<WindowStyles> {
            self.push("capture".into());
            Some(WindowStyles { style: 0x1234, ex_style: 0x5678 })
        }

        fn release_window(&self, _child: Hwnd, styles: Option<WindowStyles>) -> bool {
            let shown = styles.map_or("null".to_owned(), |s| format!("{}/{}", s.style, s.ex_style));
            self.push(format!("release:{shown}"));
            true
        }

        fn child_bounds(&self, _child: Hwnd, _parent: Hwnd) -> Option<Rect> {
            self.actual
        }

        fn client_size(&self, _child: Hwnd) -> Option<(i32, i32)> {
            self.natural
        }

        fn hide_owned_windows(&self, _child: Hwnd) -> u32 {
            if self.owned_windows > 0 {
                self.push("hide-owned".into());
            }
            self.owned_windows
        }
    }

    fn attached(fake: &Fake) -> GuestWindow<Fake> {
        let mut guest = GuestWindow::new(fake.clone());
        assert!(guest.attach(WINDOW, PARENT, RECT));
        guest
    }

    // ── Attaching ───────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_found_window_is_embedded_and_becomes_the_attached_one() {
        let fake = Fake::default();
        let guest = attached(&fake);
        assert!(guest.is_attached());
        assert_eq!(fake.calls(), vec!["capture", "embed:800x600"]);
    }

    #[test]
    fn attaching_when_already_attached_just_repositions() {
        let fake = Fake::default();
        let mut guest = attached(&fake);
        fake.clear();
        assert!(guest.attach(WINDOW, PARENT, Rect { width: 900, ..RECT }));
        assert_eq!(fake.calls(), vec!["move:0,40,900x600"], "no second embed");
    }

    #[test]
    fn a_refused_set_parent_is_false_not_a_panic() {
        let fake = Fake { refuse_embed: true, ..Fake::default() };
        let mut guest = GuestWindow::new(fake.clone());
        assert!(!guest.attach(WINDOW, PARENT, RECT));
        assert!(!guest.is_attached(), "the caller mirrors instead");
    }

    // ── Bounds ──────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn an_unchanged_rectangle_is_not_re_applied() {
        let fake = Fake::default();
        let mut guest = attached(&fake);
        fake.clear();
        guest.set_bounds(RECT);
        assert!(fake.calls().is_empty());
        guest.set_bounds(Rect { width: 640, ..RECT });
        assert_eq!(fake.calls(), vec!["move:0,40,640x600"]);
    }

    #[test]
    fn bounds_on_a_detached_window_are_refused_not_crashed_on() {
        let mut guest = GuestWindow::new(Fake::default());
        assert!(!guest.set_bounds(RECT));
        assert!(!guest.set_visible(true));
    }

    // ── Visibility: the airspace rule ───────────────────────────────────────────────────────────

    #[test]
    fn hiding_and_showing_is_deduplicated() {
        let fake = Fake::default();
        let mut guest = attached(&fake);
        fake.clear();
        // embed_window already showed it, so this is a no-op.
        guest.set_visible(true);
        assert!(fake.calls().is_empty());
        guest.set_visible(false);
        guest.set_visible(false);
        assert_eq!(fake.calls(), vec!["visible:false"], "hiding twice hides once");
        guest.set_visible(true);
        assert_eq!(fake.calls(), vec!["visible:false", "visible:true"]);
    }

    // ── Teardown ────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn detaching_gives_the_window_back_with_its_original_styles() {
        let fake = Fake::default();
        let mut guest = attached(&fake);
        fake.clear();
        guest.detach();
        assert_eq!(fake.calls(), vec!["release:4660/22136"], "released with the styles captured at embed");
        assert!(!guest.is_attached());
    }

    #[test]
    fn styles_are_captured_before_embedding_overwrites_them() {
        let fake = Fake::default();
        let _guest = attached(&fake);
        let calls = fake.calls();
        let capture = calls.iter().position(|c| c == "capture").unwrap();
        let embed = calls.iter().position(|c| c == "embed:800x600").unwrap();
        assert!(capture < embed);
    }

    #[test]
    fn detaching_twice_releases_once() {
        let fake = Fake::default();
        let mut guest = attached(&fake);
        fake.clear();
        guest.detach();
        guest.detach();
        drop(guest);
        assert_eq!(fake.calls().iter().filter(|c| c.starts_with("release")).count(), 1);
    }

    #[test]
    fn dropping_the_controller_gives_the_window_back() {
        let fake = Fake::default();
        let guest = attached(&fake);
        fake.clear();
        drop(guest);
        assert_eq!(fake.calls(), vec!["release:4660/22136"]);
    }

    #[test]
    fn detaching_a_window_that_already_died_does_not_try_to_release_it() {
        let fake = Fake::default();
        let mut guest = attached(&fake);
        fake.clear();
        *fake.dead.borrow_mut() = true;
        guest.detach();
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn a_window_that_died_underneath_us_reads_as_detached() {
        let fake = Fake::default();
        let mut guest = attached(&fake);
        *fake.dead.borrow_mut() = true;
        assert!(!guest.is_attached());
        assert!(!guest.set_bounds(Rect { width: 100, ..RECT }));
    }

    // ── The watchdog ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_window_that_reshaped_itself_is_fitted_and_centred_at_its_new_aspect() {
        let fake = Fake { actual: Some(Rect::new(0, 40, 381, 678)), ..Fake::default() };
        let mut guest = attached(&fake);
        fake.clear();
        guest.check();
        // 381:678 fitted into 800x600 → height 600, width 337, centred → x = (800-337)/2 = 232.
        assert_eq!(fake.calls(), vec!["move:232,40,337x600"]);
    }

    #[test]
    fn a_reshaped_window_that_fits_keeps_its_exact_size_and_is_only_centred() {
        let fake = Fake { actual: Some(Rect::new(601, 323, 476, 500)), ..Fake::default() };
        let mut guest = attached(&fake);
        fake.clear();
        guest.check();
        // Same 476x500, centred in 800x600 at (0,40): x = 162, y = 40 + 50 = 90.
        assert_eq!(fake.calls(), vec!["move:162,90,476x500"]);
    }

    #[test]
    fn a_window_already_at_the_size_we_would_choose_is_accepted_not_nudged() {
        let fake = Fake { actual: Some(Rect::new(231, 40, 338, 600)), ..Fake::default() };
        let mut guest = attached(&fake);
        fake.clear();
        guest.check();
        assert!(fake.calls().is_empty(), "within rounding of the fit; leave it alone");
    }

    #[test]
    fn the_emulators_natural_shape_is_used_for_the_very_first_placement() {
        let fake = Fake { natural: Some((720, 1280)), ..Fake::default() };
        let guest = attached(&fake);
        // 9:16 into 800x600 → 338x600 centred at x=231.
        assert_eq!(fake.calls(), vec!["capture", "embed:338x600"]);
        assert_eq!(guest.placement(), Some(Rect::new(231, 40, 338, 600)));
    }

    #[test]
    fn a_new_viewport_keeps_the_aspect_and_re_centres() {
        let fake = Fake { natural: Some((720, 1280)), ..Fake::default() };
        let mut guest = attached(&fake);
        fake.clear();
        guest.set_bounds(Rect::new(0, 40, 400, 1000));
        // Now width-limited: 400 wide → 711 tall, centred vertically at 40 + (1000-711)/2.
        assert_eq!(fake.calls(), vec!["move:0,185,400x711"]);
    }

    #[test]
    fn a_window_that_is_where_it_belongs_is_left_alone() {
        let fake = Fake { actual: Some(RECT), ..Fake::default() };
        let mut guest = attached(&fake);
        fake.clear();
        guest.check();
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn a_hidden_window_is_not_moved() {
        let fake = Fake { actual: Some(Rect::new(9, 9, 9, 9)), ..Fake::default() };
        let mut guest = attached(&fake);
        guest.set_visible(false);
        fake.clear();
        guest.check();
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn the_emulators_floating_toolbar_is_hidden_on_attach() {
        let fake = Fake { owned_windows: 1, ..Fake::default() };
        let _guest = attached(&fake);
        assert!(fake.calls().iter().any(|c| c == "hide-owned"));
    }
}
