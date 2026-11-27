//! The edge drag, FundaCAD 1's edgeFeatureTool.ts: pick edges and drag the handle, one way along it is a fillet, the
//! other a chamfer, with no feature at the origin. The engine's rebuild of each value is the live preview, as the face
//! push's, and letting go records one undo step. Dragging a fillet or chamfer face resizes that feature.

#[cfg(test)]
mod tests;

use glam::{Vec2, Vec3};
use gpui::*;
use serde_json::{json, Map, Value};

use super::pick;
use super::Viewport;
use crate::edgedrag::{self as ed, BlendRange, Commit, Gate, Outcomes, Reply, Treatment, Verdict};
use crate::i18n::tr;
use crate::overlay::{self, Choice};
use crate::selection::{Filter, Pick};
use crate::tools::{self, Doc};

/// Pixels from the edge to the knob, and how near the knob a press takes it.
const HANDLE_PX: f32 = 56.0;
const KNOB_PX: f32 = 7.0;
const GRAB_PX: f32 = 12.0;

/// Fields one treatment has and the other does not, dropped when a drag crosses the origin.
const OWN_FIELDS: &[&str] = &["radius", "distance", "distance2", "chamferType", "profile", "continuity", "sizeType"];

#[derive(Clone)]
pub(super) struct Target {
    edges: Vec<Value>,
    anchor: Vec3,
    tangent: Option<Vec3>,
}

/// A question a press left for the mouse up, which has the window to ask it in.
pub(super) enum Ask {
    /// The edges, and the document they were picked on, since a yes on a document changed meanwhile starts nothing.
    Many(Target, Doc),
    TooMany(usize),
}

pub(super) struct Blend {
    id: String,
    edges: Vec<Value>,
    /// The feature as it was, and its index, when the drag resizes one.
    original: Option<(usize, Value)>,
    anchor: Vec3,
    tangent: Option<Vec3>,
    axis: Vec3,
    positive: Treatment,
    kind: Treatment,
    signed: f64,
    /// The signed value and the swipe in mm when the handle was taken, while the button is held.
    grab: Option<(f64, f64)>,
    moved: bool,
    /// The heads-up box's typed text, None while it shows the value.
    typing: Option<String>,
    /// Let go without a drag: the box waits for Enter or Esc.
    open: bool,
    /// Let go and committed unverified, waiting for the reply to the last value sent.
    released: bool,
    /// Enter on this typed text waits for the engine's verdict, a refusal keeps the box open with it.
    awaiting: Option<String>,
    range: BlendRange,
    outcomes: Outcomes,
    /// Each preview sent, with the document revision it made, None for the bare model.
    sent: Vec<(u64, Option<Value>)>,
    /// The latest revision the engine answered.
    replied: u64,
    before: Doc,
    edit: Option<Edit>,
}

/// A fillet or chamfer opened from History, FundaCAD 1's startEdit: while it is live the model stops just after it,
/// over the sharp edges it rounds drawn as a ghost.
pub(super) struct Edit {
    /// The revision of the build rolled back to just before the feature, until it lands.
    rollback: Option<u64>,
    ghost: Vec<Vec<Vec3>>,
    label: String,
    /// The parameter the size is bound to, written in place of the feature, as FundaCAD 1's bareParamRef.
    param: Option<String>,
}

/// `doc` built up to the edited feature at `at`, up to just before it when it is not `shown`.
fn rolled_back(mut doc: Doc, at: usize, shown: bool) -> Doc {
    crate::timeline::ops::set_rollback(&mut doc, at + usize::from(shown));
    doc
}

fn edges_of(f: &Value) -> Vec<Value> {
    match &f["edges"] {
        Value::Array(a) => a.clone(),
        Value::Null => Vec::new(),
        e => vec![e.clone()],
    }
}

/// Where a stored edge is: its `point`, or the middle a match selector keeps.
fn point_of(selector: &Value) -> Option<Vec3> {
    let p = selector.get("point").or_else(|| selector.get("fp")?.get("mid"))?;
    let p: Vec<f32> = p.as_array()?.iter().filter_map(Value::as_f64).map(|c| c as f32).collect();
    Some(Vec3::from_slice(p.get(..3)?))
}

const EXPRESSION: &str = "This size is an expression, change it in History";

/// The parameter a drag of `field` on feature `id` writes: the one bound to it, or the one its binding names alone.
/// Ok(None) when the field is unbound, Err when it follows an expression a drag cannot write.
fn bound_param(doc: &Doc, id: &str, field: &str) -> Result<Option<String>, &'static str> {
    let Some(defs) = doc.get("paramDefs").and_then(Value::as_object) else { return Ok(None) };
    let bound = defs.iter().find(|(_, d)| {
        let t = |k: &str| d.get("target").and_then(|t| t.get(k)).and_then(Value::as_str);
        t("kind") == Some("feature") && t("feature") == Some(id) && t("field") == Some(field)
    });
    let Some((name, d)) = bound else { return Ok(None) };
    let expr = d.get("expr").and_then(Value::as_str).unwrap_or_default().trim();
    if expr.parse::<f64>().is_ok_and(f64::is_finite) {
        return Ok(Some(name.clone()));
    }
    let named = |n: &str| defs.contains_key(n) || doc.get("parameters").and_then(|p| p.get(n)).is_some();
    let bare = expr.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
        && expr.chars().all(|c| c.is_alphanumeric() || c == '_');
    if bare && expr != name && named(expr) { Ok(Some(expr.to_string())) } else { Err(EXPRESSION) }
}

