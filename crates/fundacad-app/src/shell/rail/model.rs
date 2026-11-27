//! What the rail shows and how a family answers a press, FundaCAD 1's ui/railDefs.ts, ui/holdGesture.ts,
//! ui/selectionTools.ts and the mode switch of ToolRail.vue, kept apart from drawing so it can be tested.

use std::time::Duration;

use gpui::SharedString;

use crate::ribbon::{self, Item, ToolItem};
use crate::selection::{PickKind, Selection};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Model,
    Selection,
    Sketch,
    /// A modelling tool holds the screen and the rail steps back to it.
    Running,
}

pub fn mode(sketching: bool, running: bool, selected: bool) -> Mode {
    match (sketching, running, selected) {
        (true, _, _) => Mode::Sketch,
        (_, true, _) => Mode::Running,
        (_, _, true) => Mode::Selection,
        _ => Mode::Model,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    pub action: SharedString,
    pub label: SharedString,
    pub glyph: SharedString,
    pub keys: Option<SharedString>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    /// Runs the variant on its face and remembers the last one picked, a hold or right click shows the rest.
    Variants,
    /// Only opens its flyout.
    Category,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Family {
    pub id: SharedString,
    pub label: SharedString,
    pub glyph: SharedString,
    pub style: Style,
    pub items: Vec<Entry>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Tool(Tool),
    Family(Family),
}

impl Entry {
    pub fn key(&self) -> &SharedString {
        match self {
            Entry::Tool(t) => &t.action,
            Entry::Family(f) => &f.id,
        }
    }
}

pub type Hint<'a> = &'a dyn Fn(&str) -> Option<SharedString>;

pub fn tool(t: &ToolItem, hint: Hint) -> Tool {
    Tool {
        action: t.action.into(),
        label: crate::i18n::t(t.label).into(),
        glyph: t.glyph.into(),
        keys: hint(t.action),
    }
}

fn variants(id: &str, label: &str, glyph: &str, children: &[ToolItem], hint: Hint) -> Family {
    Family {
        id: format!("fam:{id}").into(),
        label: crate::i18n::t(label).into(),
        glyph: glyph.into(),
        style: Style::Variants,
        items: children.iter().map(|c| Entry::Tool(tool(c, hint))).collect(),
    }
}

/// The model rail with nothing selected: Sketch on its own, then each ribbon group as a category of its tools, a split
/// family flattened and a kept family as one variants tile.
pub fn model_rail(hint: Hint) -> Vec<Entry> {
    let mut out = Vec::new();
    for g in ribbon::MODEL {
        let mut items = Vec::new();
        for item in g.items {
            match item {
                Item::Tool(t) if t.action == "sketch" => out.push(Entry::Tool(tool(t, hint))),
                Item::Tool(t) => items.push(Entry::Tool(tool(t, hint))),
                Item::Split { children, .. } => items.extend(children.iter().map(|c| Entry::Tool(tool(c, hint)))),
                Item::Family { id, label, glyph, children } => {
                    items.push(Entry::Family(variants(id, label, glyph, children, hint)))
                }
            }
        }
        if items.is_empty() {
            continue;
        }
        out.push(Entry::Family(Family {
            id: g.label.into(),
            label: crate::i18n::t(g.heading).into(),
            glyph: g.glyph.into(),
            style: Style::Category,
            items,
        }));
    }
    out
}

/// The drawing tools inside a sketch. The sketch lane fills this, the rail already switches to it, keeps each
/// family's chosen variant and answers holds on it.
pub fn sketch_rail(_hint: Hint) -> Vec<Entry> {
    Vec::new()
}

/// The variant a family's face runs: the one last picked, else the first.
pub fn face_of<'a>(f: &'a Family, chosen: Option<&str>) -> Option<&'a Tool> {
    let tools = || f.items.iter().filter_map(|e| if let Entry::Tool(t) = e { Some(t) } else { None });
    chosen.and_then(|c| tools().find(|t| t.action == c)).or_else(|| tools().next())
}

/// A family by id, also one kept inside a category.
pub fn find<'a>(entries: &'a [Entry], id: &str) -> Option<&'a Family> {
    entries.iter().find_map(|e| match e {
        Entry::Family(f) if f.id == id => Some(f),
        Entry::Family(f) => find(&f.items, id),
        Entry::Tool(_) => None,
    })
}

/// The family a tool belongs to, so arming it from a key puts it on the face.
pub fn family_of<'a>(entries: &'a [Entry], action: &str) -> Option<&'a Family> {
    entries.iter().find_map(|e| match e {
        Entry::Family(f) if f.style == Style::Variants && f.items.iter().any(|i| i.key() == action) => Some(f),
        Entry::Family(f) => family_of(&f.items, action),
        Entry::Tool(_) => None,
    })
}

/// Rows per flyout column: a list taller than the window wraps into columns.
pub fn flyout_rows(n: usize, window_h: f32) -> usize {
    const ROW: f32 = 46.;
    let fit = ((window_h - 64.) / ROW).floor().max(0.) as usize;
    n.min(fit).max(1)
}

/// A click (about 80 to 150 ms) never trips it, the touch convention of about 500 ms is too slow for a toolbar.
pub const HOLD: Duration = Duration::from_millis(300);

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Hold {
    #[default]
    Idle,
    Pressing { group: SharedString, variants: bool },
    /// Reached by holding, or straight away from a right click.
    Open { group: SharedString },
}

#[derive(Clone, Debug, PartialEq)]
pub enum HoldEvent {
    Press { group: SharedString, variants: bool },
    Hold,
    /// `over` is the flyout row under the pointer, as (group, action).
    Release { over: Option<(SharedString, SharedString)> },
    ContextMenu { group: SharedString, variants: bool },
    Cancel,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    None,
    Open(SharedString),
    Close,
    /// Leaves the default alone: a click is a use of it, not a vote for it.
    RunDefault(SharedString),
    /// Runs this variant and makes it the family's new face.
    Pick { group: SharedString, action: SharedString },
}

