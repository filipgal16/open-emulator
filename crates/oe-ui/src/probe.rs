//! A widget that reports where it is.
//!
//! The emulator's window is a native child window placed *over* a rectangle of ours, so the UI
//! has to know that rectangle in window coordinates. Layout knows it; nothing in iced's stock
//! widgets passes it on. This fills its space, optionally paints a background, and publishes its
//! bounds whenever they change: the iced counterpart of the renderer's `ResizeObserver`.

use iced::advanced::layout::{self, Layout};
use iced::advanced::renderer;
use iced::advanced::widget::{tree, Tree, Widget};
use iced::advanced::{mouse, Clipboard, Shell};
use iced::{Background, Color, Element, Event, Length, Rectangle, Size};

pub struct Probe<'a, Message> {
    on_change: Box<dyn Fn(Rectangle) -> Message + 'a>,
    background: Option<Color>,
}

/// A probe that fills its space and reports its logical bounds through `on_change`.
pub fn probe<'a, Message>(on_change: impl Fn(Rectangle) -> Message + 'a) -> Probe<'a, Message> {
    Probe { on_change: Box::new(on_change), background: None }
}

impl<Message> Probe<'_, Message> {
    pub fn background(mut self, color: Color) -> Self {
        self.background = Some(color);
        self
    }
}

#[derive(Default)]
struct State {
    last: Option<Rectangle>,
}

impl<Message, Theme, Renderer> Widget<Message, Theme, Renderer> for Probe<'_, Message>
where
    Renderer: renderer::Renderer,
{
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn layout(&mut self, _tree: &mut Tree, _renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        layout::Node::new(limits.max())
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn draw(
        &self,
        _tree: &Tree,
        renderer: &mut Renderer,
        _theme: &Theme,
        _style: &renderer::Style,
        layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _viewport: &Rectangle,
    ) {
        if let Some(color) = self.background {
            renderer.fill_quad(
                renderer::Quad { bounds: layout.bounds(), ..renderer::Quad::default() },
                Background::Color(color),
            );
        }
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        _event: &Event,
        layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _renderer: &Renderer,
        _clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        _viewport: &Rectangle,
    ) {
        // Every event passes through here, a redraw included, so a moved or resized probe is
        // noticed on the next frame at the latest.
        let state = tree.state.downcast_mut::<State>();
        let bounds = layout.bounds();
        if state.last != Some(bounds) {
            state.last = Some(bounds);
            shell.publish((self.on_change)(bounds));
        }
    }
}

impl<'a, Message, Theme, Renderer> From<Probe<'a, Message>> for Element<'a, Message, Theme, Renderer>
where
    Message: 'a,
    Renderer: renderer::Renderer + 'a,
{
    fn from(probe: Probe<'a, Message>) -> Self {
        Element::new(probe)
    }
}

/// Logical bounds to physical pixels of the window's client area, which is what Win32 positions
/// child windows in.
pub fn to_physical(bounds: Rectangle, scale: f32) -> oe_win::Rect {
    let round = |v: f32| (v * scale).round() as i32;
    let x = round(bounds.x);
    let y = round(bounds.y);
    // Width and height from the rounded edges, so adjacent rectangles never overlap or gap.
    oe_win::Rect::new(x, y, round(bounds.x + bounds.width) - x, round(bounds.y + bounds.height) - y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_scale_to_physical_pixels_without_gaps() {
        let rect = to_physical(Rectangle::new(iced::Point::new(10.5, 20.0), Size::new(100.25, 50.0)), 1.5);
        assert_eq!(rect, oe_win::Rect::new(16, 30, 150, 75));
    }
}
