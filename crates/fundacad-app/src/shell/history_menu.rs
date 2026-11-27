//! The History right click menu, `.ui-menu` in _menu.scss, and the chip a row drag carries.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::timeline::Entry;
use super::Shell;
use crate::motion::{hover, mix, pop_in};
use crate::theme::{
    ActiveTheme as _, Rgb, Theme, FLOAT_CHIP_RADIUS, FLOAT_TILE_RADIUS, FS_BODY, FS_MICRO, S_1, S_2, S_3, S_4,
};
use crate::ui::{icon, text};

impl Shell {
    pub(super) fn history_menu(&self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.timeline.menu.as_ref()?;
        let entries = super::timeline::menu(&self.timeline.doc, &menu.targets);
        let key = SharedString::from(format!("history-menu-in:{}:{}", f32::from(menu.at.x) as i32, f32::from(menu.at.y) as i32));
        let mut list = div()
            .id("history-menu")
            .min_w(px(168.))
            .p(px(5.))
            .flex()
            .flex_col()
            .rounded(px(FLOAT_TILE_RADIUS))
            // `.ui-menu` blurs what is behind it, an opaque panel stands in for the blur.
            .bg(t.panel)
            .shadow(t.float_shadow.clone())
            .text_size(px(FS_BODY))
            .text_color(t.text)
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.timeline.menu = None;
                cx.notify();
            }));
        for (i, entry) in entries.into_iter().enumerate() {
            list = list.child(match entry {
                Entry::Separator => div().h(px(1.)).my(px(S_1)).mx(px(S_2)).bg(t.line).into_any_element(),
                Entry::Item { act, label, keys, danger } => {
                    let colour = if danger { t.error } else { t.text };
                    let (wash, hot) =
                        if danger { (t.error_tint, t.error) } else { (t.accent.fade(0.16), t.accent_hot) };
                    let targets = menu.targets.clone();
                    text(t, FS_BODY)
                        .id(("history-menu-item", i))
                        .flex()
                        .items_center()
                        .gap(px(S_3))
                        .py(px(S_3))
                        .px(px(S_4))
                        .rounded(px(FLOAT_CHIP_RADIUS))
                        .whitespace_nowrap()
                        .text_color(colour)
                        .child(div().flex_1().child(label))
                        .when(!keys.is_empty(), |d| {
                            d.child(div().pl(px(S_4)).text_size(px(FS_MICRO)).text_color(t.text_dim).child(keys))
                        })
                        .map(|d| match act {
                            Some(act) => hover(("history-menu-lit", i), d, move |d, m| {
                                d.bg(mix(Rgb::TRANSPARENT, wash, m.hover)).text_color(mix(colour, hot, m.hover))
                            })
                            .on_click(cx.listener(move |this, _, window, cx| this.run(act, targets.clone(), window, cx)))
                            .into_any_element(),
                            None => d.opacity(0.45).into_any_element(),
                        })
                }
            });
        }
        Some(
            deferred(anchored().position(menu.at).snap_to_window_with_margin(px(4.)).child(pop_in(key, list)))
                .with_priority(1)
                .into_any_element(),
        )
    }
}

/// The chip under the pointer while a row is dragged.
#[derive(Clone)]
pub(super) struct DragRow {
    pub id: String,
    pub glyph: &'static str,
    pub name: SharedString,
}

impl Render for DragRow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme();
        text(t, FS_BODY)
            .flex()
            .items_center()
            .gap(px(10.))
            .h(px(30.))
            .px(px(S_2))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .bg(t.panel)
            .shadow(t.float_shadow.clone())
            .opacity(0.9)
            .child(icon(self.glyph, 18., t.text))
            .child(self.name.clone())
    }
}
