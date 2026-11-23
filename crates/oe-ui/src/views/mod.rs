//! Every screen, and the pieces they share.

pub mod account;
pub mod apps;
pub mod device;
pub mod settings;
pub mod setup;
pub mod shell;
pub mod store;

use iced::widget::{button, column, container, row, text};
use iced::{Alignment, Color, Element, Length};

use crate::app::{App, Message};
use crate::icons::{icon, Icon};
use crate::theme::{self, Kind, Tokens};

pub fn view(app: &App) -> Element<'_, Message> {
    if app.ready { shell::view(app) } else { setup::view(app) }
}

pub fn heading<'a>(t: Tokens, label: impl text::IntoFragment<'a>) -> Element<'a, Message> {
    text(label).size(theme::TEXT_2XL).font(theme::SEMIBOLD).color(t.text).into()
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

/// A text button. `None` for `on_press` draws it disabled.
pub fn action<'a>(t: Tokens, label: impl text::IntoFragment<'a>, kind: Kind, on_press: Option<Message>) -> Element<'a, Message> {
    button(text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD))
        .padding([6, 12])
        .style(theme::button_style(t, kind))
        .on_press_maybe(on_press)
        .into()
}

pub fn icon_action<'a>(t: Tokens, name: Icon, label: &'a str, kind: Kind, on_press: Option<Message>) -> Element<'a, Message> {
    let color = if on_press.is_some() { t.text } else { t.faint };
    button(row![icon(name, 16.0, color), text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD)].spacing(6).align_y(Alignment::Center))
        .padding([6, 12])
        .style(theme::button_style(t, kind))
        .on_press_maybe(on_press)
        .into()
}

/// A centred empty state: a title and a sentence, and optionally something to do.
pub fn empty<'a>(t: Tokens, title: &'a str, sentence: String, then: Option<Element<'a, Message>>) -> Element<'a, Message> {
    let mut content = column![text(title).size(theme::TEXT_LG).font(theme::SEMIBOLD).color(t.text), body(t, sentence)]
        .spacing(8)
        .align_x(Alignment::Center)
        .max_width(420);
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
