//! FundaCAD 1's Sketch Palette (components/shell/SketchPalette.vue) with its Options switches and the Relations list.
//! The rail's sketch mode lives in rail_menu.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Shell;
use crate::i18n::tr;
use crate::motion::{self, hover_bg, mix};
use crate::sketch::palette::TOGGLES;
use crate::sketch::relations::{Row, State};
use crate::theme::{Rgb, Theme, FS_SMALL, R_LG, R_MD, R_SM, S_2, S_3, S_4, W_SEMIBOLD};
use crate::ui::{icon, text};

impl Shell {
    /// The Sketch Palette, None while not sketching.
    pub(super) fn sketch_palette(&self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let v = self.viewport.read(cx);
        let (_, _, construction) = v.sketch_rail()?;
        let palette = v.sketch_palette();
        let (summary, conflict, rows) = v.sketch_relations()?;
        let viewport = self.viewport.clone();

        let title = div()
            .flex()
            .items_center()
            .gap(px(S_2))
            .mb(px(S_3))
            .text_size(px(10.))
            .font_weight(FontWeight::BOLD)
            .text_color(t.text_dim)
            .child(div().size(px(6.)).rounded(px(2.)).bg(t.accent))
            .child(t_upper("sketchPalette.title"));
        let section = |key: &str, gap: bool| {
            div()
                .when(gap, |d| d.mt(px(S_4)))
                .pb(px(S_2))
                .mb(px(S_3))
                .border_b_1()
                .border_color(t.line)
                .text_size(px(10.))
                .font_weight(W_SEMIBOLD)
                .text_color(t.text_mute)
                .child(t_upper(key))
        };
        let v2 = viewport.clone();
        let look = div()
            .id("palette-look-at")
            .w_full()
            .mb(px(S_3))
            .py(px(6.))
            .flex()
            .justify_center()
            .rounded(px(R_MD))
            .border_1()
            .border_color(t.control_edge)
            .cursor_pointer()
            .text_size(px(FS_SMALL))
            .font_weight(FontWeight(550.))
            .text_color(t.text)
            .child(crate::i18n::t("sketchPalette.lookAt"))
            .on_click(move |_, _, cx| v2.update(cx, |v, cx| v.sketch_look_at(cx)));
        let look = hover_bg("palette-look-at-bg", look, t.raised_2, t.raised);
        let toggles = TOGGLES.iter().map(|(toggle, key)| {
            let on = palette.get(*toggle).unwrap_or(construction);
            let (toggle, v) = (*toggle, viewport.clone());
            let id = ElementId::Name(format!("palette:{key}").into());
            let row = div()
                .id(id.clone())
                .flex()
                .items_center()
                .justify_between()
                .px(px(S_3))
                .py(px(S_2))
                .mx(px(-S_3))
                .rounded(px(R_SM))
                .cursor_pointer()
                .text_size(px(12.5))
                .text_color(t.text)
                .child(crate::i18n::t(key))
                .child(check(t, (id.clone(), "mark"), on))
                .on_click(move |_, _, cx| v.update(cx, |v, cx| v.set_sketch_toggle(toggle, !on, cx)));
            hover_bg((id, "bg"), row, Rgb::TRANSPARENT, t.raised)
        });
        let mut card = div()
            .id("sketch-palette")
            .w(px(204.))
            .flex()
            .flex_col()
            .p(px(S_4))
            .bg(t.panel)
            .border_1()
            .border_color(t.line_strong)
            .rounded(px(R_LG))
            .shadow(t.shadow_3.clone())
            .occlude()
            .child(title)
            .child(section("sketchPalette.options", false))
            .child(look)
            .children(toggles);
        if palette.constraints {
            card = card.child(section("sketchPalette.relations", true)).child(
                div()
                    .mb(px(S_2))
                    .text_size(px(11.5))
                    .font_weight(W_SEMIBOLD)
                    .text_color(if conflict { t.error } else { t.text_dim })
                    .child(summary),
            );
            card = if rows.is_empty() {
                card.child(text(t, 11.).line_height(rems(1.45)).text_color(t.text_mute).child(crate::i18n::t("sketchPalette.rel.empty")))
            } else {
                card.child(
                    div()
                        .id("palette-relations")
                        .mx(px(-S_3))
                        .max_h(px(216.))
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .children(rows.into_iter().enumerate().map(|(i, r)| relation(t, i, r, &viewport))),
                )
            };
        }
        let card = motion::glass_in("sketch-palette-in", card);
        Some(div().w_full().flex().justify_end().child(card).into_any_element())
    }
}