impl Hold {
    pub fn group(&self) -> Option<&SharedString> {
        match self {
            Hold::Idle => None,
            Hold::Pressing { group, .. } | Hold::Open { group } => Some(group),
        }
    }
}

/// Total: every event is legal in every phase, a release can come with no press after a drag out of the window and a
/// timer can fire into a phase that moved on.
pub fn hold_step(state: &Hold, ev: HoldEvent) -> (Hold, Effect) {
    match ev {
        HoldEvent::Press { group, variants } => match state {
            // On the owning button a press only dismisses, on another it also starts.
            Hold::Open { group: open } if *open == group => (Hold::Idle, Effect::Close),
            Hold::Open { .. } => (Hold::Pressing { group, variants }, Effect::Close),
            _ => (Hold::Pressing { group, variants }, Effect::None),
        },
        HoldEvent::Hold => match state {
            Hold::Pressing { group, variants: true } => (Hold::Open { group: group.clone() }, Effect::Open(group.clone())),
            _ => (state.clone(), Effect::None),
        },
        HoldEvent::Release { over } => match state {
            Hold::Pressing { group, .. } => (Hold::Idle, Effect::RunDefault(group.clone())),
            Hold::Open { group } => match over {
                Some((g, action)) if g == *group => (Hold::Idle, Effect::Pick { group: g, action }),
                _ => (Hold::Idle, Effect::Close),
            },
            Hold::Idle => (Hold::Idle, Effect::None),
        },
        HoldEvent::ContextMenu { group, variants } => match variants {
            false => (Hold::Idle, if matches!(state, Hold::Open { .. }) { Effect::Close } else { Effect::None }),
            true => (Hold::Open { group: group.clone() }, Effect::Open(group)),
        },
        HoldEvent::Cancel => (Hold::Idle, if matches!(state, Hold::Open { .. }) { Effect::Close } else { Effect::None }),
    }
}

/// What a selection is made of, by the kinds the tools consume.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub edge: usize,
    pub area: usize,
    pub face: usize,
    pub body: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Edge,
    Area,
    Face,
    Body,
}

/// Bodies come last, not never, so a two body selection still offers the booleans.
const RANK: [Kind; 4] = [Kind::Edge, Kind::Area, Kind::Face, Kind::Body];

impl Counts {
    pub fn of(sel: &Selection) -> Self {
        let n = |k| sel.of(k).len();
        Counts { edge: n(PickKind::Edge), area: n(PickKind::Area), face: n(PickKind::Face), body: n(PickKind::Body) }
    }

    pub fn get(self, k: Kind) -> usize {
        match k {
            Kind::Edge => self.edge,
            Kind::Area => self.area,
            Kind::Face => self.face,
            Kind::Body => self.body,
        }
    }

    pub fn primary(self) -> Option<(Kind, usize)> {
        RANK.into_iter().map(|k| (k, self.get(k))).find(|(_, n)| *n > 0)
    }
}

/// FundaCAD 1's TOOL_CAPABILITIES rows whose source is the selection, in their preference order: the kinds a tool
/// consumes and the count it needs. Delete Face is left off, it stays on Del and the context menu.
const CAPS: &[(&str, &[Kind], usize)] = &[
    ("fillet", &[Kind::Edge, Kind::Face], 1),
    ("chamfer", &[Kind::Edge, Kind::Face], 1),
    ("presspull", &[Kind::Face], 1),
    ("extrude", &[Kind::Area, Kind::Face], 1),
    ("revolve", &[Kind::Area], 1),
    ("sweep", &[Kind::Area], 1),
    ("loft", &[Kind::Area], 2),
    ("move", &[Kind::Body, Kind::Area], 1),
    ("pattern-linear", &[Kind::Body, Kind::Face], 1),
    ("pattern-circular", &[Kind::Body, Kind::Face], 1),
    ("mirror", &[Kind::Body], 1),
    ("boolean-union", &[Kind::Body], 2),
    ("boolean-subtract", &[Kind::Body], 2),
    ("boolean-intersect", &[Kind::Body], 2),
    ("shell", &[Kind::Face], 1),
    ("draft", &[Kind::Face], 1),
    ("offset-face", &[Kind::Face], 1),
    ("hole", &[Kind::Face], 1),
];

/// The tools the selection's winning kind feeds and has enough of. A body selection also offers Fillet and Chamfer,
/// which then ask for an edge.
pub fn offers(c: Counts) -> Vec<&'static str> {
    let Some((kind, _)) = c.primary() else { return Vec::new() };
    let live = CAPS
        .iter()
        .filter(|(_, consumes, min)| consumes.contains(&kind) && consumes.iter().any(|k| c.get(*k) >= *min))
        .map(|(id, ..)| *id);
    let body = if kind == Kind::Body { vec!["fillet", "chamfer"] } else { Vec::new() };
    body.into_iter().chain(live).collect()
}

/// "3 faces", the Deselect All button's sub label.
pub fn summary(c: Counts) -> Option<String> {
    let (kind, n) = c.primary()?;
    let key = match kind {
        Kind::Edge => "rail.count.edge",
        Kind::Area => "rail.count.profile",
        Kind::Face => "rail.count.face",
        Kind::Body => "rail.count.body",
    };
    Some(crate::i18n::tr!(key, n = n))
}

/// A ribbon tool by command id, for an offer's name and icon.
pub fn ribbon_tool(action: &str) -> Option<ToolItem> {
    ribbon::MODEL.iter().flat_map(|g| ribbon::leaves(g)).find(|t| t.action == action)
}
