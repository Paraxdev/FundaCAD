use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Shell;
use crate::theme::{Theme, FS_BODY, FS_MICRO, FS_SMALL, R_SM, S_1, S_2, S_3, S_4, W_BOLD, W_MEDIUM, W_SEMIBOLD};
use crate::ui::{icon, icon_button, text};

/// The lockup's wordmark colours, fixed in the brand SVG rather than themed.
const BRAND_TEXT: u32 = 0xe9eff6;
const BRAND_ACCENT: u32 = 0x4ca5e0;

impl Shell {
    pub(super) fn titlebar(&self, t: &Theme) -> Div {
        let menu = |label: &'static str| {
            let hover = t.raised;
            text(t, FS_BODY)
                .id(label)
                .h(px(20.))
                .px(px(S_4))
                .mx(px(1.))
                .flex()
                .items_center()
                .rounded(px(4.))
                .hover(move |s| s.bg(hover))
                .child(label)
        };
        let doc = &self.doc;
        let docname = format!("{}{}", doc.name, if doc.dirty { "*" } else { "" });

        div()
            .h(px(36.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(S_4))
            .px(px(S_4))
            .bg(t.panel)
            .border_b_1()
            .border_color(t.line)
            .child(
                div()
                    .w(px(113.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(img("brand/fundacad-mark.svg").size(px(22.)))
                    .child(
                        div()
                            .flex()
                            .text_size(px(10.))
                            .font_weight(W_BOLD)
                            .child(div().text_color(rgb(BRAND_TEXT)).child("Funda"))
                            .child(div().text_color(rgb(BRAND_ACCENT)).child("CAD")),
                    ),
            )
            .child(icon_button(t, "home", "home", 24., 15., t.text_dim))
            .child(div().flex().items_center().children(["File", "Edit", "View", "Help"].map(menu)))
            .child(icon_button(t, "undo", "undo", 24., 15., t.text_dim))
            .child(icon_button(t, "redo", "redo", 24., 15., t.text_dim).opacity(0.5))
            .child(
                text(t, FS_MICRO)
                    .font_weight(W_BOLD)
                    // GPUI has no letter-spacing, the CSS .8px across five letters goes into the padding.
                    .px(px(S_3 + 2.))
                    .py(px(S_1))
                    .rounded(px(R_SM))
                    .bg(t.panel_2)
                    .text_color(t.text_dim)
                    .child("SOLID"),
            )
            .child(
                text(t, FS_SMALL)
                    .font_weight(W_MEDIUM)
                    .text_color(if doc.dirty { t.text } else { t.text_mute })
                    .child(docname),
            )
            .child(div().flex_1())
            .child(self.workspace_toggle(t))
    }

    fn workspace_toggle(&self, t: &Theme) -> Div {
        let segment = |glyph: &'static str, label: &'static str, on: bool| {
            text(t, FS_SMALL)
                .h(px(20.))
                .px(px(S_2))
                .flex()
                .items_center()
                .gap(px(S_1))
                .rounded(px(3.))
                .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
                .text_color(if on { t.accent_hot } else { t.text_dim })
                .when(on, |d| d.bg(t.accent_wash))
                .child(icon(glyph, 12., if on { t.accent_hot } else { t.text_dim }))
                .child(label)
        };
        div()
            .flex()
            .gap(px(2.))
            .p(px(1.))
            .rounded(px(4.))
            .bg(t.field_bg)
            .border_1()
            .border_color(t.control_edge)
            .child(segment("primitive", "Model", true))
            .child(segment("sync", "Render", false))
    }
}