fn t_upper(key: &str) -> String {
    crate::i18n::t(key).to_uppercase()
}

/// `.palette-switch`: a 15px checkbox in the accent.
fn check(t: &Theme, id: impl Into<ElementId>, on: bool) -> impl IntoElement {
    let (edge, accent, ink) = (t.control_edge, t.accent, t.on_accent);
    let mark = div().size(px(15.)).flex_none().flex().items_center().justify_center().rounded(px(R_SM)).border_1();
    motion::toggle(id, on, mark, move |d, m| {
        d.bg(mix(Rgb::TRANSPARENT, accent, m.on))
            .border_color(mix(edge, accent, m.on))
            .when(m.on > 0., |d| d.child(icon("check", 11. * (0.6 + 0.4 * m.on), ink).opacity(m.on)))
    })
}

fn relation(t: &Theme, i: usize, r: Row, viewport: &Entity<crate::viewport::Viewport>) -> AnyElement {
    let implied = r.implied();
    let ring = match r.state {
        Some(State::Conflict) => t.error,
        Some(State::Over) => t.warn,
        None if implied => t.text_mute,
        None => t.accent,
    };
    let glyph = match r.state {
        Some(State::Conflict) => mix(t.error, t.text, 0.4),
        Some(State::Over) => mix(t.warn, t.text, 0.4),
        None => ring.into(),
    };
    let sym = div()
        .size(px(16.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .border_1()
        .border_color(ring)
        .when(implied, |d| d.border_dashed())
        .rounded(px(R_SM))
        .child(icon(r.icon, 12., glyph));
    let detail = if implied { tr!("sketchPalette.rel.impliedDetail", detail = r.detail.clone()) } else { r.detail.clone() };
    let head = div()
        .flex()
        .items_baseline()
        .gap(px(S_2))
        .min_w_0()
        .child(text(t, 12.).truncate().text_color(if implied { t.text_dim } else { t.text }).child(r.name.clone()))
        .when_some(r.value.clone(), |d, v| d.child(text(t, 11.5).flex_none().text_color(t.text_dim).child(v)));
    let words = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .child(head)
        .child(text(t, 10.5).truncate().text_color(t.text_mute).child(detail));
    let group: SharedString = format!("rel-row-{i}").into();
    let (lit, v1, v2, v3) = (r.entities.clone(), viewport.clone(), viewport.clone(), viewport.clone());
    let first = r.entities.first().cloned();
    let row = div()
        .id(ElementId::Name(format!("rel:{i}").into()))
        .group(group.clone())
        .flex()
        .items_center()
        .gap(px(S_2))
        .px(px(S_3))
        .py(px(S_2))
        .rounded(px(R_SM))
        .cursor_pointer()
        .child(sym)
        .child(words)
        .when_some(r.index, |d, index| {
            d.child(
                div()
                    .id(ElementId::Name(format!("rel-del:{i}").into()))
                    .size(px(18.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .opacity(0.)
                    .group_hover(group.clone(), |s| s.opacity(1.))
                    .child(icon("close", 12., t.text_mute))
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        v3.update(cx, |v, cx| v.delete_sketch_constraint(index, cx));
                    }),
            )
        })
        .on_hover(move |on, _, cx| {
            let ids = lit.clone();
            v1.update(cx, |v, cx| v.light_sketch_shapes(ids, *on, cx));
        })
        .on_click(move |_, _, cx| {
            let id = first.clone();
            v2.update(cx, |v, cx| v.select_sketch_shape(id, cx));
        });
    hover_bg(ElementId::Name(format!("rel-bg:{i}").into()), row, Rgb::TRANSPARENT, t.raised).into_any_element()
}
