//! Android's display, sized to the pane showing it, for when the guest is mirrored rather than
//! embedded. An embedded guest is its own window and sizes itself.
//!
//! `wm size` sets the logical display to the pane's real pixels, and `wm density` keeps a button
//! the same physical size as on the device's own panel, so a bigger window shows more, not bigger.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oe_engine::client::OpenEmuClient;
use oe_engine::no_log;
use oe_formats::js_round;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisplayGeometry {
    pub width: u32,
    pub height: u32,
    pub density: u32,
}

const MIN_EDGE: f64 = 360.0;
const MAX_EDGE: f64 = 2560.0;
const MAX_ASPECT: f64 = 2.4;
const MIN_DENSITY: f64 = 120.0;
const MAX_DENSITY: f64 = 640.0;
const BASELINE_DPI: f64 = 160.0;
/// Smaller changes are not worth the relayout every app does on a display change.
const MIN_CHANGE_PX: u32 = 16;
const SETTLE: Duration = Duration::from_millis(350);

fn make_even(value: f64) -> f64 {
    if value % 2.0 == 0.0 { value } else { value - 1.0 }
}

/// The display for a pane, keeping the panel's smallest-width in dp so layouts do not jump between
/// phone and tablet as the window is resized.
pub fn resolve_display_geometry(viewport: Size, base: DisplayGeometry) -> DisplayGeometry {
    let base_sw_dp = f64::from(base.width.min(base.height)) * BASELINE_DPI / f64::from(base.density);
    let mut width = js_round(f64::from(viewport.width)).clamp(MIN_EDGE, MAX_EDGE);
    let mut height = js_round(f64::from(viewport.height)).clamp(MIN_EDGE, MAX_EDGE);
    if width > height * MAX_ASPECT {
        width = js_round(height * MAX_ASPECT);
    } else if height > width * MAX_ASPECT {
        height = js_round(width * MAX_ASPECT);
    }
    let (width, height) = (make_even(width), make_even(height));
    let density = js_round(width.min(height) * BASELINE_DPI / base_sw_dp).clamp(MIN_DENSITY, MAX_DENSITY);
    DisplayGeometry { width: width as u32, height: height as u32, density: density as u32 }
}

pub fn worth_applying(applied: Option<DisplayGeometry>, next: DisplayGeometry) -> bool {
    applied.is_none_or(|applied| applied.width.abs_diff(next.width) >= MIN_CHANGE_PX || applied.height.abs_diff(next.height) >= MIN_CHANGE_PX)
}

fn number_after<'a>(text: &'a str, label: &str) -> Option<(u32, &'a str)> {
    let lower = text.to_lowercase();
    let at = lower.find(&label.to_lowercase())? + label.len();
    let rest = text[at..].trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((digits.parse().ok()?, &rest[digits.len()..]))
}

/// `Physical size: 1080x2340` from `wm size`.
pub fn parse_physical_size(stdout: &str) -> Option<Size> {
    let (width, rest) = number_after(stdout, "Physical size:")?;
    let (height, _) = number_after(rest, "x")?;
    (width > 0 && height > 0).then_some(Size { width, height })
}

/// `Physical density: 440` from `wm density`.
pub fn parse_physical_density(stdout: &str) -> Option<u32> {
    number_after(stdout, "Physical density:").map(|(density, _)| density).filter(|&density| density > 0)
}

#[derive(Default)]
struct ScalerState {
    base: Option<DisplayGeometry>,
    applied: Option<DisplayGeometry>,
    pending: Option<Size>,
    enabled: bool,
}

/// Debounces pane resizes into `wm` commands: a drag across the screen settles into one change.
#[derive(Clone)]
pub struct DisplayScaler {
    client: OpenEmuClient,
    state: Arc<Mutex<ScalerState>>,
    requests: Arc<AtomicU64>,
    flushing: Arc<tokio::sync::Mutex<()>>,
}

