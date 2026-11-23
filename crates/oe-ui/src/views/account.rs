//! The device-wide account: who you are, an optional stored password, and help signing the guest
//! in. Google's own sign-in runs on the device screen; nothing past opening it is automated.

use iced::widget::{column, container, row, scrollable, text_input, toggler};
use iced::{Alignment, Element, Length};
use oe_core::account::{FillField, SignInState};

use super::{action, body, heading, quiet, section};
use crate::app::{App, Message};
use crate::theme::{self, Kind};

pub fn view(app: &App) -> Element<'_, Message> {
    let t = app.tokens;
    let Some(state) = &app.account.state else {
        return super::empty(t, "Account", "Loading…".into(), None);
    };
    let profile = &state.profile;
    let input = |placeholder: &str, value: &str| text_input(placeholder, value).padding(8).size(theme::TEXT_MD).style(theme::input_style(t));

    let identity = column![
        section(t, "You"),
        row![
            input("Your name", &app.account.name).on_input(Message::NameInput).on_submit(Message::SaveName).width(Length::Fill),
            action(t, "Save", Kind::Secondary, Some(Message::SaveName)),
        ]
        .spacing(8),
        row![
            input("Google address", &app.account.email).on_input(Message::EmailInput).on_submit(Message::SaveEmail).width(Length::Fill),
            action(t, "Save", Kind::Secondary, Some(Message::SaveEmail)),
        ]
        .spacing(8),
    ]
    .spacing(8);

    let mut password = column![section(t, "Password")].spacing(8);
    if profile.has_stored_password {
        password = password.push(body(t, "A password is stored in the Windows keychain, readable only by your Windows account on this PC."));
        password = password.push(toggler(profile.auto_fill).label("Let assisted sign-in type it").text_size(theme::TEXT_SM).on_toggle(Message::SetAutoFill));
        password = password.push(action(t, "Forget the password", Kind::Danger, Some(Message::ClearPassword)));
    } else if state.vault_available {
        password = password.push(quiet(t, "Optional. Stored with Windows' own encryption, and only ever typed into the device — never shown again."));
        password = password.push(
            row![
                input("Password", &app.account.password).secure(true).on_input(Message::PasswordInput).on_submit(Message::SavePassword).width(Length::Fill),
                action(t, "Store", Kind::Secondary, (!app.account.password.is_empty()).then_some(Message::SavePassword)),
            ]
            .spacing(8),
        );
    } else {
        password = password.push(quiet(t, "This PC has no keychain to keep a password in, so none is stored."));
    }

    let guest = &state.guest;
    let status = match guest.state {
        SignInState::Unknown => "The device hasn’t been asked yet.".to_owned(),
        SignInState::GuestUnavailable => "Start the device to see who it is signed in as.".to_owned(),
        SignInState::SignedOut => "The device isn’t signed in to Google.".to_owned(),
        SignInState::SignedIn => format!("Signed in as {}", guest.accounts.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")),
    };
    let device = column![
        section(t, "On the device"),
        body(t, status),
        row![
            action(t, "Sign in on the device", Kind::Primary, Some(Message::BeginSignIn)),
            action(t, "Type my address", Kind::Secondary, profile.email.is_some().then_some(Message::Fill(FillField::Email))),
            action(t, "Type my password", Kind::Secondary, (profile.has_stored_password && profile.auto_fill).then_some(Message::Fill(FillField::Password))),
        ]
        .spacing(8)
        .align_y(Alignment::Center),
        quiet(t, "Tap the field on the device first, then choose what to type."),
    ]
    .spacing(8);

    let mut page = column![
        row![heading(t, "Account"), iced::widget::space().width(Length::Fill), action(t, "Close", Kind::Ghost, Some(Message::ToggleAccount))]
            .align_y(Alignment::Center),
        container(identity).padding(16).width(Length::Fill).style(theme::panel(t)),
        container(password).padding(16).width(Length::Fill).style(theme::panel(t)),
        container(device).padding(16).width(Length::Fill).style(theme::panel(t)),
    ]
    .spacing(16)
    .max_width(640);
    if let Some(message) = &app.account.message {
        page = page.push(body(t, message.clone()));
    }
    page = page.push(action(t, "Sign out of this app", Kind::Danger, Some(Message::SignOut)));
    scrollable(container(page).padding(24).center_x(Length::Fill)).height(Length::Fill).into()
}
