//! Every screen, and the pieces they share.

pub mod account;
pub mod apps;
pub mod device;
pub mod settings;
pub mod setup;
pub mod shell;
pub mod store;

use iced::widget::{button, column, container, row, text, tooltip, Row};
use iced::{Alignment, Color, Element, Length};

use crate::app::{App, Message};
use crate::icons::{icon, Icon};
use crate::theme::{self, Kind, Tokens};

pub fn view(app: &App) -> Element<'_, Message> {
    if app.ready { shell::view(app) } else { setup::view(app) }
}

pub fn heading<'a>(t: Tokens, label: impl text::IntoFragment<'a>) -> Element<'a, Message> {
    text(label).size(theme::TEXT_4XL).font(theme::HEADLINE).color(t.text).into()
}

/// How Graphite opens a section: a large headline, and a grey line under it, centred.
pub fn page_header<'a>(t: Tokens, title: &'a str, subline: &'a str) -> Element<'a, Message> {
    column![
        text(title).size(theme::DISPLAY).font(theme::HEADLINE).color(t.text).center(),
        text(subline).size(theme::TEXT_LG).color(t.muted).center(),
    ]
    .spacing(8)
    .align_x(Alignment::Center)
    .width(Length::Fill)
    .into()
}

/// The page's content in Graphite's centred column.
pub fn column_of<'a>(content: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    container(container(content).max_width(theme::CONTENT_WIDTH).width(Length::Fill)).center_x(Length::Fill).into()
}

/// A small round light button, as Graphite's cards carry.
pub fn pill<'a>(t: Tokens, label: impl text::IntoFragment<'a>, on_press: Option<Message>) -> Element<'a, Message> {
    button(text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD)).padding([5, 14]).style(theme::button_style(t, Kind::Pill)).on_press_maybe(on_press).into()
}

/// Graphite's "Read more →": grey words and an arrow, white under the pointer.
pub fn more<'a>(t: Tokens, label: impl text::IntoFragment<'a>, on_press: Option<Message>) -> Element<'a, Message> {
    button(row![text(label).size(theme::TEXT_SM).font(theme::MEDIUM), icon(Icon::ArrowRight, 13.0, t.muted)].spacing(5).align_y(Alignment::Center))
        .padding([3, 0])
        .style(theme::button_style(t, Kind::Link(false)))
        .on_press_maybe(on_press)
        .into()
}

/// A tinted chip that can be chosen, with an optional line icon.
pub fn chip<'a>(t: Tokens, glyph: Option<Icon>, label: &'a str, chosen: bool, on_press: Option<Message>) -> Element<'a, Message> {
    let mut content = row![].spacing(7).align_y(Alignment::Center);
    if let Some(glyph) = glyph {
        content = content.push(icon(glyph, 14.0, if chosen { t.text } else { t.muted }));
    }
    content = content.push(text(label).size(theme::TEXT_SM).font(theme::MEDIUM));
    button(content).padding([6, 12]).style(theme::button_style(t, Kind::Chip(chosen))).on_press_maybe(on_press).into()
}

/// The light button inside its rim and the two rings of its glow; any other kind as it is. A
/// light button that can't be pressed loses its rim with its colour, but keeps its place.
fn framed<'a>(t: Tokens, kind: Kind, enabled: bool, button: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    if kind != Kind::Primary {
        return button.into();
    }
    if !enabled {
        return container(button).padding(GLOW_SPAN).into();
    }
    let rim = container(button).padding(1).style(theme::rim(t));
    let near = container(rim).padding(2).style(theme::halo(t, 0.5, theme::RADIUS + 2.0));
    container(near).padding(GLOW_SPAN - 3.0).style(theme::halo(t, 0.2, theme::RADIUS + GLOW_SPAN - 1.0)).into()
}

/// How far the glow reaches past the button, rim included.
const GLOW_SPAN: f32 = 6.0;

/// Keys as keycaps: `["Alt", "S"]`.
pub fn keys<'a>(t: Tokens, keys: &[&'a str]) -> Element<'a, Message> {
    keys.iter()
        .fold(Row::new().spacing(3), |row, key| {
            row.push(container(text(*key).size(theme::TEXT_2XS).font(theme::MEDIUM)).padding([1, 5]).style(theme::keycap(t)))
        })
        .into()
}

