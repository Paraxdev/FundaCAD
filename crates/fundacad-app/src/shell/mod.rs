//! The workspace: a 36px title bar over the stage, where the 3D view runs full bleed and every panel floats over it.

mod history;
mod items;
mod rail;
mod titlebar;

use gpui::*;

use crate::document::Document;
use crate::theme::{self, ActiveTheme as _, FLOAT_GAP, FS_SMALL, S_2, S_3, UI_FONT};
use crate::ui::{chip, icon, text};
use crate::viewport::Viewport;

pub struct Shell {
    viewport: Entity<Viewport>,
    doc: Document,
    items_tab: usize,
    /// The History step whose values show under it.
    open: Option<usize>,
    /// Why the file did not open, shown over the view.
    notice: Option<SharedString>,
    _system: Subscription,
}

impl Shell {
    pub fn new(
        viewport: Entity<Viewport>,
        doc: Document,
        notice: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&viewport, |_, _, cx| cx.notify()).detach();
        Self { viewport, doc, items_tab: 0, open: None, notice, _system: theme::follow_system(window, cx) }
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
        let notice = self.notice.clone().map(|msg| {
            div().absolute().left_0().right_0().bottom(gap).flex().justify_center().child(
                chip(t)
                    .max_w(px(560.))
                    .px(px(S_3))
                    .py(px(S_2))
                    .flex()
                    .items_center()
                    .gap(px(S_2))
                    .child(icon("error", 14., t.error))
                    .child(text(t, FS_SMALL).min_w_0().child(msg)),
            )
        });

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
                    .child(right)
                    .children(notice),
            )
    }
}

#[cfg(test)]
mod tests {
    use gpui::AssetSource as _;

    use crate::assets::Assets;
    use crate::document::Document;

    /// Every name the shell draws, the rail's and the sample document's included.
    #[test]
    fn every_glyph_is_in_the_icon_pack() {
        let fixed = [
            "caretDown",
            "caretRight",
            "close",
            "error",
            "warning",
            "home",
            "undo",
            "redo",
            "primitive",
            "sync",
            "visible",
            "hidden",
            "more",
            "skipStart",
            "stepBack",
            "stepForward",
            "skipEnd",
            "magnet",
            "views",
            "view-reset",
            "view-matcap",
            "view-realtime",
            "view-pathtraced",
            "shaded",
            "camera",
            "versions",
            "history",
            "bug",
        ];
        let doc = Document::sample();
        let from_doc = doc
            .features
            .iter()
            .map(|f| f.glyph)
            .chain(doc.groups.iter().flat_map(|g| std::iter::once(g.glyph).chain(g.items.iter().map(|i| i.glyph))));
        let missing: Vec<_> = fixed
            .into_iter()
            .chain(from_doc)
            .chain(super::rail::glyphs())
            .filter(|g| Assets.load(&format!("icons/forge/{g}.svg")).ok().flatten().is_none())
            .collect();
        assert!(missing.is_empty(), "missing icons: {missing:?}");
    }
}
