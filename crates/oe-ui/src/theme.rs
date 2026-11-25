//! The design tokens, light and dark, and the widget styles built from them.
//!
//! Dark is the default, and the look is Graphite's: a near-black page whose neutrals carry no hue,
//! cards that are the page itself set off by a hairline cool-grey edge, white headings over grey
//! copy, dark recessed buttons, and one light button per screen for the thing to do next, framed
//! by a hairline rim that runs gold to cyan and glows faintly of both. Green, amber and red are
//! kept for state: running, waiting, failed.

use std::f32::consts::FRAC_PI_2;

use iced::border::Radius;
use iced::gradient::Linear;
use iced::widget::{button, container, text_input};
use iced::{Background, Border, Color, Gradient, Radians, Shadow, Theme, Vector};

const fn rgb(hex: u32) -> Color {
    Color::from_rgb8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

const fn rgba(hex: u32, alpha: f32) -> Color {
    Color::from_rgba8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8, alpha)
}

/// The rim of the light button, left to right: gold, through pale rose and pale mint, to cyan.
pub const RIM: [Color; 4] = [rgb(0xdbba69), rgb(0xe9e2ea), rgb(0xd9ece4), rgb(0x64abc7)];
/// Its glow: the two ends of the rim, faint.
const GLOW_GOLD: u32 = 0xdbba69;
const GLOW_CYAN: u32 = 0x64abc7;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tokens {
    pub dark: bool,
    pub bg: Color,
    /// Behind the device's screen.
    pub bg_deep: Color,
    /// The title bar and the bezel: the page itself, set off by a hairline.
    pub chrome: Color,
    pub nav_track: Color,
    /// Cards: barely off the page; their edge does the work.
    pub surface: Color,
    pub surface_hover: Color,
    pub surface_active: Color,
    /// Menus, tooltips, the notice strip.
    pub raised: Color,
    /// Dark buttons ("Request a demo", "Log in").
    pub control: Color,
    pub control_hover: Color,
    pub control_edge: Color,
    /// Keycaps inside dark buttons and tooltips.
    pub keycap: Color,
    /// Graphite's feature chips: a dark grey with a breath of violet, and their edge.
    pub chip: Color,
    pub chip_edge: Color,
    /// The small round light buttons on Graphite's cards ("Start stacking").
    pub pill: Color,
    /// Input and outline edges: 3:1 against the page, as WCAG asks of a control's boundary.
    pub border: Color,
    pub border_strong: Color,
    /// Card edges and hairlines: decoration only.
    pub border_subtle: Color,
    pub text: Color,
    pub text_dim: Color,
    pub muted: Color,
    pub faint: Color,
    /// Marks of emphasis: the brand, a chosen item's check, toggles and sliders.
    pub accent: Color,
    /// Text on the light button.
    pub accent_strong: Color,
    /// The light button.
    pub accent_fill: Color,
    pub accent_fill_hover: Color,
    pub accent_soft: Color,
    /// A focused field's edge: the cyan end of the rim.
    pub focus: Color,
    /// How strongly the light button glows.
    pub glow: f32,
    pub ok: Color,
    pub ok_bg: Color,
    pub warn: Color,
    pub warn_bg: Color,
    pub warn_border: Color,
    pub danger: Color,
    pub danger_fill: Color,
    pub danger_bg: Color,
    pub danger_border: Color,
    pub danger_fg: Color,
    pub idle: Color,
}

