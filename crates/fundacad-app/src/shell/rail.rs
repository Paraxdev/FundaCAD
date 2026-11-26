use gpui::prelude::FluentBuilder as _;
use gpui::*;

use crate::theme::{Theme, FS_BODY, FS_MICRO, MONO_FONT, RAIL_TILE, W_SEMIBOLD};
use crate::ui::{chip, icon, text, tile};

const GAP: f32 = 6.;
const SEP: f32 = 4.;

struct Entry {
    glyph: &'static str,
    label: &'static str,
    keys: &'static [&'static str],
    /// A family opens a flyout, marked by a corner triangle.
    family: bool,
    sub: Option<&'static str>,
}

const fn tool(glyph: &'static str, label: &'static str, keys: &'static [&'static str]) -> Entry {
    Entry { glyph, label, keys, family: false, sub: None }
}

const fn family(glyph: &'static str, label: &'static str) -> Entry {
    Entry { glyph, label, keys: &[], family: true, sub: None }
}

const fn toggle(glyph: &'static str, label: &'static str, sub: &'static str) -> Entry {
    Entry { glyph, label, keys: &[], family: false, sub: Some(sub) }
}

const TOP: &[&[Entry]] = &[
    &[tool("search", "Search", &["Ctrl", "F"])],
    &[
        tool("sketch", "Sketch", &["S"]),
        family("primitive", "Create"),
        family("presspull", "Modify"),
        family("datumPlane", "Construct"),
        family("measure", "Inspect"),
        family("import", "Insert"),
        family("filament", "Print"),
    ],
];

const FOOT: &[Entry] =
    &[toggle("isolate", "Isolate", "Off"), toggle("section", "Section View", "Off"), tool("measure", "Measure", &[])];

fn row(t: &Theme, e: &Entry) -> Div {
    let corner = t.text_mute;
    let tile = tile(t, RAIL_TILE).relative().child(icon(e.glyph, 22., t.text)).when(e.family, |d| {
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
    let key = |k: &&'static str| {
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
            .child(*k)
    };
    let pill = chip(t)
        .min_h(px(28.))
        .px(px(9.))
        .py(px(3.))
        .flex()
        .flex_col()
        .justify_center()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).line_height(px(16.)).child(e.label))
                .when(!e.keys.is_empty(), |d| d.child(div().flex().gap(px(3.)).children(e.keys.iter().map(key)))),
        )
        .when_some(e.sub, |d, sub| d.child(text(t, FS_MICRO).line_height(px(13.)).text_color(t.text_mute).child(sub)));
    div().flex().items_center().gap(px(6.)).child(tile).child(pill)
}

pub(super) fn rail(t: &Theme) -> Div {
    let section = |entries: &[Entry]| div().flex().flex_col().gap(px(GAP)).children(entries.iter().map(|e| row(t, e)));
    div()
        .h_full()
        .flex()
        .flex_col()
        .justify_between()
        .child(div().flex().flex_col().gap(px(GAP + SEP + GAP)).children(TOP.iter().map(|s| section(s))))
        .child(section(FOOT))
}
