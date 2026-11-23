//! The apps installed in the guest, each a tile that opens it.

use iced::widget::{button, column, container, row, scrollable, space, text, Row};
use iced::{Alignment, Element, Length};

use super::{action, empty, heading, quiet};
use crate::app::{App, Message, Workspace};
use crate::theme::{self, Kind};

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let header = row![
        column![heading(t, "Your apps"), quiet(t, "Installed on this device")].spacing(2),
        space().width(Length::Fill),
        action(t, "Refresh", Kind::Secondary, Some(Message::RefreshApps)),
    ]
    .align_y(Alignment::Center);

    let content: Element<'_, Message> = if !app.apps_loaded {
        empty(t, "Your apps", "Asking the device…".into(), None)
    } else if app.apps.is_empty() {
        empty(
            t,
            "Nothing installed yet",
            "Apps you install from the Store, or from a file on this PC, appear here.".into(),
            Some(action(t, "Open the Store", Kind::Primary, Some(Message::Select(Workspace::Store)))),
        )
    } else {
        let tiles = app.apps.iter().map(|installed| {
            let initial = installed.label.chars().next().unwrap_or('?').to_uppercase().to_string();
            let mark = container(text(initial).size(theme::TEXT_XL).font(theme::SEMIBOLD).color(t.accent_strong))
                .center(44)
                .style(move |_| iced::widget::container::Style {
                    background: Some(iced::Background::Color(t.accent_fill)),
                    border: iced::Border { radius: theme::RADIUS_MD.into(), ..iced::Border::default() },
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
        scrollable(Row::with_children(tiles).spacing(12).wrap()).height(Length::Fill).into()
    };

    container(column![header, content].spacing(16)).padding(24).width(Length::Fill).height(Length::Fill).into()
}