pub const DARK: Tokens = Tokens {
    dark: true,
    bg: rgb(0x0a0a0a),
    bg_deep: rgb(0x050505),
    chrome: rgb(0x0a0a0a),
    nav_track: rgb(0x0a0a0a),
    surface: rgb(0x0c0c0c),
    surface_hover: rgb(0x131313),
    surface_active: rgb(0x1c1c1c),
    raised: rgb(0x171717),
    control: rgb(0x262626),
    control_hover: rgb(0x2e2e2e),
    control_edge: rgb(0x303030),
    keycap: rgb(0x393939),
    chip: rgb(0x242328),
    chip_edge: rgb(0x302f35),
    pill: rgb(0xfcfcfc),
    border: rgb(0x5c6168),
    border_strong: rgb(0x8a8f96),
    border_subtle: rgb(0x262a2e),
    text: rgb(0xfafafa),
    text_dim: rgb(0xd4d4d4),
    muted: rgb(0xa1a1a1),
    faint: rgb(0x808080),
    accent: rgb(0xe5e5e5),
    accent_strong: rgb(0x0a0a0a),
    accent_fill: rgb(0xe5e5e5),
    accent_fill_hover: rgb(0xfafafa),
    accent_soft: rgba(0xffffff, 0.1),
    focus: rgb(0x64abc7),
    glow: 0.3,
    ok: rgb(0x4ade80),
    ok_bg: rgb(0x0f1f15),
    warn: rgb(0xe9bd4a),
    warn_bg: rgb(0x211b0c),
    warn_border: rgb(0x5c4a17),
    danger: rgb(0xf87171),
    danger_fill: rgb(0x7f2a2a),
    danger_bg: rgb(0x1f1010),
    danger_border: rgb(0x4d2323),
    danger_fg: rgb(0xfecaca),
    idle: rgb(0x525252),
};

pub const LIGHT: Tokens = Tokens {
    dark: false,
    bg: rgb(0xfafafa),
    bg_deep: rgb(0xf0f0f0),
    chrome: rgb(0xfafafa),
    nav_track: rgb(0xfafafa),
    surface: rgb(0xffffff),
    surface_hover: rgb(0xf5f5f5),
    surface_active: rgb(0xebebeb),
    raised: rgb(0xf2f2f2),
    control: rgb(0xffffff),
    control_hover: rgb(0xf5f5f5),
    control_edge: rgb(0xd4d4d4),
    keycap: rgb(0xebebeb),
    chip: rgb(0xeeedf2),
    chip_edge: rgb(0xdcdbe1),
    pill: rgb(0x171717),
    border: rgb(0x8a8f96),
    border_strong: rgb(0x5c6168),
    border_subtle: rgb(0xe2e4e7),
    text: rgb(0x0a0a0a),
    text_dim: rgb(0x262626),
    muted: rgb(0x525252),
    faint: rgb(0x6b6b6b),
    accent: rgb(0x171717),
    accent_strong: rgb(0xfafafa),
    accent_fill: rgb(0x171717),
    accent_fill_hover: rgb(0x262626),
    accent_soft: rgba(0x000000, 0.06),
    focus: rgb(0x2f7f9e),
    glow: 0.22,
    ok: rgb(0x15803d),
    ok_bg: rgb(0xe7f6ec),
    warn: rgb(0x8a5b00),
    warn_bg: rgb(0xfbf3dc),
    warn_border: rgb(0xc4a04a),
    danger: rgb(0xb42323),
    danger_fill: rgb(0xb42323),
    danger_bg: rgb(0xfde8e8),
    danger_border: rgb(0xe0a0a0),
    danger_fg: rgb(0x8a1c1c),
    idle: rgb(0x8a8f96),
};

// Type scale, in pixels.
pub const TEXT_2XS: f32 = 11.0;
pub const TEXT_XS: f32 = 12.0;
pub const TEXT_SM: f32 = 13.0;
pub const TEXT_MD: f32 = 14.0;
pub const TEXT_LG: f32 = 16.0;
pub const TEXT_XL: f32 = 18.0;
pub const TEXT_2XL: f32 = 20.0;
pub const TEXT_3XL: f32 = 24.0;
/// Page titles.
pub const TEXT_4XL: f32 = 28.0;
/// A page's headline.
pub const DISPLAY: f32 = 36.0;
/// The device screen's hero headline, two lines at most.
pub const DISPLAY_XL: f32 = 46.0;

