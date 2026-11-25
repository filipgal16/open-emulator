//! The apps installed in the guest, each a tile that opens it.

use iced::widget::{button, column, container, scrollable, text, Row};
use iced::{Alignment, Element, Length};

use super::{column_of, empty, go, more, page_header};
use crate::app::{App, Message, Workspace};
use crate::theme;

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let header = column![page_header(t, "Your apps", "Everything installed on this device, one click from opening."), more(t, "Refresh the list", Some(Message::RefreshApps))]
        .spacing(10)
        .align_x(Alignment::Center)
        .width(Length::Fill);

    let content: Element<'_, Message> = if !app.apps_loaded {
        empty(t, "Your apps", "Asking the device…".into(), None)
    } else if app.apps.is_empty() {
        empty(
            t,
            "Nothing installed yet",
            "Apps you install from the Store, or from a file on this PC, appear here.".into(),
            Some(go(t, "Open the Store", Some(Message::Select(Workspace::Store)))),
        )
    } else {
        let tiles = app.apps.iter().map(|installed| {
            let initial = installed.label.chars().next().unwrap_or('?').to_uppercase().to_string();
            // A dark tile, edged: the light fill is kept for the one thing to do next.
            let mark = container(text(initial).size(theme::TEXT_XL).font(theme::SEMIBOLD).color(t.text))
                .center(44)
                .style(move |_| iced::widget::container::Style {
                    background: Some(iced::Background::Color(t.surface_active)),
                    border: iced::Border { radius: theme::RADIUS_MD.into(), width: 1.0, color: t.border_subtle },
                    ..iced::widget::container::Style::default()
                });
            let tile = column![
                mark,
                text(installed.label.clone()).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text),
                text(installed.package_name.clone()).size(theme::TEXT_XS).color(t.faint),
            ]
            .spacing(6)
            .align_x(Alignment::Center)
            .width(Length::Fixed(148.0));
            button(tile).padding(12).style(theme::card_button(t)).on_press(Message::Launch(installed.package_name.clone())).into()
        });
        scrollable(Row::with_children(tiles).spacing(16).wrap().vertical_spacing(16)).height(Length::Fill).into()
    };

    container(column_of(column![header, content].spacing(28))).padding([32, 32]).width(Length::Fill).height(Length::Fill).into()
}