impl DisplayScaler {
    pub fn new(client: OpenEmuClient) -> DisplayScaler {
        DisplayScaler {
            client,
            state: Arc::new(Mutex::new(ScalerState { enabled: true, ..ScalerState::default() })),
            requests: Arc::default(),
            flushing: Arc::default(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ScalerState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Off while the guest's own window is embedded: it sizes itself.
    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.state();
        state.enabled = enabled;
        if !enabled {
            state.pending = None;
        }
    }

    /// Forgets the panel and what was applied: a different guest is about to start.
    pub fn forget(&self) {
        let mut state = self.state();
        state.base = None;
        state.applied = None;
        state.pending = None;
    }

    /// Asks for the display to follow `viewport` once it has stopped changing.
    pub fn request(&self, viewport: Size) {
        {
            let mut state = self.state();
            if !state.enabled || viewport.width == 0 || viewport.height == 0 {
                return;
            }
            state.pending = Some(viewport);
        }
        let ticket = self.requests.fetch_add(1, Ordering::SeqCst) + 1;
        let scaler = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SETTLE).await;
            if scaler.requests.load(Ordering::SeqCst) == ticket {
                scaler.flush().await;
            }
        });
    }

    pub async fn flush(&self) -> Option<DisplayGeometry> {
        let _turn = self.flushing.lock().await;
        let viewport = {
            let mut state = self.state();
            if !state.enabled {
                return None;
            }
            state.pending.take()?
        };
        let base = self.panel().await?;
        let geometry = resolve_display_geometry(viewport, base);
        if !worth_applying(self.state().applied, geometry) {
            return Some(geometry);
        }
        for command in [format!("wm size {}x{}", geometry.width, geometry.height), format!("wm density {}", geometry.density)] {
            if !self.client.shell(&command, no_log(), None).await.success() {
                return None;
            }
        }
        self.state().applied = Some(geometry);
        Some(geometry)
    }

    /// Puts the guest's display back to its panel, before the guest's own window takes over.
    pub async fn reset(&self) {
        {
            let mut state = self.state();
            state.pending = None;
            state.applied = None;
        }
        for command in ["wm size reset", "wm density reset"] {
            self.client.shell(command, no_log(), None).await;
        }
    }

    async fn panel(&self) -> Option<DisplayGeometry> {
        if let Some(base) = self.state().base {
            return Some(base);
        }
        let size = self.client.shell("wm size", no_log(), None).await;
        let density = self.client.shell("wm density", no_log(), None).await;
        let dimensions = parse_physical_size(&size.stdout.join("\n"))?;
        let dpi = parse_physical_density(&density.stdout.join("\n"))?;
        let base = DisplayGeometry { width: dimensions.width, height: dimensions.height, density: dpi };
        self.state().base = Some(base);
        Some(base)
    }
}

#[cfg(test)]
mod tests {
    use oe_engine::testing::{ok, FakeEngine};

    use super::*;

    const PANEL: DisplayGeometry = DisplayGeometry { width: 1080, height: 2340, density: 440 };

    #[test]
    fn a_pane_keeps_the_panels_smallest_width_in_dp() {
        let geometry = resolve_display_geometry(Size { width: 540, height: 1170 }, PANEL);
        assert_eq!(geometry, DisplayGeometry { width: 540, height: 1170, density: 220 });
    }

    #[test]
    fn extreme_panes_are_clamped_and_kept_even() {
        let wide = resolve_display_geometry(Size { width: 4000, height: 401 }, PANEL);
        assert_eq!((wide.width, wide.height), (962, 400), "no wider than 2.4:1, and even");
        let tiny = resolve_display_geometry(Size { width: 10, height: 10 }, PANEL);
        assert_eq!((tiny.width, tiny.height), (360, 360));
    }

    #[test]
    fn small_changes_are_not_worth_a_relayout() {
        let applied = DisplayGeometry { width: 800, height: 1200, density: 240 };
        assert!(!worth_applying(Some(applied), DisplayGeometry { width: 810, height: 1190, density: 240 }));
        assert!(worth_applying(Some(applied), DisplayGeometry { width: 820, height: 1200, density: 240 }));
        assert!(worth_applying(None, applied));
    }

    #[test]
    fn wm_output_is_read() {
        assert_eq!(parse_physical_size("Physical size: 1080x2340\nOverride size: 540x1170"), Some(Size { width: 1080, height: 2340 }));
        assert_eq!(parse_physical_density("Physical density: 440"), Some(440));
        assert_eq!(parse_physical_size("garbage"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_resizes_settles_into_one_change() {
        let engine = Arc::new(FakeEngine::new().answering(|command| match command {
            "wm size" => ok(&["Physical size: 1080x2340"]),
            "wm density" => ok(&["Physical density: 440"]),
            _ => ok(&[]),
        }));
        let scaler = DisplayScaler::new(OpenEmuClient::new(engine.clone()));
        for width in [500, 520, 540] {
            scaler.request(Size { width, height: 1170 });
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let shells = engine.shells.lock().unwrap().clone();
        assert_eq!(shells, ["wm size", "wm density", "wm size 540x1170", "wm density 220"]);
    }
}