pub const TITLEBAR_HEIGHT: f32 = 52.0;
pub const BEZEL_WIDTH: f32 = 48.0;
pub const BEZEL_BUTTON: f32 = 36.0;

pub const RADIUS_SM: f32 = 6.0;
pub const RADIUS: f32 = 8.0;
pub const RADIUS_MD: f32 = 10.0;
pub const RADIUS_LG: f32 = 12.0;
pub const RADIUS_FULL: f32 = 999.0;

/// Inter, built into the app (`main.rs` loads it): the closest open font to Graphite's type.
pub const REGULAR: iced::Font = iced::Font::with_name("Inter");
pub const SEMIBOLD: iced::Font = iced::Font { weight: iced::font::Weight::Semibold, ..REGULAR };
pub const MEDIUM: iced::Font = iced::Font { weight: iced::font::Weight::Medium, ..REGULAR };
pub const MONO: iced::Font = iced::Font::with_name("Cascadia Mono");
/// Headlines: medium, as Graphite sets them.
pub const HEADLINE: iced::Font = MEDIUM;
/// Where the page's content sits: a centred column, as Graphite's.
pub const CONTENT_WIDTH: f32 = 1120.0;

/// The iced theme the built-in widgets (sliders, scrollbars, toggles) draw from.
pub fn iced_theme(t: Tokens) -> Theme {
    Theme::custom(
        if t.dark { "open-emulator dark" } else { "open-emulator light" },
        iced::theme::Palette { background: t.bg, text: t.text, primary: t.accent, success: t.ok, warning: t.warn, danger: t.danger },
    )
}

fn border(color: Color, radius: f32) -> Border {
    Border { color, width: 1.0, radius: Radius::from(radius) }
}

fn no_border(radius: f32) -> Border {
    Border { color: Color::TRANSPARENT, width: 0.0, radius: Radius::from(radius) }
}

const NO_SHADOW: Shadow = Shadow { color: Color::TRANSPARENT, offset: Vector::ZERO, blur_radius: 0.0 };

/// A card: the page, edged.
pub fn panel(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(t.text),
        background: Some(Background::Color(t.surface)),
        border: border(t.border_subtle, RADIUS_LG),
        shadow: NO_SHADOW,
        snap: true,
    }
}

pub fn fill(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style { background: Some(Background::Color(color)), snap: true, ..container::Style::default() }
}

pub fn chrome(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(t.text),
        background: Some(Background::Color(t.chrome)),
        border: no_border(0.0),
        shadow: NO_SHADOW,
        snap: true,
    }
}

/// A hairline between the chrome and the page.
pub fn rule(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    fill(t.border_subtle)
}

/// The notice strip across the top of the page, as Graphite announces things.
pub fn strip(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(t.text),
        background: Some(Background::Color(t.raised)),
        border: no_border(0.0),
        shadow: NO_SHADOW,
        snap: true,
    }
}

/// A menu that opens under its button: an edged card. Flat, like everything here: no shadows
/// (see `halo`).
pub fn menu(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(t.text),
        background: Some(Background::Color(t.surface)),
        border: border(t.border_subtle, RADIUS_LG),
        shadow: NO_SHADOW,
        snap: true,
    }
}

pub fn tooltip(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(t.text_dim),
        background: Some(Background::Color(t.raised)),
        border: border(t.border_subtle, RADIUS_SM),
        shadow: NO_SHADOW,
        snap: true,
    }
}

/// A key, as a shortcut hint shows it.
pub fn keycap(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(t.muted),
        background: Some(Background::Color(t.keycap)),
        border: no_border(4.0),
        shadow: NO_SHADOW,
        snap: true,
    }
}

/// A banner: warnings, errors, notes.
pub fn banner(background: Color, edge: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(background)),
        border: border(edge, RADIUS),
        snap: true,
        ..container::Style::default()
    }
}

/// A chip that is only a label: Graphite's tinted grey, softly edged.
pub fn chip(t: Tokens, color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(color),
        background: Some(Background::Color(t.chip)),
        border: border(t.chip_edge, RADIUS),
        snap: true,
        ..container::Style::default()
    }
}

