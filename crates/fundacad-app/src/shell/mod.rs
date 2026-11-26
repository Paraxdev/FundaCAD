use gpui::*;

use crate::theme::Theme;
use crate::viewport::Viewport;

pub struct Shell {
    viewport: Entity<Viewport>,
    title: SharedString,
    theme: Theme,
    focus: FocusHandle,
}

impl Shell {
    pub fn new(viewport: Entity<Viewport>, title: SharedString, cx: &mut Context<Self>) -> Self {
        cx.observe(&viewport, |_, _, cx| cx.notify()).detach();
        Self { viewport, title, theme: crate::theme::dark(), focus: cx.focus_handle() }
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Actions go only to the window root while nothing has focus, so the shell takes it.
        if window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        let t = &self.theme;
        let status = self.viewport.read(cx).status();
        let viewport = self.viewport.clone();
        let redo = self.viewport.clone();
        div()
            .size_full()
            .track_focus(&self.focus)
            .on_action(move |_: &crate::viewport::Undo, _, cx| viewport.update(cx, |v, cx| v.undo(cx)))
            .on_action(move |_: &crate::viewport::Redo, _, cx| redo.update(cx, |v, cx| v.redo(cx)))
            .flex()
            .flex_col()
            .bg(t.bg)
            .text_color(t.text)
            .child(div().h(px(36.)).px_3().flex().items_center().text_sm().child(self.title.clone()))
            .child(div().flex_1().px_2().child(self.viewport.clone()))
            .child(div().h(px(26.)).px_3().flex().items_center().text_xs().text_color(t.text_dim).child(status))
    }
}
