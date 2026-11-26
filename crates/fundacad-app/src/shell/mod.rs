//! The workspace: a 36px title bar over the stage, where the 3D view runs full bleed and every panel floats over it.

mod history;
mod items;
mod rail;
mod titlebar;

use gpui::*;

use crate::document::Document;
use crate::theme::{self, ActiveTheme as _, FLOAT_GAP, UI_FONT};
use crate::viewport::Viewport;

pub struct Shell {
    viewport: Entity<Viewport>,
    doc: Document,
    items_tab: usize,
    /// The History step whose values show under it.
    open: Option<usize>,
    _system: Subscription,
}

impl Shell {
    pub fn new(viewport: Entity<Viewport>, doc: Document, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&viewport, |_, _, cx| cx.notify()).detach();
        Self { viewport, doc, items_tab: 0, open: None, _system: theme::follow_system(window, cx) }
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let t = &t;
        let gap = px(FLOAT_GAP);

        let left = div()
            .absolute()
            .top(gap)
            .bottom(gap)
            .left(gap)
            .flex()
            .gap(gap)
            .child(self.items_card(t, cx))
            .child(rail::rail(t));
        let right = div()
            .absolute()
            .top(gap)
            .bottom(gap)
            .right(gap)
            .flex()
            .items_start()
            .gap(gap)
            .child(self.view_controls(t))
            .child(self.history_card(t, cx));

        div()
            .size_full()
            .flex()
            .flex_col()
            .font_family(UI_FONT)
            .bg(t.bg)
            .text_color(t.text)
            .child(self.titlebar(t))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .bg(t.viewport_bg)
                    .child(div().absolute().size_full().child(self.viewport.clone()))
                    .child(left)
                    .child(right),
            )
    }
}
