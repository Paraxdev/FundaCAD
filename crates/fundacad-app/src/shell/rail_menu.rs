//! The flyout a rail family opens, the ribbon group's tools as FundaCAD 1's ribbon dropdown: a heading per split
//! family, each tool with its icon and key, greyed while this build has no handler for it.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Shell;
use crate::ribbon::{self, Item, ToolItem};
use crate::motion::{glass_in_after, hover_bg, pop_in};
use crate::theme::{Rgb, Theme, T_STAGGER, FLOAT_CHIP_RADIUS, FS_MICRO, FS_SMALL, MONO_FONT, S_0, S_1, S_2, W_SEMIBOLD};
use crate::ui::{chip, icon, text};

impl Shell {
    pub(super) fn toggle_family(&mut self, label: &'static str, cx: &mut Context<Self>) {
        self.rail_open = if self.rail_open == Some(label) { None } else { Some(label) };
        cx.notify();
    }

    fn tool_row(&self, t: &Theme, item: ToolItem, i: usize, cx: &mut Context<Self>) -> AnyElement {
        let built = crate::commands::available(cx).iter().any(|c| c.id == item.action);
        let key = crate::commands::hint(cx, item.action);
        let hover = t.hover_wash;
        let color = if built { t.text } else { t.text_mute };
        let row = div()
            .id(ElementId::Name(format!("rail-tool:{}", item.action).into()))
            .flex()
            .items_center()
            .gap(px(S_2))
            .px(px(S_2))
            .py(px(S_1))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .cursor_pointer()
            .child(icon(item.glyph, 16., color).flex_none())
            .child(text(t, FS_SMALL).flex_1().text_color(color).child(crate::i18n::t(item.label)))
            .when_some(key, |d, k| {
                d.child(
                    div()
                        .px(px(4.))
                        .rounded(px(4.))
                        .bg(t.field_bg)
                        .font_family(MONO_FONT)
                        .text_size(px(FS_MICRO))
                        .font_weight(W_SEMIBOLD)
                        .text_color(t.text_dim)
                        .child(k),
                )
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.rail_open = None;
                cx.notify();
                crate::commands::run(item.action, window, cx);
            }));
        let id = ElementId::Name(format!("rail-tool-in:{}", item.action).into());
        let row = hover_bg(ElementId::Name(format!("rail-tool-bg:{}", item.action).into()), row, Rgb::TRANSPARENT, hover);
        glass_in_after(id, T_STAGGER * i as u32, div().child(row)).into_any_element()
    }

    /// The open family's tools, None while none is open or the family has no ribbon group.
    pub(super) fn rail_menu(&self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let family = self.rail_open?;
        let group = ribbon::group(family)?;
        let mut n = 0;
        let mut next = || {
            n += 1;
            n - 1
        };
        let mut rows: Vec<AnyElement> = Vec::new();
        for item in group.items {
            match item {
                Item::Tool(tool) => rows.push(self.tool_row(t, *tool, next(), cx)),
                Item::Split { label, children } => {
                    rows.push(
                        text(t, FS_MICRO)
                            .px(px(S_2))
                            .pt(px(S_2))
                            .font_weight(W_SEMIBOLD)
                            .text_color(t.text_mute)
                            .child(crate::i18n::t(label).to_uppercase())
                            .into_any_element(),
                    );
                    rows.extend(children.iter().map(|c| self.tool_row(t, *c, next(), cx)));
                }
            }
        }
        let card = chip(t)
                .id("rail-menu")
                .w(px(230.))
                .max_h(px(560.))
                .overflow_y_scroll()
                .p(px(S_1))
                .flex()
                .flex_col()
                .gap(px(S_0))
                .occlude()
                .child(
                    text(t, FS_SMALL).px(px(S_2)).py(px(S_1)).font_weight(W_SEMIBOLD).child(crate::i18n::t(group.heading).to_uppercase()),
                )
                .children(rows);
        Some(pop_in(ElementId::Name(format!("rail-menu-in:{family}").into()), card).into_any_element())
    }
}
