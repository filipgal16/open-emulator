//! The store: one search box over F-Droid and the files on this PC, app details, the install
//! queue, and Play, which runs inside the guest.

use iced::widget::{button, column, container, image, progress_bar, row, scrollable, space, text, text_input, Column, Row};
use iced::{Alignment, Element, Length};
use oe_store::types::{format_bytes, install_blocked, AppDetail, InstallJob, InstallState, SourceId, StoreApp};

use super::{action, body, empty, heading, quiet, section};
use crate::app::{App, Message};
use crate::icons::{icon, Icon};
use crate::theme::{self, Kind};

/// F-Droid's anti-features, said plainly.
fn anti_feature(id: &str) -> &str {
    match id {
        "Ads" => "Contains ads",
        "Tracking" => "Tracks you",
        "NonFreeNet" => "Uses non-free network services",
        "NonFreeAdd" => "Promotes non-free add-ons",
        "NonFreeDep" => "Depends on non-free software",
        "NonFreeAssets" => "Contains non-free assets",
        "UpstreamNonFree" => "Upstream includes non-free parts",
        "NonFreeComp" => "Includes non-free components",
        "KnownVuln" => "Has a known vulnerability",
        "DisabledAlgorithm" => "Uses a disabled algorithm",
        "NoSourceSince" => "Source is no longer available",
        "NSFW" => "Not safe for work",
        "TetheredNet" => "Needs a specific online service",
        other => other,
    }
}

fn percent(job: &InstallJob) -> Option<u64> {
    (job.bytes_total > 0).then(|| job.bytes_done.min(job.bytes_total) * 100 / job.bytes_total)
}

/// What an app's button says: its job's progress, or whether it can be installed at all.
fn button_label(app: &App, item: &StoreApp) -> (String, Option<Message>) {
    if let Some(job) = app.job_for(item.source, &item.package_name).filter(|job| job.state != InstallState::Failed) {
        let label = match job.state {
            InstallState::Queued => "Queued".to_owned(),
            InstallState::Downloading => percent(job).map_or_else(|| "Downloading".to_owned(), |p| format!("{p}%")),
            InstallState::Verifying => "Verifying".to_owned(),
            InstallState::Unpacking => "Unpacking".to_owned(),
            InstallState::Installing => "Installing".to_owned(),
            InstallState::Done | InstallState::Failed => "Installed".to_owned(),
        };
        return (label, None);
    }
    if app.is_installed(&item.package_name) {
        return ("Installed".into(), None);
    }
    if install_blocked(item, app.store.state.guest_sdk).is_some() {
        return ("Unavailable".into(), None);
    }
    ("Install".into(), Some(Message::StoreInstall(item.source, item.package_name.clone(), None)))
}