/// Why the step cannot be opened for a drag, None when it can.
fn edit_refusal(f: &Value) -> Option<&'static str> {
    let kind = Treatment::of(f.get("type")?.as_str()?)?;
    if !f.get(kind.field()).is_some_and(Value::is_number) {
        return Some(EXPRESSION);
    }
    let edges = edges_of(f);
    if edges.is_empty() || !edges.iter().all(|e| point_of(e).is_some()) {
        return Some("These edges have no point to drag from, change the size in History");
    }
    None
}

impl Blend {
    fn value(&self) -> f64 {
        (self.signed.abs() * 1000.0).round() / 1000.0
    }

    fn neutral(&self) -> bool {
        self.value() < ed::MIN_EDGE_VALUE
    }

    fn feature(&self, kind: Treatment, value: f64) -> Value {
        let mut f = match &self.original {
            Some((_, o)) if o.get("type").and_then(Value::as_str) == Some(kind.kind()) => o.clone(),
            Some((_, o)) => {
                let mut f = o.clone();
                if let Some(m) = f.as_object_mut() {
                    OWN_FIELDS.iter().for_each(|k| drop(m.remove(*k)));
                }
                f
            }
            None => json!({"id": self.id, "edges": self.edges}),
        };
        f["type"] = json!(kind.kind());
        f[kind.field()] = json!(value);
        f
    }

    /// What the model shows now, None for no feature.
    fn current(&self) -> Option<Value> {
        (!self.neutral()).then(|| self.feature(self.kind, self.value()))
    }

    /// `before` with `feature` in place of the dragged one.
    fn doc_with(&self, feature: Option<&Value>) -> Result<Doc, String> {
        let mut doc = self.before.clone();
        let param = self.edit.as_ref().and_then(|e| e.param.as_deref()).filter(|_| self.same_kind());
        match (&self.original, feature) {
            (Some(_), Some(_)) if param.is_some() => {
                fundacad_client::set_param(&mut doc, param.expect("checked"), self.value())?;
            }
            (Some((at, _)), f) => {
                let list = doc.get_mut("features").and_then(Value::as_array_mut).ok_or("the document has no features")?;
                match f {
                    Some(f) => list[*at] = f.clone(),
                    None => drop(list.remove(*at)),
                }
            }
            (None, Some(f)) => tools::insert(&mut doc, f.clone())?,
            (None, None) => {}
        }
        match (&self.edit, &self.original) {
            (Some(_), Some((at, _))) if self.live() => Ok(rolled_back(doc, *at, feature.is_some())),
            _ => Ok(doc),
        }
    }

    fn same_kind(&self) -> bool {
        self.original.as_ref().is_some_and(|(_, o)| Treatment::of(o["type"].as_str().unwrap_or_default()) == Some(self.kind))
    }

    /// The edited feature's size is back where it was, so letting go changes nothing.
    fn unchanged(&self) -> bool {
        let Some((_, o)) = self.original.as_ref().filter(|_| self.edit.is_some() && self.same_kind()) else { return false };
        o.get(self.kind.field()).and_then(Value::as_f64) == Some(self.value())
    }

    /// Why letting go cannot write what the handle shows: a bound size turned into the other treatment would leave
    /// its parameter bound to a field the feature no longer has.
    fn refusal(&self) -> Option<String> {
        let p = self.edit.as_ref()?.param.as_ref().filter(|_| !self.same_kind() && !self.neutral())?;
        Some(format!("The size follows the parameter {p}, so it stays a {}", self.kind.other().label().to_lowercase()))
    }

    fn sent_at(&self, revision: u64) -> Option<&Option<Value>> {
        self.sent.iter().rev().find(|(r, _)| *r <= revision).map(|(_, f)| f)
    }

    fn verdict(&self) -> Verdict {
        match self.current() {
            None => Verdict::Unknown,
            Some(f) => match self.outcomes.verdict(&ed::feature_key(&f)) {
                Verdict::Unknown => self.range.verdict(self.value()),
                v => v,
            },
        }
    }

    fn shown_value(&self) -> Option<f64> {
        let f = self.outcomes.shown.as_ref()?;
        (Treatment::of(f.get("type")?.as_str()?) == Some(self.kind)).then(|| f.get(self.kind.field())?.as_f64())?
    }

    /// An edit to the text Enter waits on takes it back into the box.
    fn resume_typing(&mut self) {
        if let Some(t) = self.awaiting.take() {
            self.typing = Some(t);
        }
    }

    fn live(&self) -> bool {
        self.grab.is_some() || self.open
    }
}

/// The midpoint of `line` and the direction of the segment nearest it.
fn mid_and_tangent(line: &[Vec3]) -> Option<(Vec3, Option<Vec3>)> {
    let mid = super::edges::midpoint(line)?;
    let tangent = line
        .windows(2)
        .min_by(|a, b| a[0].lerp(a[1], 0.5).distance(mid).total_cmp(&b[0].lerp(b[1], 0.5).distance(mid)))
        .and_then(|w| (w[1] - w[0]).try_normalize());
    Some((mid, tangent))
}

impl Viewport {
    fn project(&self, p: Vec3) -> Option<Vec2> {
        let b = self.bounds;
        let (w, h) = (b.size.width.as_f32().max(1.0), b.size.height.as_f32().max(1.0));
        let c = self.camera.projection(w / h) * self.camera.view() * p.extend(1.0);
        (c.w > 1e-6).then(|| Vec2::new((c.x / c.w + 1.0) * 0.5 * w, (1.0 - c.y / c.w) * 0.5 * h))
    }

    fn local(&self, position: Point<Pixels>) -> Vec2 {
        let l = position - self.bounds.origin;
        Vec2::new(l.x.as_f32(), l.y.as_f32())
    }