/// A small mark at each corner of a stage, as Graphite marks its product shots with crosshairs.
pub fn crosshair(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    fill(t.border)
}

/// The light button's frame: a hairline rim, gold to cyan.
pub fn rim(_t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Gradient(Gradient::Linear(
            Linear::new(Radians(FRAC_PI_2)).add_stop(0.0, RIM[0]).add_stop(0.45, RIM[1]).add_stop(0.7, RIM[2]).add_stop(1.0, RIM[3]),
        ))),
        border: no_border(RADIUS),
        snap: true,
        ..container::Style::default()
    }
}

/// One ring of the rim's glow: the rim's two ends, see-through, `strength` of `Tokens::glow`.
/// Rings rather than a shadow: the software renderer draws shadows outside its clip, so they
/// pile up frame on frame wherever the screen isn't redrawn.
pub fn halo(t: Tokens, strength: f32, radius: f32) -> impl Fn(&Theme) -> container::Style {
    move |_| {
        let alpha = t.glow * strength;
        container::Style {
            background: Some(Background::Gradient(Gradient::Linear(
                Linear::new(Radians(FRAC_PI_2)).add_stop(0.0, rgba(GLOW_GOLD, alpha)).add_stop(1.0, rgba(GLOW_CYAN, alpha)),
            ))),
            border: no_border(radius),
            snap: true,
            ..container::Style::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The light button: the one thing on screen to do next. Drawn inside its rim; see
    /// `views::action`.
    Primary,
    /// Dark and recessed.
    Secondary,
    /// Text only, until hovered.
    Ghost,
    Danger,
    /// An item in a list or a segmented choice; `true` when it is the chosen one.
    Nav(bool),
    /// A navigation link, Graphite's way: plain words, grey until current or under the pointer.
    Link(bool),
    /// A small round light button, as Graphite's cards carry.
    Pill,
    /// A tinted chip; `true` when it is the chosen one.
    Chip(bool),
}

pub fn button_style(t: Tokens, kind: Kind) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        let disabled = matches!(status, button::Status::Disabled);
        let (background, text_color, edge, radius) = match kind {
            // One pixel inside the rim's radius, so the rim is even all round.
            Kind::Primary => (Some(if hovered { t.accent_fill_hover } else { t.accent_fill }), t.accent_strong, Color::TRANSPARENT, RADIUS - 1.0),
            Kind::Secondary => (Some(if hovered { t.control_hover } else { t.control }), t.text, t.control_edge, RADIUS),
            Kind::Ghost => (hovered.then_some(t.surface_active), if hovered { t.text } else { t.muted }, Color::TRANSPARENT, RADIUS),
            Kind::Danger => (Some(if hovered { t.danger_fill } else { t.danger_bg }), t.danger_fg, t.danger_border, RADIUS),
            Kind::Nav(true) => (Some(t.surface_active), t.text, Color::TRANSPARENT, RADIUS),
            Kind::Nav(false) => (hovered.then_some(t.surface_hover), if hovered { t.text_dim } else { t.muted }, Color::TRANSPARENT, RADIUS),
            Kind::Link(current) => (None, if current || hovered { t.text } else { t.muted }, Color::TRANSPARENT, RADIUS),
            Kind::Pill => (Some(if hovered { t.accent_fill_hover } else { t.pill }), t.accent_strong, Color::TRANSPARENT, RADIUS_FULL),
            Kind::Chip(chosen) => (
                (chosen || hovered).then_some(t.chip),
                if chosen { t.text } else if hovered { t.text_dim } else { t.muted },
                if chosen { t.chip_edge } else { Color::TRANSPARENT },
                RADIUS,
            ),
        };
        let mut style = button::Style {
            background: background.map(Background::Color),
            text_color,
            border: Border { color: edge, width: if edge == Color::TRANSPARENT { 0.0 } else { 1.0 }, radius: Radius::from(radius) },
            shadow: NO_SHADOW,
            snap: true,
        };
        if disabled {
            style.text_color = Color { a: 0.45, ..style.text_color };
            style.background = style.background.map(|background| match background {
                Background::Color(color) => Background::Color(Color { a: color.a * 0.5, ..color }),
                other => other,
            });
            style.border.color = Color { a: style.border.color.a * 0.5, ..style.border.color };
        }
        style
    }
}