fn app_icon<'a>(app: &'a App, item: &StoreApp, size: f32) -> Element<'a, Message> {
    let t = app.tokens;
    match item.icon.as_deref().and_then(|path| app.image_for(path)) {
        Some(handle) => image(handle.clone()).width(size).height(size).into(),
        None => {
            let initial = item.name.chars().next().unwrap_or('?').to_uppercase().to_string();
            container(text(initial).size(size * 0.45).font(theme::SEMIBOLD).color(t.text_dim))
                .center(size)
                .style(move |_| iced::widget::container::Style {
                    background: Some(iced::Background::Color(t.surface_active)),
                    border: iced::Border { radius: theme::RADIUS_MD.into(), ..iced::Border::default() },
                    ..iced::widget::container::Style::default()
                })
                .into()
        }
    }
}

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let store = &app.store;
    let state = &store.state;
    let device_ready = state.guest_sdk.is_some();

    let placeholder = if store.source == Some(SourceId::Play) {
        "Search inside Play…".to_owned()
    } else if state.index_ready {
        format!("Search {} apps…", state.index_app_count)
    } else {
        "Search apps…".to_owned()
    };
    let search = text_input(&placeholder, &store.query)
        .on_input(Message::StoreQuery)
        .on_submit(if store.source == Some(SourceId::Play) { Message::PlaySearch } else { Message::StoreSearch })
        .padding(8)
        .size(theme::TEXT_MD)
        .style(theme::input_style(t));

    let mut sources = row![].spacing(4);
    for (label, source) in [("All", None), ("F-Droid", Some(SourceId::Fdroid)), ("On this PC", Some(SourceId::Local)), ("Play", Some(SourceId::Play))] {
        sources = sources.push(
            button(text(label).size(theme::TEXT_SM).font(theme::SEMIBOLD))
                .padding([5, 10])
                .style(theme::button_style(t, Kind::Nav(store.source == source)))
                .on_press(Message::StoreSource(source)),
        );
    }
    let from_file = button(row![icon(Icon::Folder, 14.0, t.text), text("Install from file").size(theme::TEXT_SM).font(theme::SEMIBOLD)].spacing(6).align_y(Alignment::Center))
        .padding([6, 12])
        .style(theme::button_style(t, Kind::Secondary))
        .on_press_maybe(device_ready.then_some(Message::InstallFromFile));

    let header = column![
        row![heading(t, "Store"), space().width(Length::Fill), from_file].align_y(Alignment::Center),
        row![search.width(Length::Fill), sources].spacing(12).align_y(Alignment::Center),
    ]
    .spacing(12);

    let main: Element<'_, Message> = if store.source == Some(SourceId::Play) {
        play(app)
    } else if let Some(detail) = &store.detail {
        detail_view(app, detail)
    } else {
        results(app)
    };

    let mut page = column![header].spacing(16);
    if let Some(message) = &store.message {
        page = page.push(super::banner(t.warn_bg, t.warn_border, t.text, message.clone()));
    }
    page = page.push(row![container(main).width(Length::Fill).height(Length::Fill), queue(app)].spacing(16).height(Length::Fill));
    page = page.push(quiet(t, state.guest_sdk.map_or_else(|| "Device not running".to_owned(), |sdk| format!("Device API {sdk}"))));
    container(page).padding(24).width(Length::Fill).height(Length::Fill).into()
}

fn results(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let store = &app.store;
    if store.results.is_empty() {
        let (title, sentence) = if store.searching {
            ("Searching", "One moment.".to_owned())
        } else if !store.query.trim().is_empty() {
            ("Nothing matched", "Try a different name, or install an app file from this PC with Install from file.".to_owned())
        } else if store.source == Some(SourceId::Local) {
            ("No app files yet", SourceId::Local.empty_hint().to_owned())
        } else if store.state.index_ready {
            ("The catalogue is empty", "The F-Droid index is downloaded once, then searched locally.".to_owned())
        } else {
            ("Fetching the catalogue", "Fetching the F-Droid catalogue — this happens once, then search is local.".to_owned())
        };
        return empty(t, title, sentence, None);
    }
    let label = if store.query.trim().is_empty() {
        if store.source == Some(SourceId::Local) { "On this PC" } else { "Recently updated" }
    } else {
        "Results"
    };
    let cards = store.results.iter().map(|item| card(app, item));
    column![section(t, label), scrollable(Row::with_children(cards).spacing(12).wrap()).height(Length::Fill)].spacing(10).into()
}

fn card<'a>(app: &'a App, item: &'a StoreApp) -> Element<'a, Message> {
    let t = app.tokens;
    let (label, install) = button_label(app, item);
    let mut facts = row![text(format_bytes(item.size_bytes)).size(theme::TEXT_XS).color(t.faint)].spacing(8);
    if item.source == SourceId::Local {
        facts = facts.push(text("On this PC").size(theme::TEXT_XS).color(t.faint));
    }
    let tile = column![
        row![app_icon(app, item, 40.0), column![
            text(item.name.clone()).size(theme::TEXT_MD).font(theme::SEMIBOLD).color(t.text),
            facts,
        ]
        .spacing(2)]
        .spacing(10)
        .align_y(Alignment::Center),
        text(item.summary.clone()).size(theme::TEXT_SM).color(t.muted).height(36),
        row![space().width(Length::Fill), action(t, label, Kind::Secondary, install)],
    ]
    .spacing(8)
    .width(Length::Fixed(236.0));
    button(tile).padding(12).style(theme::card_button(t)).on_press(Message::StoreOpen(item.source, item.package_name.clone())).into()
}