    /// Millimetres per screen pixel at `p`.
    fn mm_per_px(&self, p: Vec3) -> f64 {
        let step = self.radius.max(1e-3) * 0.01;
        let right = self.camera.view().row(0).truncate().normalize_or_zero();
        match (self.project(p), self.project(p + right * step)) {
            (Some(a), Some(b)) if a.distance(b) > 1e-6 => (step / a.distance(b)) as f64,
            _ => 1.0,
        }
    }

    /// Across the edge and the view, away from the model's centre, as FundaCAD 1's edgeHandleAxis.
    fn handle_axis(&self, anchor: Vec3, tangent: Option<Vec3>) -> Vec3 {
        let forward = (self.camera.target - self.camera.eye()).normalize_or_zero();
        let across = tangent.map(|t| t.cross(forward)).filter(|a| a.length_squared() > 1e-6);
        let axis = across.unwrap_or_else(|| self.camera.view().row(0).truncate()).normalize_or_zero();
        let centre = self.scene.bounds().map_or(Vec3::ZERO, |(c, _)| c);
        if (anchor - centre).dot(axis) < 0.0 { -axis } else { axis }
    }

    /// The handle on screen: the anchor and the knob.
    fn handle_px(&self, anchor: Vec3, axis: Vec3) -> Option<(Vec2, Vec2)> {
        let a = self.project(anchor)?;
        let dir = self.project(anchor + axis * self.radius.max(1e-3) * 0.1).map(|t| t - a);
        let dir = dir.and_then(|d| d.try_normalize()).unwrap_or(Vec2::X);
        Some((a, a + dir * HANDLE_PX))
    }

    /// The edges a handle shows for while nothing is dragged: the picked ones, else the one last hovered.
    pub(super) fn blend_target(&self) -> Option<Target> {
        if self.tool.is_some() || self.sketch.is_some() || self.push.is_some() || self.blend.is_some() {
            return None;
        }
        let picked: Vec<&Pick> = self.picking.selection.picks.iter().filter(|p| matches!(p, Pick::Edge { .. })).collect();
        let line = |bi: usize, ei: usize| self.picking.lines().get(bi).and_then(|l| l.get(ei));
        if let Some(Pick::Edge { body, edge, mid, .. }) = picked.last() {
            let tangent = match (picked.len(), self.scene.body_index(body)) {
                (1, Some(bi)) => line(bi, *edge as usize).and_then(|l| mid_and_tangent(l)).and_then(|(_, t)| t),
                _ => None,
            };
            let edges = picked.iter().filter_map(|p| p.selector()).collect();
            return Some(Target { edges, anchor: Vec3::from(*mid), tangent });
        }
        if !self.picking.selection.picks.is_empty() || self.picking.filter == Filter::Bodies {
            return None;
        }
        let (bi, ei) = self.blend_hover?;
        let (mid, tangent) = mid_and_tangent(line(bi, ei)?)?;
        let body = self.scene.bodies.get(bi)?.source.id.clone();
        let edges = Pick::Edge { body, edge: ei as u32, mid: mid.to_array(), dir: None }.selector().into_iter().collect();
        Some(Target { edges, anchor: mid, tangent })
    }

    fn knob_at(&self, target: &Target) -> Option<Vec2> {
        self.handle_px(target.anchor, self.handle_axis(target.anchor, target.tangent)).map(|(_, k)| k)
    }

    /// Keeps the hovered edge's handle up while the cursor goes from the edge to its knob.
    pub(super) fn blend_hover_at(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let at = self.local(position);
        let next = match self.picking.hover_edge {
            Some(e) => Some(e),
            None => self.blend_hover.filter(|_| {
                self.blend_target().and_then(|t| self.knob_at(&t)).is_some_and(|k| k.distance(at) <= GRAB_PX * 2.0)
            }),
        };
        if next != self.blend_hover {
            self.blend_hover = next;
            cx.notify();
        }
    }

    /// The fillet or chamfer that made the face under `position`, and where it was hit.
    fn blend_face_at(&self, position: Point<Pixels>) -> Option<(usize, Value, Vec3, Vec3)> {
        let (origin, dir) = self.ray_at(position);
        let hit = pick::pick(&self.scene, origin, dir)?;
        let owner = self.scene.bodies[hit.body].owner(hit.face)?;
        let doc = &self.session.as_ref()?.doc;
        let at = tools::index_of(doc, owner)?;
        let f = tools::feature(doc, owner)?.clone();
        Treatment::of(f.get("type")?.as_str()?)?;
        Some((at, f, hit.point, hit.normal))
    }

    pub(super) fn blend_on_knob(&self, position: Point<Pixels>) -> bool {
        let at = self.local(position);
        self.blend_target().and_then(|t| self.knob_at(&t)).is_some_and(|k| k.distance(at) <= GRAB_PX)
    }

