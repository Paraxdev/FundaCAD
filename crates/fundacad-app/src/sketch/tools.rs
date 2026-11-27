//! The modify tools' click flows, FundaCAD 1's sketch/modifyFlow.ts and mirrorFlow.ts: Trim, Extend, Fillet, Offset,
//! Mirror and Move. Each finished edit is one undo step.

use fundacad_sketch::{Curve, Entity};
use glam::DVec2;
use serde_json::{json, Value};

use super::modify::{self, Cutter};
use super::{fresh_id, snap, Editor, Tool};
use crate::i18n::{t, tr};

/// An offset being placed: its source and the side and distance the cursor or the typed value set.
#[derive(Clone, Debug, PartialEq)]
pub struct OffsetPick {
    pub id: String,
    pub side: f64,
    pub mag: f64,
}

/// A Mirror run: what to mirror, the mirror line (its shape id, None for an origin axis, and two points on it) and
/// whether the next click picks the line.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mirror {
    pub objects: Vec<String>,
    pub line: Option<(Option<String>, DVec2, DVec2)>,
    pub picking_line: bool,
}

const FILLET_RADIUS: f64 = 2.0;
const APART: f64 = 1e-4;
/// The keys a move rewrites, so a size held by a parameter keeps it.
const POINT_KEYS: [&str; 10] = ["x1", "y1", "x2", "y2", "mx", "my", "x", "y", "points", "poles"];

fn base(id: &str) -> &str {
    id.split('~').next().unwrap_or(id)
}

fn prefix(ty: &str) -> &str {
    match ty {
        "rectangle" => "rect",
        "" => "shape",
        t => t,
    }
}

fn curve_json(c: &Curve) -> Option<Value> {
    Some(match c {
        Curve::Line { x1, y1, x2, y2 } => json!({"type": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2}),
        Curve::Circle { x, y, r } => json!({"type": "circle", "x": x, "y": y, "radius": r}),
        Curve::Arc { x1, y1, x2, y2, mx, my } => json!({"type": "arc", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "mx": mx, "my": my}),
        Curve::Poly(_) => return None,
    })
}

impl Editor {
    /// Arms a tool from its command. Move and Mirror take the selection with them.
    pub fn arm(&mut self, tool: Tool) {
        let sel = self.selected.clone().map(|s| base(&s).to_string());
        self.set_tool(tool);
        match tool {
            Tool::Move => self.selected = sel,
            Tool::Mirror => {
                let objects = sel.into_iter().filter(|s| !self.guard(s)).collect();
                self.mirror = Some(Mirror { objects, ..Mirror::default() });
            }
            _ => {}
        }
    }

    /// FundaCAD 1's prompt for what the tool wants now.
    pub fn prompt(&self) -> String {
        if self.offset.is_some() {
            return t("sketch.offset.pickSide");
        }
        if self.tool == Tool::Move && !self.clicks.is_empty() {
            return t("sketch.modify.clickDestination");
        }
        self.tool.prompt()
    }

    /// The shapes a modify tool has picked so far, drawn as picked.
    pub fn picked(&self) -> Vec<String> {
        let mut out: Vec<String> = self.first.iter().cloned().collect();
        out.extend(self.fillet.iter().flat_map(|(a, b)| [a.clone(), b.clone()]));
        out.extend(self.offset.iter().map(|o| o.id.clone()));
        if let Some(m) = &self.mirror {
            out.extend(m.objects.iter().cloned());
            out.extend(m.line.iter().filter_map(|l| l.0.clone()));
        }
        out
    }

    fn solved_of(&self, id: &str) -> Option<&Entity> {
        self.solved.entities.iter().find(|e| e.id() == id)
    }

    /// Projected geometry is fixed: true, with the notice, when `id` is projected.
    fn guard(&mut self, id: &str) -> bool {
        let p = matches!(self.solved_of(id), Some(Entity::Projected { .. }));
        if p {
            self.notice = Some(t("sketch.projectedFixed"));
        }
        p
    }

