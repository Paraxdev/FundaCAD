use gpui::prelude::FluentBuilder as _;
use gpui::*;

use crate::motion::{self, mix};
use crate::theme::{Rgb, Theme, FS_BODY, FS_MICRO, MONO_FONT, RAIL_TILE, W_SEMIBOLD};
use crate::ui::{chip, icon, text, tile};

pub(super) mod model;

pub(super) const GAP: f32 = 6.;
pub(super) const SEP: f32 = 4.;
pub(super) const COMPACT_TILE: f32 = 32.;
pub(super) const COMPACT_GAP: f32 = 4.;

/// The foot's labels stay English, inspect's foot_act matches on them.
pub(super) fn spoken(label: &str) -> SharedString {
    let key = match label {
        "Isolate" => "rail.isolate",
        "Section View" => "rail.sectionView",
        "Measure" => "tool.measure",
        "Construction" => "rail.construction",
        "Off" => "rail.off",
        "On" => "rail.on",
        other => return SharedString::from(other.to_owned()),
    };
    crate::i18n::t(key).into()
}

/// Whether the Isolate and Section View toggles are on.
#[derive(Clone, Copy, Default)]
pub(super) struct Foot {
    pub isolate: bool,
    pub section: bool,
}

impl Foot {
    /// A toggle's state by its label, None for an entry that is not a toggle.
    pub fn on(self, label: &str) -> Option<bool> {
        match label {
            "Isolate" => Some(self.isolate),
            "Section View" => Some(self.section),
            _ => None,
        }
    }
}

/// FundaCAD 1's RailButton: a glass tile and the pill with its name, keys and sub label.
pub(super) struct Button {
    pub id: SharedString,
    pub glyph: SharedString,
    pub label: SharedString,
    pub sub: Option<SharedString>,
    pub keys: Option<SharedString>,
    /// Active, holding, or its flyout is open.
    pub lit: bool,
    /// Has a flyout, marked by a corner triangle.
    pub menu: bool,
}

pub(super) fn key_chips(t: &Theme, keys: &str) -> Div {
    let parts: Vec<String> = match keys {
        "+" => vec!["+".into()],
        k => k.split('+').filter(|p| !p.is_empty()).map(str::to_owned).collect(),
    };
    div().flex().gap(px(3.)).children(parts.into_iter().map(|k| {
        div()
            .h(px(16.))
            .px(px(4.))
            .rounded(px(4.))
            .bg(t.field_bg)
            .font_family(MONO_FONT)
            .text_size(px(FS_MICRO))
            .line_height(px(16.))
            .font_weight(W_SEMIBOLD)
            .text_color(t.text_dim)
            .child(k)
    }))
}

pub(super) fn button(t: &Theme, b: Button, compact: bool) -> Div {
    let size = if compact { COMPACT_TILE } else { RAIL_TILE };
    let corner = t.text_mute;
    let tile = tile(t, size).relative().child(icon(&b.glyph, 22., if b.lit { t.accent_hot } else { t.text })).when(b.menu, |d| {
        d.child(
            canvas(
                |_, _, _| {},
                move |b, _, window, _| {
                    let (x, y) = (b.origin.x + b.size.width, b.origin.y + b.size.height);
                    let mut path = PathBuilder::fill();
                    path.move_to(point(x, y - px(5.)));
                    path.line_to(point(x, y));
                    path.line_to(point(x - px(5.), y));
                    path.close();
                    if let Ok(path) = path.build() {
                        window.paint_path(path, Hsla::from(corner));
                    }
                },
            )
            .absolute()
            .right(px(5.))
            .bottom(px(5.))
            .size(px(5.)),
        )
    });
    let label_color = if b.lit { t.accent_hot } else { t.text };
    let pill = chip(t)
        .min_h(px(if compact { 24. } else { 28. }))
        .px(px(if compact { 7. } else { 9. }))
        .py(px(if compact { 2. } else { 3. }))
        .flex()
        .flex_col()
        .justify_center()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    text(t, if compact { 12. } else { FS_BODY })
                        .font_weight(W_SEMIBOLD)
                        .line_height(px(16.))
                        .whitespace_nowrap()
                        .text_color(label_color)
                        .child(b.label),
                )
                .when_some(b.keys, |d, k| d.child(key_chips(t, &k))),
        )
        .when_some(b.sub.filter(|_| !compact), |d, sub| {
            d.child(text(t, FS_MICRO).line_height(px(13.)).whitespace_nowrap().text_color(t.text_mute).child(sub))
        });
    div().flex().items_center().gap(px(6.)).child(rail_tile(t, b.id, b.lit, size, tile)).child(pill)
}

/// `.rail-tile`'s transition: the hover wash and a 1px lift, the press shrinks it to 0.94, and the accent wash of an
/// open family or a toggle that is on.
fn rail_tile(t: &Theme, key: SharedString, lit: bool, full: f32, tile: Div) -> impl IntoElement {
    let (rest, accent, wash) = (t.float_tile_bg, t.accent_wash, t.hover_wash);
    let id = ElementId::Name(format!("rail-tile:{key}").into());
    motion::hover(id, tile, move |d, m| {
        let base = Rgb::from(mix(rest, accent, m.on));
        let size = full * (1. - 0.06 * m.press);
        d.bg(mix(base, motion::layer(wash, base), m.hover))
            .size(px(size))
            .m(px((full - size) / 2.))
            .top(px(-m.hover * (1. - m.press)))
    })
    .on(lit)
    .press()
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(super) fn glyphs() -> impl Iterator<Item = &'static str> {
    ["search", "close", "select-all", "offset", "isolate", "section", "measure", "printing/print", "sketch"]
        .into_iter()
        .chain(crate::ribbon::MODEL.iter().map(|g| g.glyph))
}