    /// A press that starts a blend: on the knob, on an edge, or on a fillet or chamfer face. True when it took it.
    pub(super) fn blend_press(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        if self.tool.is_some() || self.sketch.is_some() || self.push.is_some() {
            return false;
        }
        if self.blend_grab_edit(position, cx) {
            return true;
        }
        if self.blend.as_ref().is_some_and(|b| b.open) {
            self.blend_away(cx);
        }
        self.blend_settle();
        if self.blend.is_some() {
            return false;
        }
        let at = self.local(position);
        let on_knob = self.blend_target().filter(|t| self.knob_at(t).is_some_and(|k| k.distance(at) <= GRAB_PX));
        let target = on_knob.or_else(|| {
            if self.picking.filter == Filter::Bodies {
                return None;
            }
            let (_, _, pick) = self.picks_at(position).1?;
            let picked = self.picking.selection.has(&pick);
            let Pick::Edge { mid, .. } = &pick else { return None };
            let mut t = Target { edges: pick.selector().into_iter().collect(), anchor: Vec3::from(*mid), tangent: None };
            if picked {
                t.edges = self.picking.selection.picks.iter().filter(|p| matches!(p, Pick::Edge { .. })).filter_map(Pick::selector).collect();
            }
            if t.edges.len() == 1 {
                let (bi, ei, _) = self.picks_at(position).1?;
                t.tangent = self.picking.lines().get(bi).and_then(|l| l.get(ei)).and_then(|l| mid_and_tangent(l)).and_then(|(_, t)| t);
            }
            Some(t)
        });
        let Some(session) = self.session.as_ref() else { return false };
        let before = session.doc.clone();
        let blend = match target {
            Some(t) => {
                match ed::edge_gate(t.edges.len()) {
                    Gate::Refuse => {
                        self.say(tr_many("tool.fillet.tooManyBody", t.edges.len()), cx);
                        self.blend_ask = Some(Ask::TooMany(t.edges.len()));
                        return true;
                    }
                    Gate::Warn => {
                        self.blend_ask = Some(Ask::Many(t, before));
                        return true;
                    }
                    Gate::Go => {}
                }
                self.new_blend(t, before)
            }
            None => {
                let Some((at, f, point, normal)) = self.blend_face_at(position) else { return false };
                let kind = Treatment::of(f["type"].as_str().unwrap_or_default()).expect("checked by blend_face_at");
                let Some(value) = f.get(kind.field()).and_then(Value::as_f64) else {
                    self.say("This size is an expression, change it in History".into(), cx);
                    return true;
                };
                let edges = edges_of(&f);
                let mut outcomes = Outcomes::default();
                outcomes.note(Some(&f), Reply::Built);
                Blend {
                    id: f["id"].as_str().unwrap_or_default().to_string(),
                    edges,
                    original: Some((at, f)),
                    anchor: point,
                    tangent: None,
                    axis: normal,
                    positive: kind,
                    kind,
                    signed: value,
                    grab: None,
                    moved: false,
                    typing: None,
                    open: false,
                    released: false,
                    awaiting: None,
                    range: BlendRange::default().note(value, true),
                    outcomes,
                    sent: Vec::new(),
                    replied: 0,
                    before,
                    edit: None,
                }
            }
        };
        let proj = self.swipe(&blend, position);
        self.blend = Some(Blend { grab: Some((blend.signed, proj)), ..blend });
        self.hover = None;
        cx.notify();
        true
    }

    /// Opens the fillet or chamfer `id` from History for a drag, as FundaCAD 1's startEdit: the model rolls back to
    /// just before it to show the sharp edges, then the blend goes back on top with its value box open. True when it
    /// opened, a refusal is said in the status and the History rows stay the way to change it.
    pub fn open_blend_step(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.tool.is_some() || self.sketch.is_some() || self.push.is_some() {
            return false;
        }
        self.blend_settle();
        if self.blend.is_some() {
            return false;
        }
        let Some(before) = self.session.as_ref().map(|s| s.doc.clone()) else { return false };
        let Some(at) = tools::index_of(&before, id) else { return false };
        let Some(f) = tools::feature(&before, id).cloned() else { return false };
        let Some(kind) = f.get("type").and_then(Value::as_str).and_then(Treatment::of) else { return false };
        let param = match edit_refusal(&f).map_or_else(|| bound_param(&before, id, kind.field()), Err) {
            Ok(p) => p,
            Err(why) => {
                self.say(why.into(), cx);
                return false;
            }
        };
        let value = f[kind.field()].as_f64().unwrap_or_default();
        let edges = edges_of(&f);
        let anchor = point_of(&edges[0]).unwrap_or_default();
        let mut outcomes = Outcomes::default();
        outcomes.note(Some(&f), Reply::Built);
        let label = format!("Edit {}", crate::timeline::labels::name_of(&before, id));
        let rollback = rolled_back(before.clone(), at, false);
        self.blend = Some(Blend {
            id: id.to_string(),
            edges,
            original: Some((at, f)),
            anchor,
            tangent: None,
            axis: self.handle_axis(anchor, None),
            positive: kind,
            kind,
            signed: value,
            grab: None,
            moved: false,
            typing: Some(String::new()),
            open: true,
            released: false,
            awaiting: None,
            range: BlendRange::default().note(value, true),
            outcomes,
            sent: Vec::new(),
            replied: 0,
            before,
            edit: Some(Edit { rollback: None, ghost: Vec::new(), label, param }),
        });
        self.picking.selection.picks.clear();
        self.blend_hover = None;
        self.blend_send(rollback, None, cx);
        let b = self.blend.as_mut().expect("just set");
        match b.sent.last() {
            Some((r, _)) => b.edit.as_mut().expect("just set").rollback = Some(*r),
            None => self.blend_preview(cx),
        }
        let focus = self.sketch_focus(cx);
        window.focus(&focus, cx);
        cx.notify();
        true
    }

    /// A press on the knob of a blend opened from History takes the handle again, the box stays open.
    fn blend_grab_edit(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        let Some(b) = self.blend.as_ref().filter(|b| b.open && b.grab.is_none()) else { return false };
        if b.edit.as_ref().is_none_or(|e| e.rollback.is_some()) {
            return false;
        }
        let at = self.local(position);
        if !self.handle_px(b.anchor, b.axis).is_some_and(|(_, k)| k.distance(at) <= GRAB_PX) {
            return false;
        }
        let proj = self.swipe(b, position);
        let b = self.blend.as_mut().expect("checked above");
        b.grab = Some((b.signed, proj));
        b.moved = false;
        b.typing = None;
        b.awaiting = None;
        cx.notify();
        true
    }

