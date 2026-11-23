//! The Lucide icons the Electron app drew, as SVG, tinted to the text around them.

use iced::widget::svg;
use iced::{Color, Element, Length};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Icon {
    ChevronDown,
    Check,
    X,
    Circle,
    Loader,
    Alert,
    Device,
    Apps,
    Store,
    Settings,
    Back,
    Home,
    Recents,
    Rotate,
    Screenshot,
    Fullscreen,
    FullscreenExit,
    VolumeUp,
    VolumeDown,
    Power,
    Key,
    Brand,
    Folder,
}

impl Icon {
    fn body(self) -> &'static str {
        match self {
            Icon::ChevronDown => r#"<path d="m6 9 6 6 6-6"/>"#,
            Icon::Check => r#"<path d="M20 6 9 17l-5-5"/>"#,
            Icon::X => r#"<path d="M18 6 6 18"/><path d="m6 6 12 12"/>"#,
            Icon::Circle => r#"<circle cx="12" cy="12" r="10"/>"#,
            Icon::Loader => r#"<path d="M21 12a9 9 0 1 1-6.219-8.56"/>"#,
            Icon::Alert => r#"<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>"#,
            Icon::Device => r#"<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>"#,
            Icon::Apps => {
                r#"<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>"#
            }
            Icon::Store => r#"<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>"#,
            Icon::Settings => {
                r#"<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>"#
            }
            Icon::Back => r#"<path d="m15 18-6-6 6-6"/>"#,
            Icon::Home => r#"<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>"#,
            Icon::Recents => r#"<rect width="18" height="18" x="3" y="3" rx="2"/>"#,
            Icon::Rotate => r#"<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>"#,
            Icon::Screenshot => {
                r#"<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>"#
            }
            Icon::Fullscreen => {
                r#"<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>"#
            }
            Icon::FullscreenExit => {
                r#"<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>"#
            }
            Icon::VolumeUp => r#"<path d="M11 5v14L6 15H2V9h4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>"#,
            Icon::VolumeDown => r#"<path d="M11 5v14L6 15H2V9h4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>"#,
            Icon::Power => r#"<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>"#,
            Icon::Key => r#"<circle cx="8" cy="15" r="5"/><path d="M13 11 21 3"/><path d="M16 6h5"/><path d="M18 8h4"/>"#,
            // The app's mark: a phone outline with its earpiece, as BrandMark drew it.
            Icon::Brand => r#"<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M10.5 5.5h3"/>"#,
            Icon::Folder => r#"<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>"#,
        }
    }

    pub fn svg(self) -> String {
        format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{}</svg>"##,
            self.body()
        )
    }
}

/// The icon at `size` pixels, in `color`.
pub fn icon<'a, Message: 'a>(name: Icon, size: f32, color: Color) -> Element<'a, Message> {
    svg(svg::Handle::from_memory(name.svg().into_bytes()))
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
        .style(move |_, _| svg::Style { color: Some(color) })
        .into()
}
