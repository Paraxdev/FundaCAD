use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Shell;
use crate::theme::{Theme, FLOAT_CHIP_RADIUS, FS_BODY, FS_MICRO, R_PILL, S_1, S_2, W_SEMIBOLD};
use crate::ui::{float_card, icon, icon_button, text};

pub(super) const WIDTH: f32 = 264.;
const ROW: f32 = 33.;

/// The head every float card shares: a title and a close button.
pub(super) fn card_head(t: &Theme, title: &'static str) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(S_2))
        .pt(px(10.))
        .pr(px(10.))
        .pb(px(6.))
        .pl(px(14.))
        .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).child(title))
        .child(icon_button(t, SharedString::from(format!("{title}-close")), "close", 28., 14., t.text_mute))
}

impl Shell {
    pub(super) fn items_card(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let tab = |i: usize, label: &'static str, cx: &mut Context<Self>| {
            let on = self.items_tab == i;
            text(t, FS_BODY)
                .id(label)
                .font_weight(W_SEMIBOLD)
                .pt(px(S_1))
                .px(px(S_2))
                .pb(px(6.))
                .text_color(if on { t.text } else { t.text_dim })
                .when(on, |d| d.border_b_2().border_color(t.accent))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.items_tab = i;
                    cx.notify();
                }))
                .child(label)
        };
        let filter = text(t, 11.)
            .font_weight(W_SEMIBOLD)
            .mx(px(14.))
            .mt(px(S_2))
            .h(px(30.))
            .px(px(11.))
            .flex()
            .items_center()
            .justify_between()
            .rounded(px(FLOAT_CHIP_RADIUS))
            .bg(t.field_bg)
            .border_1()
            .border_color(t.control_edge)
            .child("All items")
            .child(icon("caretRight", 10., t.text_dim));

        let groups = self.doc.groups.iter().map(|g| {
            let head = div()
                .h(px(ROW))
                .flex()
                .items_center()
                .pl(px(6.))
                .pr(px(8.))
                .gap(px(8.))
                .child(icon("caretDown", 12., t.text_mute))
                .child(icon(g.glyph, 14., t.text_dim))
                .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).flex_1().min_w_0().truncate().child(g.name.clone()))
                .child(
                    text(t, FS_MICRO)
                        .font_weight(W_SEMIBOLD)
                        .min_w(px(20.))
                        .h(px(16.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(R_PILL))
                        .bg(t.raised)
                        .text_color(t.text_dim)
                        .child(g.items.len().to_string()),
                );
            let rows = g.items.iter().map(|it| {
                div()
                    .h(px(ROW))
                    .flex()
                    .items_center()
                    .pl(px(45.))
                    .pr(px(16.))
                    .gap(px(10.))
                    .rounded(px(FLOAT_CHIP_RADIUS))
                    .child(icon(it.glyph, 14., t.text_dim))
                    .child(text(t, FS_BODY).flex_1().min_w_0().truncate().text_color(t.text_dim).child(it.name.clone()))
                    .child(icon(if it.visible { "visible" } else { "hidden" }, 14., t.text_mute))
            });
            div().flex_none().flex().flex_col().child(head).children(rows)
        });

        float_card(t)
            .w(px(WIDTH))
            .h_full()
            .child(card_head(t, "Items"))
            .child(div().flex().pl(px(5.)).child(tab(0, "Items", cx)).child(tab(1, "Geometry", cx)))
            .child(filter)
            .child(
                div()
                    .id("items-groups")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .pt(px(14.))
                    .px(px(S_2))
                    .flex()
                    .flex_col()
                    .children(groups),
            )
            .child(div().flex().justify_end().p(px(S_2)).child(icon_button(
                t,
                "items-more",
                "more",
                24.,
                15.,
                t.text_mute,
            )))
    }
}
