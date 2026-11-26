use gpui::*;

use crate::theme::Theme;
use crate::viewport::Viewport;

pub struct Shell {
    viewport: Entity<Viewport>,
    title: SharedString,
    theme: Theme,
}

impl Shell {
    pub fn new(viewport: Entity<Viewport>, title: SharedString, cx: &mut Context<Self>) -> Self {
        cx.observe(&viewport, |_, _, cx| cx.notify()).detach();
        Self { viewport, title, theme: crate::theme::dark() }
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &self.theme;
        let viewport = self.viewport.read(cx);
        let status = match viewport.backend() {
            Some(backend) => format!("{} triangles, {backend}", viewport.triangles()),
            None => format!("{} triangles", viewport.triangles()),
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .text_color(t.text)
            .child(div().h(px(36.)).px_3().flex().items_center().text_sm().child(self.title.clone()))
            .child(div().flex_1().px_2().child(self.viewport.clone()))
            .child(div().h(px(26.)).px_3().flex().items_center().text_xs().text_color(t.text_dim).child(status))
    }
}
