//! The design tokens from the Electron app's stylesheet, light and dark, and the widget styles
//! built from them. Dark is the default: ink, paper and one mint — the neutrals carry no hue of
//! their own, so the mint is the only colour on screen until something goes wrong.

use iced::border::Radius;
use iced::widget::{button, container, text_input};
use iced::{Background, Border, Color, Shadow, Theme, Vector};

const fn rgb(hex: u32) -> Color {
    Color::from_rgb8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

const fn rgba(hex: u32, alpha: f32) -> Color {
    Color::from_rgba8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8, alpha)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tokens {
    pub dark: bool,
    pub bg: Color,
    pub bg_deep: Color,
    pub chrome: Color,
    pub nav_track: Color,
    pub surface: Color,
    pub surface_hover: Color,
    pub surface_active: Color,
    pub raised: Color,
    pub border: Color,
    pub border_strong: Color,
    pub border_subtle: Color,
    pub text: Color,
    pub text_dim: Color,
    pub muted: Color,
    pub faint: Color,
    pub accent: Color,
    pub accent_strong: Color,
    pub accent_fill: Color,
    pub accent_fill_hover: Color,
    pub accent_soft: Color,
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
    bg: rgb(0x0b0b0c),
    bg_deep: rgb(0x050506),
    chrome: rgb(0x101011),
    nav_track: rgb(0x08080a),
    surface: rgb(0x161618),
    surface_hover: rgb(0x1e1e21),
    surface_active: rgb(0x27272b),
    raised: rgb(0x1a1a1d),
    border: rgb(0x62636a),
    border_strong: rgb(0x8e8f96),
    border_subtle: rgb(0x2b2b30),
    text: rgb(0xf6f6f4),
    text_dim: rgb(0xd6d6d3),
    muted: rgb(0xa6a7ab),
    faint: rgb(0x8b8c91),
    accent: rgb(0x8ff2cc),
    accent_strong: rgb(0x03140d),
    accent_fill: rgb(0x8ff2cc),
    accent_fill_hover: rgb(0xa9f6d9),
    accent_soft: rgba(0x8ff2cc, 0.11),
    ok: rgb(0x8ff2cc),
    ok_bg: rgb(0x10241c),
    warn: rgb(0xe9bd4a),
    warn_bg: rgb(0x251f0e),
    warn_border: rgb(0x6f5b1c),
    danger: rgb(0xf29a9a),
    danger_fill: rgb(0x8a3e3e),
    danger_bg: rgb(0x2a1717),
    danger_border: rgb(0x5a3030),
    danger_fg: rgb(0xffd3d3),
    idle: rgb(0x6b6c72),
};

pub const LIGHT: Tokens = Tokens {
    dark: false,
    bg: rgb(0xf7f7f5),
    bg_deep: rgb(0xededea),
    chrome: rgb(0xffffff),
    nav_track: rgb(0xededea),
    surface: rgb(0xffffff),
    surface_hover: rgb(0xf4f4f2),
    surface_active: rgb(0xe9e9e6),
    raised: rgb(0xfafaf9),
    border: rgb(0x797a7e),
    border_strong: rgb(0x55565a),
    border_subtle: rgb(0xd8d8d4),
    text: rgb(0x0b0b0c),
    text_dim: rgb(0x2d2e31),
    muted: rgb(0x505156),
    faint: rgb(0x5e5f64),
    accent: rgb(0x0a6e51),
    accent_strong: rgb(0x03140d),
    accent_fill: rgb(0x8ff2cc),
    accent_fill_hover: rgb(0xa9f6d9),
    accent_soft: rgba(0x10966e, 0.1),
    ok: rgb(0x0a6e51),
    ok_bg: rgb(0xe3f7ef),
    warn: rgb(0x8a5b00),
    warn_bg: rgb(0xfbf3dc),
    warn_border: rgb(0xc4a04a),
    danger: rgb(0xb42323),
    danger_fill: rgb(0xb42323),
    danger_bg: rgb(0xfde8e8),
    danger_border: rgb(0xe0a0a0),
    danger_fg: rgb(0x8a1c1c),
    idle: rgb(0x797a7e),
};

// Type scale, in pixels, from the stylesheet's rem values at 16px.
pub const TEXT_2XS: f32 = 11.0;
pub const TEXT_XS: f32 = 12.0;
pub const TEXT_SM: f32 = 13.0;
pub const TEXT_MD: f32 = 14.0;
pub const TEXT_LG: f32 = 16.0;
pub const TEXT_XL: f32 = 18.0;
pub const TEXT_2XL: f32 = 20.0;
pub const TEXT_3XL: f32 = 24.0;

pub const TITLEBAR_HEIGHT: f32 = 44.0;
pub const BEZEL_WIDTH: f32 = 44.0;
pub const BEZEL_BUTTON: f32 = 36.0;

pub const RADIUS_SM: f32 = 6.0;
pub const RADIUS: f32 = 8.0;
pub const RADIUS_MD: f32 = 10.0;
pub const RADIUS_LG: f32 = 14.0;
pub const RADIUS_FULL: f32 = 999.0;

pub const SEMIBOLD: iced::Font = iced::Font { weight: iced::font::Weight::Semibold, ..iced::Font::with_name("Segoe UI") };
pub const MONO: iced::Font = iced::Font::with_name("Cascadia Mono");

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

pub fn panel(t: Tokens) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(t.text),
        background: Some(Background::Color(t.surface)),
        border: border(t.border_subtle, RADIUS_LG),
        shadow: Shadow::default(),
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
        border: Border { color: t.border_subtle, width: 0.0, radius: Radius::from(0.0) },
        shadow: Shadow::default(),
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

pub fn chip(t: Tokens, color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(color),
        background: Some(Background::Color(t.surface_active)),
        border: no_border(RADIUS_FULL),
        snap: true,
        ..container::Style::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Mint fill: the one thing on screen to do next.
    Primary,
    /// Outlined.
    Secondary,
    /// Text only, until hovered.
    Ghost,
    Danger,
    /// A navigation item; `true` when it is the current one.
    Nav(bool),
}

pub fn button_style(t: Tokens, kind: Kind) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        let disabled = matches!(status, button::Status::Disabled);
        let (background, text_color, edge) = match kind {
            Kind::Primary => (Some(if hovered { t.accent_fill_hover } else { t.accent_fill }), t.accent_strong, Color::TRANSPARENT),
            Kind::Secondary => (Some(if hovered { t.surface_hover } else { t.surface }), t.text, t.border),
            Kind::Ghost => (hovered.then_some(t.surface_hover), t.text_dim, Color::TRANSPARENT),
            Kind::Danger => (Some(if hovered { t.danger_fill } else { t.danger_bg }), t.danger_fg, t.danger_border),
            Kind::Nav(true) => (Some(t.surface_active), t.text, Color::TRANSPARENT),
            Kind::Nav(false) => (hovered.then_some(t.surface_hover), t.muted, Color::TRANSPARENT),
        };
        let mut style = button::Style {
            background: background.map(Background::Color),
            text_color,
            border: Border { color: edge, width: if edge == Color::TRANSPARENT { 0.0 } else { 1.0 }, radius: Radius::from(RADIUS) },
            shadow: Shadow { color: Color::TRANSPARENT, offset: Vector::ZERO, blur_radius: 0.0 },
            snap: true,
        };
        if disabled {
            style.text_color = Color { a: 0.45, ..style.text_color };
            style.background = style.background.map(|background| match background {
                Background::Color(color) => Background::Color(Color { a: color.a * 0.5, ..color }),
                other => other,
            });
        }
        style
    }
}

/// A card that is itself a button — an app tile.
pub fn card_button(t: Tokens) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: Some(Background::Color(if hovered { t.surface_hover } else { t.surface })),
            text_color: t.text,
            border: border(if hovered { t.border } else { t.border_subtle }, RADIUS_LG),
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

pub fn input_style(t: Tokens) -> impl Fn(&Theme, text_input::Status) -> text_input::Style {
    move |_, status| {
        let focused = matches!(status, text_input::Status::Focused { .. });
        text_input::Style {
            background: Background::Color(t.surface),
            border: border(if focused { t.accent } else { t.border }, RADIUS),
            icon: t.muted,
            placeholder: t.faint,
            value: t.text,
            selection: t.accent_soft,
        }
    }
}

/// The theme a choice resolves to on this machine: "system" follows Windows' own app mode.
pub fn resolve(choice: oe_core::settings::ThemeChoice) -> Tokens {
    use oe_core::settings::ThemeChoice;
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
