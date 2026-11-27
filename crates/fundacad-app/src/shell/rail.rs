use gpui::prelude::FluentBuilder as _;
use gpui::*;

use crate::motion::{self, mix};
use crate::theme::{Rgb, Theme, FS_BODY, FS_MICRO, MONO_FONT, RAIL_TILE, W_SEMIBOLD};
use crate::ui::{chip, icon, text, tile};

const GAP: f32 = 6.;
const SEP: f32 = 4.;

/// The labels stay English, the family callback matches on them.
fn spoken(label: &str) -> String {
    let key = match label {
        "Search" => "rail.search",
        "Sketch" => "tool.sketch",
        "Create" => "tool.group.create",
        "Modify" => "tool.group.modify",
        "Construct" => "tool.group.construct",
        "Inspect" => "tool.group.inspect",
        "Insert" => "tool.group.insert",
        "Print" => "rail.print",
        "Isolate" => "rail.isolate",
        "Section View" => "rail.sectionView",
        "Measure" => "tool.measure",
        "Off" => "rail.off",
        "On" => "rail.on",
        other => return other.to_owned(),
    };
    crate::i18n::t(key)
}

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
        // A plugin group shows its first tool's icon, FundaCAD.Printing's print.
        family("printing/print", "Print"),
    ],
];

const FOOT: &[Entry] =
    &[toggle("isolate", "Isolate", "Off"), toggle("section", "Section View", "Off"), tool("measure", "Measure", &[])];

type OnFamily = std::rc::Rc<dyn Fn(&'static str, &mut Window, &mut App)>;

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

fn row(t: &Theme, e: &'static Entry, open: Option<&str>, on: Option<bool>, on_click: Option<&OnFamily>) -> AnyElement {
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
                .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).line_height(px(16.)).child(spoken(e.label)))
                .when(!e.keys.is_empty(), |d| d.child(div().flex().gap(px(3.)).children(e.keys.iter().map(key)))),
        )
        .when_some(e.sub, |d, sub| {
            let sub = if on == Some(true) { "On" } else { sub };
            d.child(text(t, FS_MICRO).line_height(px(13.)).text_color(if on == Some(true) { t.accent } else { t.text_mute }).child(spoken(sub)))
        });
    let lit = open == Some(e.label) || on == Some(true);
    let row = div().flex().items_center().gap(px(6.)).child(rail_tile(t, e.label, lit, tile)).child(pill);
    let Some(f) = on_click.cloned() else { return row.into_any_element() };
    let label = e.label;
    // The tile and the pill occlude the view, which would hide the row's own hitbox, so a cover on top takes the click.
    let cover = div()
        .id(ElementId::Name(format!("rail:{label}").into()))
        .absolute()
        .inset_0()
        .cursor_pointer()
        .on_click(move |_, window, cx| f(label, window, cx));
    row.relative().child(cover).into_any_element()
}

/// `.rail-tile`'s transition: the hover wash and a 1px lift, the press shrinks it to 0.94, and the accent wash of an
/// open family or a toggle that is on.
fn rail_tile(t: &Theme, label: &'static str, lit: bool, tile: Div) -> impl IntoElement {
    let (rest, accent, wash) = (t.float_tile_bg, t.accent_wash, t.hover_wash);
    let id = ElementId::Name(format!("rail-tile:{label}").into());
    motion::hover(id, tile, move |d, m| {
        let base = Rgb::from(mix(rest, accent, m.on));
        let size = RAIL_TILE * (1. - 0.06 * m.press);
        d.bg(mix(base, motion::layer(wash, base), m.hover))
            .size(px(size))
            .m(px((RAIL_TILE - size) / 2.))
            .top(px(-m.hover * (1. - m.press)))
    })
    .on(lit)
    .press()
}

/// `on_family` gets a family's label, `on_tool` a foot entry's label.
pub(super) fn rail(t: &Theme, open: Option<&str>, foot: Foot, on_family: OnFamily, on_tool: OnFamily) -> Div {
    let section = |entries: &'static [Entry], is_foot: bool| {
        div().flex().flex_col().gap(px(GAP)).children(entries.iter().map(|e| {
            let on = foot.on(e.label);
            let click = if is_foot { Some(&on_tool) } else { e.family.then_some(&on_family) };
            row(t, e, open, on, click)
        }))
    };
    div()
        .h_full()
        .flex()
        .flex_col()
        .justify_between()
        .child(div().flex().flex_col().gap(px(GAP + SEP + GAP)).children(TOP.iter().map(|s| section(s, false))))
        .child(section(FOOT, true))
}

#[cfg(test)]
pub(super) fn glyphs() -> impl Iterator<Item = &'static str> {
    TOP.iter().flat_map(|s| s.iter()).chain(FOOT).map(|e| e.glyph)
}

#[cfg(test)]
mod tests;
