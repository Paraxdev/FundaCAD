use gpui::*;

use crate::theme::{self, line_normal, ActiveTheme as _, FS_BODY, FS_SMALL, S_2, S_3, UI_FONT};
use crate::viewport::Viewport;

pub struct Shell {
    viewport: Entity<Viewport>,
    title: SharedString,
    _system: Subscription,
}

impl Shell {
    pub fn new(viewport: Entity<Viewport>, title: SharedString, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&viewport, |_, _, cx| cx.notify()).detach();
        Self { viewport, title, _system: theme::follow_system(window, cx) }
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme();
        let viewport = self.viewport.read(cx);
        let status = match viewport.backend() {
            Some(backend) => format!("{} triangles, {backend}", viewport.triangles()),
            None => format!("{} triangles", viewport.triangles()),
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .font_family(UI_FONT)
            .bg(t.bg)
            .text_color(t.text)
            .child(
                div()
                    .h(px(36.))
                    .px(px(S_3))
                    .flex()
                    .items_center()
                    .text_size(px(FS_BODY))
                    .line_height(line_normal(FS_BODY))
                    .child(self.title.clone()),
            )
            .child(div().flex_1().px(px(S_2)).child(self.viewport.clone()))
            .child(
                div()
                    .h(px(26.))
                    .px(px(S_3))
                    .flex()
                    .items_center()
                    .text_size(px(FS_SMALL))
                    .line_height(line_normal(FS_SMALL))
                    .text_color(t.text_dim)
                    .child(status),
            )
    }
}
