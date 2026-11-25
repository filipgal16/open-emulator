//! First run: the checks setup makes, the one long download, and what to do if something fails.

use iced::widget::{column, container, progress_bar, row, scrollable, text, Column};
use iced::{Alignment, Element, Length};
use oe_core::setup::StepState;

use super::{action, go, quiet};
use crate::app::{App, Message};
use crate::icons::{icon, neon_mark, Icon};
use crate::theme::{self, Kind};

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let setup = &app.setup;
    let failed = setup.finished && !app.setup_passed();
    let running = setup.steps.iter().find(|step| step.status == StepState::Running);
    let headline = if failed {
        "Setup could not finish".to_owned()
    } else if setup.steps.iter().all(|step| step.status == StepState::Pending) {
        "Checking this PC".to_owned()
    } else {
        running.map_or_else(|| "Getting things ready".to_owned(), |step| step.label.clone())
    };
    let detail = if failed {
        setup.steps.iter().find(|s| s.status == StepState::Fail).map(|s| s.detail.clone()).unwrap_or_default()
    } else {
        running.map(|step| step.detail.clone()).filter(|d| !d.is_empty()).unwrap_or_else(|| "Checking what this PC already has…".to_owned())
    };

    let mut steps = Column::new().spacing(10);
    for step in &setup.steps {
        let (glyph, color) = match step.status {
            StepState::Pass => (Icon::Check, t.ok),
            StepState::Warn => (Icon::Alert, t.warn),
            StepState::Fail => (Icon::X, t.danger),
            StepState::Running => (Icon::Loader, t.accent),
            StepState::Pending => (Icon::Circle, t.faint),
        };
        steps = steps.push(
            row![
                icon(glyph, 16.0, color),
                column![
                    text(step.label.clone()).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text),
                    text(step.detail.clone()).size(theme::TEXT_SM).color(t.muted),
                ]
                .spacing(2)
            ]
            .spacing(10)
            .align_y(Alignment::Start),
        );
    }

    let mut card = column![
        row![icon(Icon::Brand, 20.0, t.text), text("open-emulator").size(theme::TEXT_LG).font(theme::SEMIBOLD).color(t.text)]
            .spacing(8)
            .align_y(Alignment::Center),
        text(headline).size(theme::DISPLAY).font(theme::HEADLINE).color(t.text),
        text(detail).size(theme::TEXT_LG).color(if failed { t.danger } else { t.muted }),
    ]
    .spacing(14)
    .max_width(520);

    if let Some((done, total)) = setup.progress.filter(|_| setup.running) {
        if total > 0 {
            card = card.push(progress_bar(0.0..=total as f32, done as f32).girth(6));
            card = card.push(quiet(t, format!("{} of {}", oe_store::types::format_bytes(done), oe_store::types::format_bytes(total))));
        }
    }
    card = card.push(container(steps).padding(16).width(Length::Fill).style(theme::panel(t)));

    let mut buttons = row![].spacing(8).align_y(Alignment::Center);
    if failed {
        buttons = buttons.push(go(t, if setup.running { "Trying again…" } else { "Try again" }, (!setup.running).then_some(Message::SetupRetry)));
    }
    if setup.finished && !failed {
        buttons = buttons.push(go(t, "Continue", Some(Message::SetupContinue)));
    }
    buttons = buttons.push(action(t, if setup.show_details { "Hide details" } else { "Details" }, Kind::Ghost, Some(Message::SetupDetails)));
    card = card.push(buttons);

    if setup.show_details {
        let log = setup.log.iter().rev().take(200).rev().fold(Column::new().spacing(2), |column, line| {
            column.push(text(line.clone()).size(theme::TEXT_XS).font(theme::MONO).color(t.muted))
        });
        card = card.push(container(scrollable(log).height(220).anchor_bottom()).padding(10).width(Length::Fill).style(theme::panel(t)));
    }

    // The device screen's hero layout: the words and steps at the left, the neon mark floating at
    // the right.
    let split = row![
        container(card).width(Length::FillPortion(11)),
        container(neon_mark(280.0, t.dark)).center_x(Length::FillPortion(9)),
    ]
    .spacing(32)
    .align_y(Alignment::Center);
    container(container(split).max_width(theme::CONTENT_WIDTH).width(Length::Fill).padding([0, 56]))
        .center(Length::Fill)
        .style(theme::fill(t.bg))
        .into()
}