fn detail_view<'a>(app: &'a App, detail: &'a AppDetail) -> Element<'a, Message> {
    let t = app.tokens;
    let item = &detail.app;
    let guest_sdk = app.store.state.guest_sdk;
    let (label, install) = button_label(app, item);
    let fact = |key: &'a str, value: String| column![text(key).size(theme::TEXT_XS).color(t.faint), text(value).size(theme::TEXT_SM).color(t.text)].spacing(2);

    let mut page = column![
        action(t, "Back to results", Kind::Ghost, Some(Message::StoreBack)),
        row![app_icon(app, item, 64.0), column![heading(t, item.name.clone()), body(t, item.summary.clone())].spacing(4), space().width(Length::Fill), action(t, label, Kind::Primary, install)]
            .spacing(16)
            .align_y(Alignment::Center),
        row![
            fact("Version", if item.version_name.is_empty() { "—".into() } else { item.version_name.clone() }),
            fact("Size", format_bytes(item.size_bytes)),
            fact("Licence", item.license.clone().unwrap_or_else(|| "—".into())),
            fact("Minimum API", if item.min_sdk == 0 { "—".into() } else { item.min_sdk.to_string() }),
            fact("Source", item.source.label().to_owned()),
        ]
        .spacing(28),
    ]
    .spacing(16);

    if let Some(reason) = install_blocked(item, guest_sdk) {
        let sentence = if guest_sdk.is_none() {
            "Start the device to see whether this app can run on it.".to_owned()
        } else {
            format!("This build needs API {}. This device is on API {}, so it can’t install.", item.min_sdk, guest_sdk.unwrap_or(0))
        };
        page = page.push(super::banner(t.warn_bg, t.warn_border, t.text, sentence));
        let _ = reason;
    }
    page = page.push(column![
        section(t, "Native code"),
        body(t, if item.abis.is_empty() { "None — runs on any device".to_owned() } else { item.abis.join(", ") }),
    ].spacing(4));
    if !item.anti_features.is_empty() {
        let things = item.anti_features.iter().fold(Column::new().spacing(2), |column, id| column.push(body(t, format!("• {}", anti_feature(id)))));
        page = page.push(column![section(t, "Things to know"), things].spacing(4));
    }
    if !detail.screenshots.is_empty() {
        let shots = detail.screenshots.iter().filter_map(|path| app.image_for(path)).map(|handle| image(handle.clone()).height(280).into());
        page = page.push(scrollable(Row::with_children(shots).spacing(8)).direction(scrollable::Direction::Horizontal(scrollable::Scrollbar::default())));
    }
    if !detail.description.is_empty() {
        page = page.push(column![section(t, "About"), body(t, detail.description.clone())].spacing(4));
    }
    for (key, value) in [("Website", &detail.web_site), ("Source code", &detail.source_code)] {
        if let Some(value) = value {
            page = page.push(column![section(t, key), text(value.clone()).size(theme::TEXT_SM).color(t.accent)].spacing(4));
        }
    }
    if !detail.other_versions.is_empty() {
        let mut versions = Column::new().spacing(6);
        for version in &detail.other_versions {
            let blocked = guest_sdk.is_some_and(|sdk| version.min_sdk > sdk);
            let note = if blocked {
                format!("This build needs API {}. This device is on API {}.", version.min_sdk, guest_sdk.unwrap_or(0))
            } else {
                format_bytes(version.size_bytes)
            };
            versions = versions.push(
                row![
                    text(version.version_name.clone()).size(theme::TEXT_SM).font(theme::SEMIBOLD).color(t.text),
                    text(note).size(theme::TEXT_XS).color(t.faint),
                    space().width(Length::Fill),
                    action(
                        t,
                        "Install",
                        Kind::Secondary,
                        (!blocked && guest_sdk.is_some()).then(|| Message::StoreInstall(item.source, item.package_name.clone(), Some(version.version_code)))
                    ),
                ]
                .spacing(12)
                .align_y(Alignment::Center),
            );
        }
        page = page.push(column![section(t, "Other versions"), versions].spacing(6));
    }
    scrollable(page.padding([0, 4])).height(Length::Fill).into()
}