    /// The shape in plain numbers without its id: solved values for what the solver knows, else the document's JSON.
    pub fn shape(&self, id: &str) -> Option<Value> {
        let doc = self.entities.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(id));
        let solved = match self.solved_of(id) {
            Some(Entity::Line { x1, y1, x2, y2, .. }) => Some(json!({"type": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2})),
            Some(Entity::Circle { x, y, radius, .. }) => Some(json!({"type": "circle", "x": x, "y": y, "radius": radius})),
            Some(Entity::Arc { x1, y1, x2, y2, mx, my, .. }) => {
                Some(json!({"type": "arc", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "mx": mx, "my": my}))
            }
            Some(Entity::Rectangle { x, y, width, height, angle, .. }) => {
                let mut r = json!({"type": "rectangle", "x": x, "y": y, "width": width, "height": height});
                if *angle != 0.0 {
                    r["angle"] = json!(angle);
                }
                Some(r)
            }
            Some(Entity::Spline { points, .. }) => {
                Some(json!({"type": "spline", "points": points.iter().map(|p| json!({"x": p.x, "y": p.y})).collect::<Vec<_>>()}))
            }
            Some(Entity::Point { x, y, .. }) => Some(json!({"type": "point", "x": x, "y": y})),
            Some(Entity::Projected { curve, .. }) => curve_json(curve),
            _ => None,
        };
        let mut out = solved.or_else(|| doc.cloned())?;
        if let Some(o) = out.as_object_mut() {
            o.remove("id");
            o.remove("construction");
        }
        Some(out)
    }

    fn doc_construction(&self, id: &str) -> bool {
        self.is_construction(id)
    }

    /// Adds `shape` under a fresh id, construction when `construction`.
    fn push_shape(&mut self, mut shape: Value, construction: bool) -> String {
        let ty = shape.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
        let id = fresh_id(prefix(&ty), &self.taken());
        shape["id"] = json!(id);
        if construction {
            shape["construction"] = json!(true);
        }
        self.entities.push(shape);
        id
    }

    /// The shape `id` replaced by `pieces` under fresh ids, in its place, and every constraint naming it dropped.
    fn replace(&mut self, id: &str, pieces: Vec<Value>) {
        let construction = self.doc_construction(id);
        let Some(at) = self.entities.iter().position(|e| e.get("id").and_then(Value::as_str) == Some(id)) else { return };
        self.entities.remove(at);
        self.drop_constraints_on(id);
        let n = self.entities.len();
        for p in pieces {
            self.push_shape(p, construction);
        }
        let added: Vec<Value> = self.entities.drain(n..).collect();
        self.entities.splice(at..at, added);
    }

    /// The geometry of `id` set to `shape`'s, its id, construction and other keys kept.
    fn set_shape(&mut self, id: &str, shape: &Value) {
        let Some(e) = self.entities.iter_mut().find(|e| e.get("id").and_then(Value::as_str) == Some(id)) else { return };
        if let (Some(o), Some(s)) = (e.as_object_mut(), shape.as_object()) {
            for (k, v) in s {
                o.insert(k.clone(), v.clone());
            }
        }
    }

    /// Snap joins the edit of `changed` pulled apart, dropped rather than snapped back, FundaCAD 1's
    /// dropSeparatedJoins. A coincident the user applied stays.
    fn drop_separated_joins(&mut self, changed: &[&str]) {
        let now = super::solve::resolve(&self.entities, &self.params);
        let after: Vec<Entity> = self
            .solved
            .entities
            .iter()
            .map(|e| if changed.contains(&e.id()) { now.iter().find(|n| n.id() == e.id()).unwrap_or(e).clone() } else { e.clone() })
            .collect();
        let at = |es: &[Entity], e: &Value, p: &Value| {
            let q = es.iter().find(|x| Some(x.id()) == e.as_str())?.ref_point(p.as_f64().unwrap_or(0.0) as i64)?;
            Some(DVec2::new(q.x, q.y))
        };
        let gap = |es: &[Entity], c: &Value| Some(at(es, &c["e1"], &c["p1"])?.distance(at(es, &c["e2"], &c["p2"])?));
        let before = &self.solved.entities;
        self.constraints.retain(|c| {
            if c["type"] != "coincident" || c["snap"] != true {
                return true;
            }
            !matches!((gap(before, c), gap(&after, c)), (Some(g0), Some(g1)) if g0 <= APART && g1 > APART)
        });
    }

    fn cutters(&self, skip: &str) -> Vec<Cutter> {
        modify::cutters(&self.solved.entities, &self.polygons(), skip)
    }

    fn done(&mut self) -> Option<String> {
        self.resolve(true);
        Some(self.tool.label())
    }

    /// A click with a modify tool on `hit`, the shape under the cursor.
    pub(super) fn modify_click(&mut self, at: DVec2, hit: Option<String>, tol: f64) -> Option<String> {
        let hit = hit.map(|h| base(&h).to_string());
        match self.tool {
            Tool::Trim => {
                let id = hit?;
                if self.guard(&id) {
                    return None;
                }
                let pieces = self.solved_of(&id).map(|e| modify::trim(e, &self.cutters(&id), at)).unwrap_or_default();
                self.replace(&id, pieces);
                self.done()
            }
            Tool::Extend => {
                let id = hit?;
                if self.guard(&id) {
                    return None;
                }
                let grown = modify::extend(self.solved_of(&id)?, &self.cutters(&id), at)?;
                self.set_shape(&id, &grown);
                self.drop_separated_joins(&[&id]);
                self.done()
            }
            Tool::Fillet => {
                let id = hit?;
                if self.guard(&id) || !matches!(self.solved_of(&id), Some(Entity::Line { .. })) || self.fillet.is_some() {
                    return None;
                }
                match self.first.take() {
                    None => self.first = Some(id),
                    Some(a) if a == id => self.first = Some(a),
                    Some(a) => {
                        self.fillet = Some((a, id));
                        self.entry = Some(String::new());
                    }
                }
                None
            }
            Tool::Offset => {
                if self.offset.is_some() {
                    return self.commit_offset();
                }
                let id = hit?;
                match self.shape(&id).as_ref().and_then(|s| s.get("type")).and_then(Value::as_str) {
                    Some("point") => self.notice = Some(t("sketch.offset.noPoint")),
                    Some("text") => self.notice = Some(t("sketch.offset.noText")),
                    Some(_) => {
                        self.offset = Some(OffsetPick { id, side: 1.0, mag: 0.0 });
                        self.entry = Some(String::new());
                        self.offset_follow(at);
                    }
                    None => {}
                }
                None
            }
            Tool::Mirror => {
                self.mirror_click(at, hit, tol);
                None
            }
            Tool::Move => {
                let Some(sel) = self.selected.clone() else {
                    self.notice = Some(tr!("sketch.modify.selectFirst", tool = "move"));
                    return None;
                };
                let p = self.cursor.as_ref().map_or(at, |c| c.p);
                let Some(from) = self.clicks.first().map(|c| c.p) else {
                    self.clicks.push(snap::Snap::free(p));
                    return None;
                };
                self.clicks.clear();
                let id = base(&sel).to_string();
                if self.guard(&id) {
                    return None;
                }
                let moved = modify::translate(&self.shape(&id)?, p - from);
                let moved: serde_json::Map<String, Value> =
                    moved.as_object()?.iter().filter(|(k, _)| POINT_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
                self.set_shape(&id, &Value::Object(moved));
                self.drop_separated_joins(&[&id]);
                self.done()
            }
            _ => None,
        }
    }

    /// The live offset side and distance under the cursor, unless a typed value owns them.
    pub(super) fn offset_follow(&mut self, p: DVec2) {
        let typed = self.entry.as_deref().and_then(|s| s.trim().parse::<f64>().ok());
        let Some(src) = self.offset.as_ref().and_then(|o| self.shape(&o.id)) else { return };
        let signed = modify::signed_offset_at(&src, p);
        let Some(o) = &mut self.offset else { return };
        if let Some(v) = typed {
            o.mag = v.abs();
            if v != 0.0 {
                o.side = v.signum();
            }
        } else if let Some(s) = signed {
            if s.abs() > 1e-6 {
                o.side = s.signum();
            }
            o.mag = s.abs();
        }
    }

    fn commit_offset(&mut self) -> Option<String> {
        let typed = self.entry.as_deref().filter(|s| !s.trim().is_empty());
        if let Some(s) = typed {
            let Ok(v) = s.trim().parse::<f64>() else {
                self.notice = Some(t("sketch.offset.typeDistance"));
                return None;
            };
            let o = self.offset.as_mut()?;
            o.mag = v.abs();
            if v != 0.0 {
                o.side = v.signum();
            }
        }
        let o = self.offset.clone()?;
        if o.mag < 1e-6 {
            self.notice = Some(t("sketch.offset.typeDistance"));
            return None;
        }
        let dist = o.side * o.mag;
        let Some((copy, linked)) = self.shape(&o.id).and_then(|s| modify::offset(&s, dist)) else {
            self.notice = Some(t("sketch.offset.collapse"));
            self.cancel_modify();
            return None;
        };
        self.cancel_modify();
        let ty = copy["type"].as_str().unwrap_or_default().to_string();
        let construction = self.doc_construction(&o.id);
        let id = self.push_shape(copy, construction);
        if linked {
            let pairs: Vec<Value> = if ty == "rectangle" {
                (0..4).map(|k| json!({"src": format!("{}~{k}", o.id), "cpy": format!("{id}~{k}")})).collect()
            } else {
                vec![json!({"src": o.id, "cpy": id})]
            };
            let cid = fresh_id("d", &self.taken());
            self.constraints.push(json!({"type": "offset", "pairs": pairs, "value": dist, "id": cid}));
        } else {
            self.notice = Some(t("sketch.offset.unlinked"));
        }
        self.done()
    }

    fn apply_fillet(&mut self, r: f64) -> Option<String> {
        let (a, b) = self.fillet.take()?;
        self.first = None;
        let seg = |id: &str| self.solved_of(id).and_then(Entity::as_line_seg).map(|(p, q)| (DVec2::new(p.x, p.y), DVec2::new(q.x, q.y)));
        let f = modify::fillet(seg(&a)?, seg(&b)?, r)?;
        let line = |(p, q): (DVec2, DVec2)| json!({"x1": p.x, "y1": p.y, "x2": q.x, "y2": q.y});
        self.set_shape(&a, &line(f.a));
        self.set_shape(&b, &line(f.b));
        self.drop_separated_joins(&[&a, &b]);
        let arc = self.push_shape(f.arc, false);
        self.constraints.push(json!({"type": "tangent2", "a": a, "b": arc}));
        self.constraints.push(json!({"type": "tangent2", "a": b, "b": arc}));
        self.done()
    }

    fn mirror_click(&mut self, at: DVec2, hit: Option<String>, tol: f64) {
        let Some(m) = self.mirror.clone() else { return };
        if m.picking_line {
            let axis = hit.as_ref().and_then(|h| self.solved_of(h)).and_then(Entity::as_line_seg);
            let line = match (&hit, axis) {
                (Some(h), Some((a, b))) => Some((Some(h.clone()), DVec2::new(a.x, a.y), DVec2::new(b.x, b.y))),
                (None, _) if at.y.abs() <= tol => Some((None, DVec2::ZERO, DVec2::X)),
                (None, _) if at.x.abs() <= tol => Some((None, DVec2::ZERO, DVec2::Y)),
                (Some(_), None) => {
                    self.notice = Some(t("sketch.mirror.lineRefused"));
                    None
                }
                _ => None,
            };
            let Some(line) = line else { return };
            let mut objects = m.objects;
            if let Some(id) = &line.0 {
                if objects.contains(id) {
                    objects.retain(|o| o != id);
                    self.notice = Some(t("sketch.mirror.lineLeftObjects"));
                }
            }
            self.mirror = Some(Mirror { objects, line: Some(line), picking_line: false });
            return;
        }
        let Some(id) = hit else { return };
        if self.guard(&id) {
            return;
        }
        let mut m = m;
        if m.objects.contains(&id) {
            m.objects.retain(|o| *o != id);
        } else {
            if m.line.as_ref().is_some_and(|l| l.0.as_deref() == Some(id.as_str())) {
                m.line = None;
            }
            m.objects.push(id);
        }
        self.mirror = Some(m);
    }

    /// Enter in Mirror: on to the empty field, or the mirror applied once both hold something. Tab switches field.
    pub fn mirror_key(&mut self, key: &str) -> Option<String> {
        let m = self.mirror.as_mut()?;
        if key == "tab" {
            m.picking_line = !m.picking_line;
            return None;
        }
        if m.objects.is_empty() || m.line.is_none() {
            m.picking_line = !m.objects.is_empty();
            return None;
        }
        let m = self.mirror.take()?;
        let (line_id, a, b) = m.line?;
        let order: Vec<String> = self.entities.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(String::from)).collect();
        for id in order.iter().filter(|id| m.objects.contains(id) && Some(*id) != line_id.as_ref()) {
            if let Some(s) = self.shape(id) {
                let c = self.doc_construction(id);
                self.push_shape(modify::reflect(&s, a, b), c);
            }
        }
        let label = self.done();
        self.set_tool(Tool::Select);
        label
    }

    /// A key while a number is being typed, the undo label when Enter applied it.
    pub fn entry_key(&mut self, key: &str, ch: Option<&str>) -> Option<String> {
        let text = self.entry.as_mut()?;
        match key {
            "enter" => {
                if self.offset.is_some() {
                    return self.commit_offset();
                }
                let r = text.trim().parse::<f64>().ok().filter(|r| *r > 0.0).unwrap_or(FILLET_RADIUS);
                self.entry = None;
                return self.apply_fillet(r);
            }
            "escape" => self.cancel_modify(),
            "backspace" => drop(text.pop()),
            _ => {
                if let Some(c) = ch.filter(|c| c.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-')) {
                    text.push_str(c);
                }
            }
        }
        if let Some(p) = self.cursor.as_ref().map(|c| c.p) {
            self.offset_follow(p);
        }
        None
    }

    /// Drops every half finished modify gesture.
    pub fn cancel_modify(&mut self) {
        self.entry = None;
        self.offset = None;
        self.fillet = None;
        if let Some(m) = &mut self.mirror {
            *m = Mirror::default();
        }
    }

    /// What the modify tool would add or change, as document JSON.
    pub fn modify_preview(&self) -> Vec<Value> {
        if let Some(o) = &self.offset {
            let src = self.shape(&o.id);
            return src.and_then(|s| modify::offset(&s, o.side * o.mag)).filter(|_| o.mag > 1e-6).map(|(c, _)| c).into_iter().collect();
        }
        if let Some(m) = &self.mirror {
            let Some((line_id, a, b)) = &m.line else { return Vec::new() };
            return m
                .objects
                .iter()
                .filter(|id| Some(*id) != line_id.as_ref())
                .filter_map(|id| self.shape(id))
                .map(|s| modify::reflect(&s, *a, *b))
                .collect();
        }
        if self.tool == Tool::Move {
            let (Some(from), Some(to), Some(sel)) = (self.clicks.first(), self.cursor.as_ref(), self.selected.as_deref()) else {
                return Vec::new();
            };
            return self.shape(base(sel)).map(|s| modify::translate(&s, to.p - from.p)).into_iter().collect();
        }
        Vec::new()
    }
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;
