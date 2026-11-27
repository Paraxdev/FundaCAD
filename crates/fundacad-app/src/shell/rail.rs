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

/// One rail button as FundaCAD 1's RailButton draws it: the tile, then the pill with its label, keys and sub line.
struct Item {
    id: SharedString,
    glyph: &'static str,
    label: SharedString,
    keys: Vec<SharedString>,
    /// A family opens a flyout, marked by a corner triangle.
    family: bool,
    sub: Option<SharedString>,
    sub_on: bool,
    lit: bool,
    /// No handler in this build yet.
    muted: bool,
}

type Act = std::rc::Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(Default)]
struct Acts {
    click: Option<Act>,
    down: Option<Act>,
    menu: Option<Act>,
}

fn row(t: &Theme, e: &'static Entry, open: Option<&str>, on: Option<bool>, on_click: Option<&OnFamily>) -> AnyElement {
    let sub = e.sub.map(|sub| spoken(if on == Some(true) { "On" } else { sub }).into());
    let item = Item {
        id: e.label.into(),
        glyph: e.glyph,
        label: spoken(e.label).into(),
        keys: e.keys.iter().map(|k| SharedString::from(*k)).collect(),
        family: e.family,
        sub,
        sub_on: on == Some(true),
        lit: open == Some(e.label) || on == Some(true),
        muted: false,
    };
    let label = e.label;
    let click = on_click.cloned().map(|f| std::rc::Rc::new(move |w: &mut Window, cx: &mut App| f(label, w, cx)) as Act);
    item_row(t, item, Acts { click, ..Default::default() })
}

fn item_row(t: &Theme, e: Item, acts: Acts) -> AnyElement {
    let corner = t.text_mute;
    let ink = if e.muted { t.text_mute } else { t.text };
    let tile = tile(t, RAIL_TILE).relative().child(icon(e.glyph, 22., ink)).when(e.family, |d| {
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
    let key = |k: SharedString| {
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
                .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).line_height(px(16.)).text_color(ink).child(e.label))
                .when(!e.keys.is_empty(), |d| d.child(div().flex().gap(px(3.)).children(e.keys.into_iter().map(key)))),
        )
        .when_some(e.sub, |d, sub| {
            d.child(text(t, FS_MICRO).line_height(px(13.)).text_color(if e.sub_on { t.accent } else { t.text_mute }).child(sub))
        });
    let row = div().flex().items_center().gap(px(6.)).child(rail_tile(t, e.id.clone(), e.lit, tile)).child(pill);
    if acts.click.is_none() && acts.down.is_none() && acts.menu.is_none() {
        return row.into_any_element();
    }
    // The tile and the pill occlude the view, which would hide the row's own hitbox, so a cover on top takes the click.
    let mut cover = div().id(ElementId::Name(format!("rail:{}", e.id).into())).absolute().inset_0().cursor_pointer();
    if let Some(f) = acts.click {
        cover = cover.on_click(move |_, window, cx| f(window, cx));
    }
    if let Some(f) = acts.down {
        cover = cover.on_mouse_down(MouseButton::Left, move |_, window, cx| f(window, cx));
    }
    if let Some(f) = acts.menu {
        cover = cover.on_mouse_down(MouseButton::Right, move |_, window, cx| {
            cx.stop_propagation();
            f(window, cx)
        });
    }
    row.relative().child(cover).into_any_element()
}