    /// The rolled back build of a blend opened from History has landed: its sharp edges become the ghost and the
    /// handle runs across the first of them. True when `revision` was that build.
    fn blend_rolled_back(&mut self, revision: u64, cx: &mut Context<Self>) -> bool {
        let Some(b) = self.blend.as_ref() else { return false };
        if !b.edit.as_ref().and_then(|e| e.rollback).is_some_and(|r| revision >= r) {
            return false;
        }
        let lines = self.picking.lines();
        let ghost: Vec<Vec<Vec3>> = b
            .edges
            .iter()
            .filter_map(|sel| {
                let mut sel = sel.clone();
                sel["point"] = json!(point_of(&sel)?.to_array());
                Some(sel)
            })
            .filter_map(|sel| match super::resolve::resolve(&self.scene, lines, &sel)? {
                Pick::Edge { body, edge, .. } => lines.get(self.scene.body_index(&body)?)?.get(edge as usize).cloned(),
                _ => None,
            })
            .collect();
        let first = ghost.first().and_then(|l| mid_and_tangent(l));
        let single = b.edges.len() == 1;
        let (anchor, tangent) = match first {
            Some((mid, t)) => (mid, t.filter(|_| single)),
            None => (b.anchor, None),
        };
        let axis = self.handle_axis(anchor, tangent);
        let b = self.blend.as_mut().expect("checked above");
        b.replied = b.replied.max(revision);
        (b.anchor, b.tangent, b.axis) = (anchor, tangent, axis);
        let e = b.edit.as_mut().expect("checked above");
        e.rollback = None;
        e.ghost = ghost;
        self.blend_preview(cx);
        true
    }

    fn new_blend(&self, t: Target, before: Doc) -> Blend {
        let axis = self.handle_axis(t.anchor, t.tangent);
        Blend {
            id: tools::next_id(&before),
            edges: t.edges,
            original: None,
            anchor: t.anchor,
            tangent: t.tangent,
            axis,
            positive: Treatment::Fillet,
            kind: Treatment::Fillet,
            signed: 0.0,
            grab: None,
            moved: false,
            typing: None,
            open: false,
            released: false,
            awaiting: None,
            range: BlendRange::default(),
            outcomes: Outcomes::default(),
            sent: Vec::new(),
            replied: 0,
            before,
            edit: None,
        }
    }