/// A hint on hover, raised off the page, with the shortcut as keycaps when there is one.
pub fn tip<'a>(t: Tokens, content: impl Into<Element<'a, Message>>, hint: &'a str, shortcut: &[&'a str], position: tooltip::Position) -> Element<'a, Message> {
    let mut label = row![text(hint).size(theme::TEXT_XS).color(t.text_dim)].spacing(8).align_y(Alignment::Center);
    if !shortcut.is_empty() {
        label = label.push(keys(t, shortcut));
    }
    tooltip(content, container(label).padding([5, 8]).style(theme::tooltip(t)), position).gap(6).into()
}

pub fn section<'a>(t: Tokens, label: impl text::IntoFragment<'a>) -> Element<'a, Message> {
    text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD).color(t.muted).into()
}

pub fn body<'a>(t: Tokens, words: impl text::IntoFragment<'a>) -> Element<'a, Message> {
    text(words).size(theme::TEXT_MD).color(t.text_dim).into()
}

pub fn quiet<'a>(t: Tokens, words: impl text::IntoFragment<'a>) -> Element<'a, Message> {
    text(words).size(theme::TEXT_SM).color(t.muted).into()
}

/// Copy under a headline: body-sized, in the grey Graphite sets its copy in.
pub fn quiet_body<'a>(t: Tokens, words: impl text::IntoFragment<'a>) -> Element<'a, Message> {
    text(words).size(theme::TEXT_MD).color(t.muted).center().into()
}

/// A text button. `None` for `on_press` draws it disabled.
pub fn action<'a>(t: Tokens, label: impl text::IntoFragment<'a>, kind: Kind, on_press: Option<Message>) -> Element<'a, Message> {
    let enabled = on_press.is_some();
    let padding = if kind == Kind::Primary { [6, 14] } else { [6, 12] };
    framed(t, kind, enabled, button(text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD)).padding(padding).style(theme::button_style(t, kind)).on_press_maybe(on_press))
}

/// The thing to do next, Graphite's way: the light button, with an arrow.
pub fn go<'a>(t: Tokens, label: impl text::IntoFragment<'a>, on_press: Option<Message>) -> Element<'a, Message> {
    let enabled = on_press.is_some();
    let content = row![text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD), icon(Icon::ArrowRight, 14.0, t.accent_strong)].spacing(6).align_y(Alignment::Center);
    framed(t, Kind::Primary, enabled, button(content).padding([7, 14]).style(theme::button_style(t, Kind::Primary)).on_press_maybe(on_press))
}

pub fn icon_action<'a>(t: Tokens, name: Icon, label: &'a str, kind: Kind, on_press: Option<Message>) -> Element<'a, Message> {
    let enabled = on_press.is_some();
    let color = match (kind, enabled) {
        (_, false) => t.faint,
        (Kind::Primary, true) => t.accent_strong,
        (_, true) => t.text,
    };
    framed(
        t,
        kind,
        enabled,
        button(row![icon(name, 16.0, color), text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD)].spacing(6).align_y(Alignment::Center))
            .padding([6, 12])
            .style(theme::button_style(t, kind))
            .on_press_maybe(on_press),
    )
}

/// A centred empty state: a title and a sentence, and optionally something to do.
pub fn empty<'a>(t: Tokens, title: &'a str, sentence: String, then: Option<Element<'a, Message>>) -> Element<'a, Message> {
    let mut content = column![text(title).size(theme::TEXT_2XL).font(theme::SEMIBOLD).color(t.text), quiet_body(t, sentence)]
        .spacing(10)
        .align_x(Alignment::Center)
        .max_width(440);
    if let Some(then) = then {
        content = content.push(then);
    }
    container(content).center(Length::Fill).into()
}

pub fn banner<'a>(background: Color, edge: Color, color: Color, words: String) -> Element<'a, Message> {
    container(text(words).size(theme::TEXT_SM).color(color))
        .padding([8, 12])
        .width(Length::Fill)
        .style(theme::banner(background, edge))
        .into()
}

/// `1.4 GB`, `600 MB`.
pub fn megabytes(mb: u32) -> String {
    if mb >= 1024 { format!("{:.1} GB", f64::from(mb) / 1024.0).replace(".0 GB", " GB") } else { format!("{mb} MB") }
}