/// `.rail-tile`'s transition: the hover wash and a 1px lift, the press shrinks it to 0.94, and the accent wash of an
/// open family or a toggle that is on.
fn rail_tile(t: &Theme, label: SharedString, lit: bool, tile: Div) -> impl IntoElement {
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

/// What the sketch rail shows: the sketch, its armed tool, each family's face and the open flyout.
pub(super) struct SketchState {
    pub name: String,
    pub active: Option<&'static str>,
    pub construction: bool,
    pub open: Option<&'static str>,
    pub chosen: std::collections::HashMap<&'static str, &'static str>,
    /// Each tool's key as the pill shows it, and whether this build runs it.
    pub keys: std::collections::HashMap<&'static str, Vec<SharedString>>,
    pub built: std::collections::HashSet<&'static str>,
    /// Where each family's row was last drawn, for its flyout.
    pub anchors: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<&'static str, Bounds<Pixels>>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SketchAct {
    Exit,
    Run(&'static str),
    /// The left button went down on a family, holding it opens the flyout.
    Press(&'static str),
    /// A family clicked: its face runs unless the hold opened the flyout.
    Face(&'static str),
    Menu(&'static str),
    /// A flyout row: the family and the variant picked.
    Pick(&'static str, &'static str),
    Construction,
}

pub(super) type OnSketch = std::rc::Rc<dyn Fn(SketchAct, &mut Window, &mut App)>;

fn act(on: &OnSketch, a: SketchAct) -> Option<Act> {
    let on = on.clone();
    Some(std::rc::Rc::new(move |w: &mut Window, cx: &mut App| on(a, w, cx)))
}

fn tool_item(s: &SketchState, tool: sketch::Tool, lit: bool) -> Item {
    Item {
        id: tool.action.into(),
        glyph: tool.glyph,
        label: crate::i18n::t(tool.label).into(),
        keys: s.keys.get(tool.action).cloned().unwrap_or_default(),
        family: false,
        sub: None,
        sub_on: false,
        lit,
        muted: !s.built.contains(tool.action),
    }
}

/// FundaCAD 1's rail in sketch mode: Search and Exit Sketching, then the drawing tools, Construction at the foot.
pub(super) fn sketch_rail(t: &Theme, s: &SketchState, on: OnSketch) -> Div {
    let exit = Item {
        id: "exit-sketching".into(),
        glyph: "close",
        label: crate::i18n::t("rail.exitSketching").into(),
        keys: Vec::new(),
        family: false,
        sub: Some(s.name.clone().into()),
        sub_on: false,
        lit: false,
        muted: false,
    };
    let head = div()
        .flex()
        .flex_col()
        .gap(px(GAP))
        .child(row(t, &TOP[0][0], None, None, None))
        .child(item_row(t, exit, Acts { click: act(&on, SketchAct::Exit), ..Default::default() }));
    let slots = sketch::SLOTS.iter().map(|slot| match *slot {
        sketch::Slot::Tool(tool) => {
            item_row(t, tool_item(s, tool, s.active == Some(tool.action)), Acts { click: act(&on, SketchAct::Run(tool.action)), ..Default::default() })
        }
        sketch::Slot::Family { id, label, items } => {
            let face = sketch::face_of(items, s.chosen.get(id).copied());
            let face_label = crate::i18n::t(face.label);
            let family_label = crate::i18n::t(label);
            let lit = items.iter().any(|i| s.active == Some(i.action)) || s.open == Some(id);
            let item = Item {
                id: format!("fam:{id}").into(),
                family: true,
                label: family_label.clone().into(),
                sub: (face_label != family_label).then(|| face_label.into()),
                ..tool_item(s, face, lit)
            };
            let anchors = s.anchors.clone();
            let el = item_row(
                t,
                item,
                Acts { click: act(&on, SketchAct::Face(id)), down: act(&on, SketchAct::Press(id)), menu: act(&on, SketchAct::Menu(id)) },
            );
            div()
                .relative()
                .child(el)
                .child(
                    canvas(move |b, _, _| {
                        anchors.borrow_mut().insert(id, b);
                    }, |_, _, _, _| {})
                    .absolute()
                    .inset_0(),
                )
                .into_any_element()
        }
    });
    let construction = Item {
        id: "construction".into(),
        glyph: "offset",
        label: crate::i18n::t("rail.construction").into(),
        keys: Vec::new(),
        family: false,
        sub: Some(crate::i18n::t(if s.construction { "rail.on" } else { "rail.off" }).into()),
        sub_on: s.construction,
        lit: s.construction,
        muted: false,
    };
    div()
        .h_full()
        .flex()
        .flex_col()
        .justify_between()
        .gap(px(GAP + SEP + GAP))
        .child(
            div()
                .id("sketch-rail")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(GAP + SEP + GAP))
                .child(head)
                .child(div().flex().flex_col().gap(px(GAP)).children(slots)),
        )
        .child(item_row(t, construction, Acts { click: act(&on, SketchAct::Construction), ..Default::default() }))
}

/// A family's variants beside its row, as FundaCAD 1's rail flyout: each a rail button, the armed one lit.
pub(super) fn sketch_flyout(t: &Theme, s: &SketchState, on: OnSketch) -> Option<AnyElement> {
    let id = s.open?;
    let (_, items) = sketch::family(id)?;
    let at = *s.anchors.borrow().get(id)?;
    let rows = items.iter().enumerate().map(|(i, tool)| {
        let el = item_row(t, tool_item(s, *tool, s.active == Some(tool.action)), Acts { click: act(&on, SketchAct::Pick(id, tool.action)), ..Default::default() });
        let key = ElementId::Name(format!("rail-flyout-in:{}", tool.action).into());
        motion::glass_in_after(key, crate::theme::T_STAGGER * i as u32, div().child(el)).into_any_element()
    });
    let list = div().id("rail-flyout").flex().flex_col().flex_wrap().max_h(px(560.)).gap(px(GAP)).occlude().children(rows);
    let at = point(at.origin.x + at.size.width + px(GAP), at.origin.y);
    Some(deferred(anchored().position(at).snap_to_window_with_margin(px(4.)).child(list)).into_any_element())
}

#[cfg(test)]
pub(super) fn glyphs() -> impl Iterator<Item = &'static str> {
    TOP.iter().flat_map(|s| s.iter()).chain(FOOT).map(|e| e.glyph).chain(sketch::tools().map(|t| t.glyph)).chain(["close", "offset"])
}

mod sketch;
pub(super) use sketch::{face_of, family as sketch_family, family_of};

pub(super) fn sketch_actions() -> impl Iterator<Item = &'static str> {
    sketch::tools().map(|t| t.action)
}

#[cfg(test)]
mod sketch_tests;
#[cfg(test)]
mod tests;