    /// Opens the question a press on too many edges left, as FundaCAD 1's confirmEdgeCount. A yes starts the blend
    /// with its value box open, since the drag that asked has been let go by then.
    pub(super) fn blend_ask(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ask) = self.blend_ask.take() else { return };
        let (question, choices, target) = match ask {
            Ask::TooMany(n) => {
                let ok = Choice::primary(tr!("tool.fillet.ok")).hint(tr_many("tool.fillet.tooManyBody", n));
                (tr_many("tool.fillet.tooMany", n), vec![ok], None)
            }
            Ask::Many(t, before) => {
                let n = t.edges.len();
                let go = Choice::primary(tr_many("tool.fillet.manyAction", n)).hint(tr_many("tool.fillet.manyBody", n));
                (tr_many("tool.fillet.manyTitle", n), vec![Choice::plain(tr!("common.cancel")), go], Some((t, before)))
            }
        };
        let answer = overlay::confirm(window, cx, question, choices);
        let Some((target, picked_on)) = target else { return };
        cx.spawn_in(window, async move |this, cx| {
            if answer.recv().await.ok().flatten() != Some(1) {
                return;
            }
            let _ = this.update_in(cx, |v, w, cx| {
                if v.blend_begin(target, &picked_on, cx) {
                    let focus = v.sketch_focus(cx);
                    w.focus(&focus, cx);
                }
            });
        })
        .detach();
    }

    /// Starts a blend on `t` with its value box open. False when something else took the view meanwhile, or the
    /// document is no longer the `picked_on` one its edges name.
    fn blend_begin(&mut self, t: Target, picked_on: &Doc, cx: &mut Context<Self>) -> bool {
        if self.tool.is_some() || self.sketch.is_some() || self.push.is_some() || self.blend.is_some() {
            return false;
        }
        let Some(before) = self.session.as_ref().map(|s| s.doc.clone()).filter(|d| d == picked_on) else {
            return false;
        };
        self.blend = Some(Blend { grab: Some((0.0, 0.0)), ..self.new_blend(t, before) });
        self.blend_release(cx);
        self.blend_open()
    }

    /// How far the cursor has swiped across the dragged edge, in mm.
    fn swipe(&self, b: &Blend, position: Point<Pixels>) -> f64 {
        let Some(o) = self.project(b.anchor) else { return 0.0 };
        let mm = self.mm_per_px(b.anchor);
        let along = |v: Vec3| self.project(b.anchor + v * (mm * 40.0) as f32).map_or(Vec2::ZERO, |p| p - o);
        let edge = b.tangent.map_or(Vec2::ZERO, along);
        ed::swipe_offset_px(o, edge, along(b.axis), self.local(position)) as f64 * mm
    }

    pub(super) fn blend_held(&self) -> bool {
        self.blend.as_ref().is_some_and(|b| b.grab.is_some())
    }

    pub(super) fn blend_to(&mut self, position: Point<Pixels>, fine: bool, cx: &mut Context<Self>) {
        let Some(b) = self.blend.as_ref() else { return };
        let Some((grab_signed, grab_proj)) = b.grab else { return };
        let signed = ed::scrub_signed(&ed::Scrub {
            grab_signed,
            grab_proj,
            proj: self.swipe(b, position),
            step: ed::snap_step(self.mm_per_px(b.anchor), fine),
            limit: ed::drag_limit(Some(self.radius as f64 * 2.0)),
        });
        let b = self.blend.as_mut().expect("checked above");
        if signed == b.signed {
            return;
        }
        b.moved = true;
        b.typing = None;
        b.signed = signed;
        let (kind, _) = ed::treatment_at(b.positive, signed);
        // At the origin there is no side, so the label holds still rather than flickering at the crossing.
        if !b.neutral() && kind != b.kind {
            b.kind = kind;
            b.range = BlendRange::default();
            b.outcomes.forget();
        }
        self.blend_preview(cx);
    }

    /// Sends what the handle says unless it is a size already refused, which leaves the last one that built on screen.
    fn blend_preview(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.blend.as_mut() else { return };
        if b.edit.as_ref().is_some_and(|e| e.rollback.is_some()) {
            return cx.notify();
        }
        let current = b.current();
        let key = current.as_ref().map(ed::feature_key);
        b.outcomes.refresh(key.as_deref());
        if b.verdict() == Verdict::Refused {
            cx.notify();
            return;
        }
        let doc = match b.doc_with(current.as_ref()) {
            Ok(d) => d,
            Err(e) => return self.say(e, cx),
        };
        self.blend_send(doc, current, cx);
    }

    fn blend_send(&mut self, doc: Doc, preview: Option<Value>, cx: &mut Context<Self>) {
        let (Some(b), Some(session)) = (self.blend.as_mut(), self.session.as_mut()) else { return };
        if session.doc == doc {
            return cx.notify();
        }
        match session.edit(move |d| {
            d.clone_from(&doc);
            Ok(())
        }) {
            Ok(Some(revision)) => {
                b.sent.push((revision, preview));
                self.changes += 1;
            }
            Ok(None) => {}
            Err(e) => self.message = Some(e),
        }
        cx.notify();
    }

    /// The engine's answer for `revision`: what built, what was refused and why. A late refusal of a committed value
    /// puts back the one that built.
    pub(super) fn blend_reply(&mut self, revision: u64, result: Option<&Map<String, Value>>, cx: &mut Context<Self>) {
        // Edge indices are the old mesh's, the cursor's next move finds the hovered edge again.
        self.blend_hover = None;
        if self.blend_rolled_back(revision, cx) {
            return;
        }
        let Some(b) = self.blend.as_mut() else { return };
        b.replied = b.replied.max(revision);
        let Some(sent) = b.sent_at(revision).cloned() else { return };
        // A late answer for the treatment the drag crossed away from says nothing of this one.
        let other = sent.as_ref().and_then(|f| Treatment::of(f.get("type")?.as_str()?)).is_some_and(|k| k != b.kind);
        let refused = !other && self.blend_note(revision, sent, result, cx);
        let Some(b) = self.blend.as_mut() else { return };
        if b.awaiting.is_some() && !ed::enter_waits(b.verdict(), b.sent.last().map(|(r, _)| *r), b.replied) {
            let text = b.awaiting.take();
            self.blend_commit(text, cx);
        }
        let Some(b) = self.blend.as_ref() else { return };
        if b.released && b.sent.last().is_none_or(|(r, _)| *r <= revision) {
            if let Some(why) = b.outcomes.refusal.clone().filter(|_| refused) {
                self.say(why, cx);
            }
            self.blend_record();
            self.blend = None;
        }
        cx.notify();
    }

    /// Notes the reply in the blend's outcomes and holds what last built when it refused. True when it refused.
    fn blend_note(&mut self, revision: u64, sent: Option<Value>, result: Option<&Map<String, Value>>, cx: &mut Context<Self>) -> bool {
        let Some(b) = self.blend.as_mut() else { return false };
        let reply = match (&sent, result) {
            (_, None) => Reply::Failed,
            (None, Some(_)) => Reply::Built,
            (Some(f), Some(r)) => {
                let errors = r.get("featureErrors").and_then(Value::as_array).into_iter().flatten();
                let mine = errors.into_iter().find(|e| e.get("feature_id").and_then(Value::as_str) == Some(b.id.as_str()));
                let size = f.get(b.kind.field()).and_then(Value::as_f64).unwrap_or(0.0);
                b.range = b.range.note(size, mine.is_none());
                match mine {
                    None => Reply::Built,
                    Some(e) => {
                        let kind = Treatment::of(f["type"].as_str().unwrap_or_default()).unwrap_or(b.kind);
                        let code = e.get("code").and_then(Value::as_str);
                        let message = e.get("message").and_then(Value::as_str).unwrap_or_default();
                        Reply::Refused(ed::refusal_reason(kind, b.edges.len(), code, message))
                    }
                }
            }
        };
        let refused = matches!(reply, Reply::Refused(_));
        b.outcomes.note(sent.as_ref(), reply);
        let key = b.current().map(|f| ed::feature_key(&f));
        b.outcomes.refresh(key.as_deref());
        let last = b.sent.last().is_none_or(|(r, _)| *r <= revision);
        if refused && last {
            // Holds the last size that built on screen, as FundaCAD 1's preview hold.
            let shown = b.outcomes.shown.clone();
            if b.released {
                b.signed = b.shown_value().unwrap_or(0.0);
            }
            // A resize refused with nothing of its own on screen keeps the feature as it was.
            let doc = match (&shown, &b.original) {
                (None, Some(_)) => Ok(b.before.clone()),
                _ => b.doc_with(shown.as_ref()),
            };
            if let Ok(doc) = doc {
                self.blend_send(doc, shown, cx);
            }
        }
        refused
    }

    fn blend_record(&mut self) {
        let (Some(b), Some(session)) = (self.blend.as_ref(), self.session.as_ref()) else { return };
        if session.doc != b.before {
            self.undo.record(b.before.clone(), None, b.edit.as_ref().map(|e| e.label.clone()));
        }
        self.blend_hover = None;
    }

    /// Ends a released blend still waiting for its reply, keeping what the document holds now.
    pub(super) fn blend_settle(&mut self) {
        if self.blend.as_ref().is_some_and(|b| b.released) {
            self.blend_record();
            self.blend = None;
        }
    }

    /// Before an undo or redo: a released blend is kept as its own step, an open one is put back as Esc would.
    pub(super) fn blend_before_step(&mut self, cx: &mut Context<Self>) {
        self.blend_settle();
        if let Some(before) = self.blend.as_ref().map(|b| b.before.clone()) {
            self.blend_send(before, None, cx);
            self.blend = None;
        }
        self.blend_hover = None;
    }

    pub(super) fn blend_release(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.blend.as_mut().filter(|b| b.grab.is_some()) else { return };
        b.grab = None;
        if !b.moved && b.edit.is_some() {
            b.typing = Some(String::new());
            return cx.notify();
        }
        if !b.moved && b.original.is_some() {
            self.blend = None;
            return cx.notify();
        }
        if !b.moved && b.original.is_none() {
            // A press that never travelled opens the value box at the usual size.
            b.signed = ed::seed_value(b.kind, ed::value_bounds(Some(self.radius as f64 * 2.0)));
            b.open = true;
            b.typing = Some(String::new());
            self.blend_preview(cx);
            return;
        }
        self.blend_commit(None, cx);
    }

    /// A click away from the open box, which takes typed text as Enter would, as FundaCAD 1's commit read the box.
    pub(super) fn blend_away(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.blend.as_ref().filter(|b| b.open) else { return };
        if b.awaiting.is_some() || b.typing.as_deref().is_some_and(|t| !t.trim().is_empty()) {
            self.blend_enter(cx);
        } else {
            self.blend_commit(None, cx);
        }
    }

    /// Enter on the box: a typed value nobody has answered yet waits for the engine before it commits.
    fn blend_enter(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.blend.as_mut() else { return };
        if b.awaiting.is_some() {
            return;
        }
        let text = b.typing.take().unwrap_or_default();
        if !text.trim().is_empty() {
            match crate::inspector::parse(crate::inspector::Kind::Length, &text) {
                Ok(v) => {
                    b.signed = v.max(ed::MIN_EDGE_VALUE) * if b.kind == b.positive { 1.0 } else { -1.0 };
                    b.moved = true;
                }
                Err(e) => {
                    b.typing = Some(text);
                    return self.say(e, cx);
                }
            }
        }
        if b.grab.is_some() {
            return cx.notify();
        }
        self.blend_preview(cx);
        let Some(b) = self.blend.as_mut() else { return };
        if ed::enter_waits(b.verdict(), b.sent.last().map(|(r, _)| *r), b.replied) {
            b.awaiting = Some(text);
            return cx.notify();
        }
        self.blend_commit(Some(text), cx);
    }

    /// Lets go of the value on the handle, `typed` holding the box's text when it came from the keyboard.
    pub(super) fn blend_commit(&mut self, typed: Option<String>, cx: &mut Context<Self>) {
        let Some(b) = self.blend.as_mut() else { return };
        let settled = b.current().is_some_and(|f| b.outcomes.settled(&ed::feature_key(&f)));
        let decision = ed::commit_decision(b.value(), b.verdict(), settled, b.shown_value(), typed.is_some());
        match decision {
            Commit::Stay => {
                b.awaiting = None;
                b.typing = typed;
                return cx.notify();
            }
            Commit::Cancel => {
                let before = b.before.clone();
                self.blend_send(before, None, cx);
                self.blend = None;
            }
            Commit::Commit { value, unverified } => {
                let origin = b.neutral() && b.original.is_some();
                b.signed = value;
                if let Some(why) = b.refusal() {
                    let before = b.before.clone();
                    self.blend_send(before, None, cx);
                    self.blend = None;
                    return self.say(why, cx);
                }
                if origin || b.unchanged() {
                    // Let go on the origin of a resize, or on the size an edit opened with, keeps the feature as it was.
                    let before = b.before.clone();
                    self.blend_send(before, None, cx);
                    self.blend = None;
                    return cx.notify();
                }
                b.open = false;
                b.typing = None;
                let current = b.current();
                if let Ok(doc) = b.doc_with(current.as_ref()) {
                    self.blend_send(doc, current, cx);
                }
                let b = self.blend.as_mut().expect("still there");
                let waiting = b.sent.last().is_some_and(|(r, _)| *r > b.replied);
                if unverified && waiting && !b.neutral() {
                    b.released = true;
                } else {
                    self.blend_record();
                    self.blend = None;
                }
            }
        }
        cx.notify();
    }

    pub(super) fn blend_typing(&self) -> bool {
        self.blend.as_ref().is_some_and(|b| b.live() && b.typing.is_some())
    }

    pub(super) fn blend_open(&self) -> bool {
        self.blend.as_ref().is_some_and(|b| b.open)
    }

    /// The value box's keys: digits, Enter, Tab to switch treatment, Esc to put the model back. True when taken.
    pub(super) fn blend_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let Some(b) = self.blend.as_mut().filter(|b| b.live()) else { return false };
        let bounds = ed::value_bounds(Some(self.radius as f64 * 2.0));
        match event.keystroke.key.as_str() {
            "enter" => self.blend_enter(cx),
            "tab" => {
                b.awaiting = None;
                let (kind, value) = ed::switch_treatment(b.kind, if b.neutral() { ed::seed_value(b.kind.other(), bounds) } else { b.value() }, bounds);
                b.kind = kind;
                b.positive = kind;
                b.signed = value;
                // Tab while held lets go of the handle and leaves the value to the box.
                if b.grab.is_some() {
                    b.grab = None;
                    b.moved = true;
                    b.open = true;
                }
                b.range = BlendRange::default();
                b.outcomes.forget();
                self.blend_preview(cx);
            }
            "escape" => {
                let before = b.before.clone();
                self.blend_send(before, None, cx);
                self.blend = None;
            }
            "backspace" => {
                b.resume_typing();
                b.typing.get_or_insert_with(String::new).pop();
            }
            _ => {
                let Some(ch) = event.keystroke.key_char.as_deref() else { return true };
                if ch.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '+' | '-' | '*' | '/' | ' ')) {
                    b.resume_typing();
                    b.typing.get_or_insert_with(String::new).push_str(ch);
                }
            }
        }
        cx.notify();
        true
    }

    /// Forgets a blend when the document is replaced under it.
    pub(super) fn blend_drop(&mut self) {
        self.blend = None;
        self.blend_ask = None;
        self.blend_hover = None;
    }

    pub(super) fn blend_status(&self) -> Option<String> {
        if let Some(b) = &self.blend {
            if b.edit.as_ref().is_some_and(|e| e.rollback.is_some()) {
                return Some(format!("rolling back to before the {}", b.kind.label().to_lowercase()));
            }
            if let Some(why) = &b.outcomes.refusal {
                return Some(why.clone());
            }
            return Some(match b.neutral() {
                true => "on the origin no feature is made, drag one way to fillet, the other to chamfer".into(),
                false => format!("{} {}", b.kind.label(), ed::fmt_length(b.value())),
            });
        }
        self.blend_target().map(|_| "drag the handle: one way fillets, the other chamfers".into())
    }

    /// The handle's arrow and knob, over the model.
    pub(super) fn paint_blend(&self, bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
        let (anchor, axis, refused) = match (&self.blend, self.blend_target()) {
            (Some(b), _) => (b.anchor, b.axis, b.outcomes.refusal.is_some()),
            (None, Some(t)) => (t.anchor, self.handle_axis(t.anchor, t.tangent), false),
            (None, None) => return,
        };
        if let Some(e) = self.blend.as_ref().and_then(|b| b.edit.as_ref()) {
            self.paint_ghost(&e.ghost, bounds, color.opacity(0.55), window);
        }
        let Some((a, k)) = self.handle_px(anchor, axis) else { return };
        let color = if refused { hsla(0.0, 0.75, 0.55, 1.0) } else { color };
        let at = |v: Vec2| point(bounds.origin.x + px(v.x), bounds.origin.y + px(v.y));
        let mut shaft = PathBuilder::stroke(px(2.0));
        shaft.move_to(at(a));
        shaft.line_to(at(k));
        if let Ok(p) = shaft.build() {
            window.paint_path(p, color);
        }
        let mut knob = PathBuilder::fill();
        for i in 0..=20 {
            let t = i as f32 / 20.0 * std::f32::consts::TAU;
            let p = at(k + Vec2::new(t.cos(), t.sin()) * KNOB_PX);
            if i == 0 { knob.move_to(p) } else { knob.line_to(p) }
        }
        if let Ok(p) = knob.build() {
            window.paint_path(p, color);
        }
    }

    /// The sharp edges a blend opened from History rounds, as FundaCAD 1's BlendEditGhost guide.
    fn paint_ghost(&self, lines: &[Vec<Vec3>], bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
        let at = |v: Vec2| point(bounds.origin.x + px(v.x), bounds.origin.y + px(v.y));
        for line in lines {
            let mut path = PathBuilder::stroke(px(1.6));
            let mut started = false;
            for p in line {
                match (self.project(*p), started) {
                    (Some(s), true) => path.line_to(at(s)),
                    (Some(s), false) => {
                        path.move_to(at(s));
                        started = true;
                    }
                    (None, _) => started = false,
                }
            }
            if let Ok(p) = path.build() {
                window.paint_path(p, color);
            }
        }
    }

    /// The heads-up R or D box beside the knob while a blend is dragged or open.
    pub(super) fn blend_layer(&self) -> Option<AnyElement> {
        let b = self.blend.as_ref()?;
        let (_, k) = self.handle_px(b.anchor, b.axis)?;
        let value = match &b.typing {
            Some(t) if t.is_empty() && b.edit.is_some() => format!("{}|", ed::fmt_length(b.value())),
            Some(t) if !t.is_empty() || b.open => format!("{t}|"),
            _ if b.neutral() => "0".into(),
            _ => ed::fmt_length(b.value()),
        };
        let refusal = b.outcomes.refusal.clone();
        let edge = if refusal.is_some() { 0xe23b3b } else { 0x7aa2ff };
        let mut col = div().absolute().left(px(k.x + 14.0)).top(px(k.y - 10.0)).flex().flex_col().gap_1();
        col = col.child(
            div()
                .min_w(px(64.))
                .px_1()
                .rounded_sm()
                .bg(rgba(0x15131cd9))
                .border_1()
                .border_color(rgb(edge))
                .text_size(px(12.))
                .text_color(rgb(0xf2f0f7))
                .child(format!("{} {value}", b.kind.letter())),
        );
        if let Some(why) = refusal {
            col = col.child(
                div().max_w(px(260.)).px_1().rounded_sm().bg(rgba(0x15131cd9)).text_size(px(11.)).text_color(rgb(0xff8a8a)).child(why),
            );
        }
        Some(col.into_any_element())
    }
}

fn tr_many(key: &str, count: usize) -> String {
    let cap = ed::EDGE_CAP;
    tr!(key, count = count, cap = cap, kind = "fillet", label = Treatment::Fillet.label())
}