fn play(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let state = &app.store.state;
    let mut page = column![
        heading(t, "Google Play"),
        body(t, "The real Play Store runs inside the device. Open it, or search it with the box above — results show on the device screen."),
    ]
    .spacing(12)
    .max_width(560);
    if state.guest_sdk.is_some() && !state.play_available {
        page = page.push(super::banner(
            t.warn_bg,
            t.warn_border,
            t.text,
            "This Android version doesn’t include the Play Store. Choose “Play Store” in the Android version menu.".into(),
        ));
    }
    if state.identity_spoofed {
        page = page.push(super::banner(
            t.warn_bg,
            t.warn_border,
            t.text,
            "The device is reporting as another phone, and Play may refuse to sign in because of it. Set Device identity to Default in Settings.".into(),
        ));
    }
    let ready = state.guest_sdk.is_some();
    page = page.push(row![
        action(t, "Open Play", Kind::Primary, ready.then_some(Message::PlayOpen)),
        action(t, "Search Play", Kind::Secondary, (ready && !app.store.query.trim().is_empty()).then_some(Message::PlaySearch)),
        action(t, "Back", Kind::Ghost, ready.then_some(Message::PlayBack)),
    ]
    .spacing(8));
    container(page).padding([8, 0]).into()
}

fn queue(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    if app.store.jobs.is_empty() {
        return space().width(0).into();
    }
    let mut list = column![section(t, "Installs")].spacing(10);
    for job in app.store.jobs.iter().take(12) {
        let (title, detail) = match job.state {
            InstallState::Queued => ("Queued".to_owned(), "Waiting to start".to_owned()),
            InstallState::Downloading => (
                percent(job).map_or_else(|| "Downloading".to_owned(), |p| format!("Downloading · {p}%")),
                format!("{} of {}", format_bytes(job.bytes_done), format_bytes(job.bytes_total)),
            ),
            InstallState::Verifying => ("Verifying".to_owned(), "Checking the file against its published digest".to_owned()),
            InstallState::Unpacking => (
                percent(job).map_or_else(|| "Unpacking".to_owned(), |p| format!("Unpacking · {p}%")),
                "Getting this app’s files ready".to_owned(),
            ),
            InstallState::Installing => ("Installing".to_owned(), "Writing into the device".to_owned()),
            InstallState::Done => ("Installed".to_owned(), job.error.clone().unwrap_or_else(|| "Ready to open from Apps".to_owned())),
            InstallState::Failed => ("Couldn’t install".to_owned(), job.error.clone().unwrap_or_else(|| "Something went wrong".to_owned())),
        };
        let color = match job.state {
            InstallState::Failed => t.danger,
            InstallState::Done => t.ok,
            _ => t.text,
        };
        let mut entry = column![
            text(job.label.clone()).size(theme::TEXT_SM).font(theme::SEMIBOLD).color(t.text),
            text(title).size(theme::TEXT_XS).color(color),
            text(detail).size(theme::TEXT_XS).color(t.faint),
        ]
        .spacing(2);
        if !job.state.is_finished() {
            let fraction = percent(job).unwrap_or(0) as f32;
            entry = entry.push(progress_bar(0.0..=100.0, fraction).girth(4));
        }
        list = list.push(entry);
    }
    container(scrollable(list)).padding(12).width(260).height(Length::Fill).style(theme::panel(t)).into()
}
