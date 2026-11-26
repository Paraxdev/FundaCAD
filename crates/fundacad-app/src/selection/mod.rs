//! What is selected, as FundaCAD 1's stores/selection.ts and viewport/picking.ts: faces and edges of built bodies,
//! whole bodies, sketches and planes, with the click rules and the filter of the 1, 2 and 3 keys.

#[cfg(test)]
mod tests;

use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum Pick {
    /// `point` is where it was clicked, which a `nearest` selector finds it again by.
    Face { body: String, face: u32, point: [f32; 3], normal: [f32; 3] },
    Edge { body: String, edge: u32, mid: [f32; 3] },
    Body { body: String },
    Sketch { feature: String },
    /// A world plane (XY, XZ, YZ) or a datum plane's feature id.
    Plane { id: String },
    /// A closed area of a finished sketch, `point` the world point inside it a feature stores.
    Area { sketch: String, point: [f64; 3] },
}

impl Pick {
    /// Two picks of the same thing, wherever on it they were clicked.
    pub fn same(&self, other: &Pick) -> bool {
        match (self, other) {
            (Pick::Face { body: a, face: f, .. }, Pick::Face { body: b, face: g, .. }) => a == b && f == g,
            (Pick::Edge { body: a, edge: e, .. }, Pick::Edge { body: b, edge: g, .. }) => a == b && e == g,
            _ => self == other,
        }
    }

    pub fn body(&self) -> Option<&str> {
        match self {
            Pick::Face { body, .. } | Pick::Edge { body, .. } | Pick::Body { body } => Some(body),
            _ => None,
        }
    }

    pub fn kind(&self) -> PickKind {
        match self {
            Pick::Face { .. } => PickKind::Face,
            Pick::Edge { .. } => PickKind::Edge,
            Pick::Body { .. } => PickKind::Body,
            Pick::Sketch { .. } => PickKind::Sketch,
            Pick::Plane { .. } => PickKind::Plane,
            Pick::Area { .. } => PickKind::Area,
        }
    }

    /// The selector a feature stores for a face or an edge, FundaCAD 1's `nearest` form.
    pub fn selector(&self) -> Option<Value> {
        let r = |v: [f32; 3]| v.map(|c| ((c as f64) * 1e4).round() / 1e4 + 0.0);
        match self {
            Pick::Face { body, point, .. } => Some(json!({"kind": "face", "by": "nearest", "point": r(*point), "body": body})),
            Pick::Edge { body, mid, .. } => Some(json!({"kind": "edge", "by": "nearest", "point": r(*mid), "body": body})),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickKind {
    Face,
    Edge,
    Body,
    Sketch,
    Plane,
    Area,
    /// A spot on a face, as a hole's points.
    Point,
}

impl PickKind {
    pub fn words(self, n: usize) -> String {
        let (one, many) = match self {
            PickKind::Face => ("face", "faces"),
            PickKind::Edge => ("edge", "edges"),
            PickKind::Body => ("body", "bodies"),
            PickKind::Sketch => ("sketch", "sketches"),
            PickKind::Plane => ("plane", "planes"),
            PickKind::Area => ("profile", "profiles"),
            PickKind::Point => ("point", "points"),
        };
        format!("{n} {}", if n == 1 { one } else { many })
    }
}

/// The 1, 2 and 3 keys: what a click in the view takes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    /// Faces and edges, the default.
    #[default]
    Faces,
    Bodies,
    /// A first click takes the body, a click on a body already selected takes its face.
    Auto,
}

impl Filter {
    pub fn label(self) -> &'static str {
        match self {
            Filter::Faces => "Faces and edges",
            Filter::Bodies => "Bodies",
            Filter::Auto => "Body, then its faces",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub shift: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Selection {
    pub picks: Vec<Pick>,
}

impl Selection {
    pub fn has(&self, p: &Pick) -> bool {
        self.picks.iter().any(|q| q.same(p))
    }

    pub fn of(&self, kind: PickKind) -> Vec<&Pick> {
        self.picks.iter().filter(|p| p.kind() == kind).collect()
    }

    /// A plain click takes only what it hit, Ctrl adds or drops it, Shift adds it. A click on nothing clears unless a
    /// modifier is held.
    pub fn click(&mut self, pick: Option<Pick>, mods: Mods) {
        let Some(pick) = pick else {
            if !mods.ctrl && !mods.shift {
                self.picks.clear();
            }
            return;
        };
        let at = self.picks.iter().position(|q| q.same(&pick));
        match (mods.ctrl, mods.shift, at) {
            (true, _, Some(i)) => {
                self.picks.remove(i);
            }
            (true, _, None) | (false, true, None) => self.picks.push(pick),
            (false, true, Some(_)) => {}
            (false, false, _) => self.picks = vec![pick],
        }
    }

    /// One line for the status bar, "2 faces, 1 edge", None when empty.
    pub fn describe(&self) -> Option<String> {
        let kinds = [PickKind::Face, PickKind::Edge, PickKind::Body, PickKind::Sketch, PickKind::Plane, PickKind::Area];
        let parts: Vec<String> = kinds
            .into_iter()
            .map(|k| (k, self.of(k).len()))
            .filter(|(_, n)| *n > 0)
            .map(|(k, n)| k.words(n))
            .collect();
        (!parts.is_empty()).then(|| parts.join(", "))
    }

    /// Drops picks of bodies the latest build no longer has.
    pub fn retain_bodies(&mut self, alive: impl Fn(&str) -> bool) {
        self.picks.retain(|p| p.body().is_none_or(&alive));
    }
}

/// What a click on the model takes under `filter`, from the face and edge under the cursor. An edge wins over the face
/// it borders, as FundaCAD 1's picking.
pub fn resolve(filter: Filter, sel: &Selection, face: Option<Pick>, edge: Option<Pick>) -> Option<Pick> {
    let body = face.as_ref().or(edge.as_ref()).and_then(|p| p.body()).map(|b| Pick::Body { body: b.to_string() });
    match filter {
        Filter::Faces => edge.or(face),
        Filter::Bodies => body,
        Filter::Auto => match &body {
            Some(b) if sel.has(b) || sel.picks.iter().any(|p| p.body() == b.body() && p.kind() != PickKind::Body) => {
                edge.or(face)
            }
            _ => body,
        },
    }
}