/// A card that is itself a button: an app tile. Its edge lightens under the pointer.
pub fn card_button(t: Tokens) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: Some(Background::Color(if hovered { t.surface_hover } else { t.surface })),
            text_color: t.text,
            border: border(if hovered { t.border } else { t.border_subtle }, RADIUS_LG),
            shadow: NO_SHADOW,
            snap: true,
        }
    }
}

pub fn input_style(t: Tokens) -> impl Fn(&Theme, text_input::Status) -> text_input::Style {
    move |_, status| {
        let focused = matches!(status, text_input::Status::Focused { .. });
        let hovered = matches!(status, text_input::Status::Hovered);
        text_input::Style {
            background: Background::Color(t.surface),
            border: border(
                if focused {
                    t.focus
                } else if hovered {
                    t.border_strong
                } else {
                    t.border
                },
                RADIUS,
            ),
            icon: t.muted,
            placeholder: t.faint,
            value: t.text,
            selection: t.accent_soft,
        }
    }
}

/// The theme a choice resolves to on this machine: "system" follows Windows' own app mode.
/// `OPEN_EMULATOR_THEME=light` or `dark` overrides the setting, for checking a theme without
/// changing anyone's settings.
pub fn resolve(choice: oe_core::settings::ThemeChoice) -> Tokens {
    use oe_core::settings::ThemeChoice;
    match std::env::var("OPEN_EMULATOR_THEME").as_deref() {
        Ok("light") => return LIGHT,
        Ok("dark") => return DARK,
        _ => {}
    }
    match choice {
        ThemeChoice::Dark => DARK,
        ThemeChoice::Light => LIGHT,
        ThemeChoice::System => {
            #[cfg(windows)]
            let light = oe_win::system::apps_use_light_theme().unwrap_or(false);
            #[cfg(not(windows))]
            let light = false;
            if light { LIGHT } else { DARK }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn luminance(c: Color) -> f32 {
        let channel = |v: f32| if v <= 0.040_45 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
        0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }

    fn contrast(a: Color, b: Color) -> f32 {
        let (x, y) = (luminance(a), luminance(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    #[test]
    fn text_is_readable_and_controls_are_visible_in_both_themes() {
        for t in [DARK, LIGHT] {
            for (name, color) in [("text", t.text), ("text_dim", t.text_dim), ("muted", t.muted), ("faint", t.faint), ("ok", t.ok), ("warn", t.warn), ("danger", t.danger)] {
                for (ground, surface) in [("bg", t.bg), ("surface", t.surface)] {
                    let ratio = contrast(color, surface);
                    assert!(ratio >= 4.5, "{name} on {ground} is {ratio:.2}:1 in the {} theme; WCAG AA asks 4.5:1", if t.dark { "dark" } else { "light" });
                }
            }
            assert!(contrast(t.accent_strong, t.accent_fill) >= 4.5, "the light button's label");
            assert!(contrast(t.accent_strong, t.pill) >= 4.5, "a pill's label");
            assert!(contrast(t.text, t.chip) >= 4.5, "a chosen chip's label");
            assert!(contrast(t.muted, t.bg) >= 4.5, "a link's label");
            assert!(contrast(t.text, t.control) >= 4.5, "a dark button's label");
            assert!(contrast(t.danger_fg, t.danger_bg) >= 4.5, "a danger button's label");
            assert!(contrast(t.border, t.bg) >= 3.0, "a field's edge against the page");
            assert!(contrast(t.focus, t.bg) >= 3.0, "a focused field's edge against the page");
        }
    }
}
