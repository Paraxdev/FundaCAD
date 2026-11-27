//! Putting a part on the model where it is dropped or dragged to, as FundaCAD 1's fastener insert: on a flat face it
//! stands on the point under the cursor along the face's normal, in a round hole it sits on the hole's rim along its
//! axis. A plugin hands over a `Carried` to drag from its panel, and registers a mover for parts already placed.

#[cfg(test)]
mod tests;

use std::rc::Rc;
use std::sync::Arc;

use fundacad_client::Doc;
use glam::{DVec3, Quat, Vec2, Vec3};
use gpui::*;
use serde_json::{json, Value};

use super::pick::{self, Hit};
use super::scene::{Body, SceneBody};
use super::Viewport;

/// Where a part's local origin lands and which way its local Z points, the `placement` of the engine's generateShape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub origin: Vec3,
    pub z: Vec3,
}

impl Placement {
    pub fn json(&self) -> Value {
        let r = |v: Vec3| v.to_array().map(|c| ((c as f64) * 1e4).round() / 1e4 + 0.0);
        json!({"origin": r(self.origin), "zAxis": r(self.z)})
    }

    pub fn from_json(v: &Value) -> Option<Self> {
        let v3 = |k: &str| {
            let a = v.get(k)?.as_array()?;
            let c: Vec<f32> = a.iter().filter_map(|c| c.as_f64().map(|c| c as f32)).collect();
            (c.len() == 3).then(|| Vec3::from_slice(&c))
        };
        Some(Self { origin: v3("origin")?, z: v3("zAxis")?.try_normalize()? })
    }
}

/// What a drop or a drag does with where it landed, None when it landed on no face.
pub type Land = Rc<dyn Fn(Option<Placement>, &mut Window, &mut App)>;

/// The payload of a drag from a panel onto the view.
#[derive(Clone)]
pub struct Carried {
    pub label: SharedString,
    pub land: Land,
}

/// A body whose faces `owners` made, to what dragging it does and where it stands now (when known, for the ghost that
/// follows the cursor), None for a body the mover does not move.
type Mover = Rc<dyn Fn(&Doc, &[String], &mut App) -> Option<(Land, Option<Placement>)>>;

#[derive(Default)]
struct Movers(Vec<Mover>);
impl Global for Movers {}

pub fn add_mover(cx: &mut App, f: impl Fn(&Doc, &[String], &mut App) -> Option<(Land, Option<Placement>)> + 'static) {
    cx.default_global::<Movers>().0.push(Rc::new(f));
}

/// A placed part being dragged: its scene body, left out of the pick, and where the cursor is. `shown` is where a
/// drag would land now and what it snapped to, drawn as a marker.
#[derive(Default)]
pub struct Carry {
    held: Option<Held>,
    shown: Option<(Placement, Option<Snap>)>,
}

struct Held {
    body: usize,
    at: Point<Pixels>,
    land: Land,
    /// Where the part stands in the built model, None when its mover does not know, then no ghost is drawn.
    from: Option<Placement>,
    /// The built body, and the moved copy of it the scene shows in its place.
    original: Option<Arc<Body>>,
    ghost: Option<Arc<Body>>,
}

/// What a landing point snapped to, the stronger last, as FundaCAD 1's pointSnap ranked them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Snap {
    Centre,
    Middle,
    Corner,
}

/// How near the cursor a snap point must be on screen, FundaCAD 1's POINT_SNAP_PX.
pub const SNAP_PX: f32 = 10.0;

/// How far a normal may lean off the plane square to a cylinder's axis, and a fit off its circle, as a share of radius.
const ALONG: f32 = 0.05;
const ROUND: f32 = 0.02;

/// Where a part dropped on `hit` lands, `view` the direction of the ray that found it.
pub fn placement(body: &SceneBody, hit: &Hit, view: Vec3) -> Placement {
    hole(body, hit.face, view).unwrap_or(Placement { origin: hit.point, z: hit.normal })
}

/// On a round hole's rim, the end that faces the viewer, along its axis out of the hole.
/// None for a flat face, a boss, a cone, or a curve that turns less than half way round, like a fillet.
pub fn hole(body: &SceneBody, face: u32, view: Vec3) -> Option<Placement> {
    let verts: Vec<_> = body.vertices.iter().filter(|v| v.face == face).collect();
    let n0 = verts.first()?.normal();
    let n1 = verts.iter().map(|v| v.normal()).max_by(|a, b| n0.cross(*a).length().total_cmp(&n0.cross(*b).length()))?;
    let axis = n0.cross(n1).try_normalize().filter(|_| n0.cross(n1).length() > 0.2)?;
    if verts.iter().any(|v| v.normal().dot(axis).abs() > ALONG) {
        return None;
    }
    let u = (n0 - axis * n0.dot(axis)).normalize();
    let w = axis.cross(u);
    let flat: Vec<Vec2> = verts.iter().map(|v| Vec2::new(v.position().dot(u), v.position().dot(w))).collect();
    let (c, r) = circle(&flat)?;
    if flat.iter().any(|p| (p.distance(c) - r).abs() > r * ROUND) || !half_round(&flat, c) {
        return None;
    }
    let centre = u * c.x + w * c.y;
    let inward =
        verts.iter().map(|v| v.normal().dot(centre - (v.position() - axis * v.position().dot(axis)))).sum::<f32>();
    if inward <= 0.0 {
        return None;
    }
    let z = if axis.dot(-view) >= 0.0 { axis } else { -axis };
    let top = verts.iter().map(|v| v.position().dot(z)).fold(f32::MIN, f32::max);
    Some(Placement { origin: centre + z * top, z })
}

/// On a round edge, like a hole's rim, at its centre along its axis toward the viewer. None for a straight edge, one
/// off a plane, or an arc that turns less than half way round.
pub fn rim(line: &[Vec3], view: Vec3) -> Option<Placement> {
    let mean = line.iter().copied().sum::<Vec3>() / line.len().max(1) as f32;
    let turn: Vec3 = line.windows(2).map(|w| (w[0] - mean).cross(w[1] - mean)).sum();
    let axis = turn.try_normalize()?;
    let u = axis.any_orthonormal_vector();
    let w = axis.cross(u);
    let flat: Vec<Vec2> = line.iter().map(|p| Vec2::new((*p - mean).dot(u), (*p - mean).dot(w))).collect();
    let (c, r) = circle(&flat)?;
    let off = |p: &Vec3| (*p - mean).dot(axis).abs() > r * ROUND;
    if line.iter().any(off) || flat.iter().any(|p| (p.distance(c) - r).abs() > r * ROUND) || !half_round(&flat, c) {
        return None;
    }
    let z = if axis.dot(-view) >= 0.0 { axis } else { -axis };
    Some(Placement { origin: mean + u * c.x + w * c.y, z })
}

/// The points a part dropped on flat `face` may snap to: the ends and middles of the edges on its plane and its centre.
/// Empty for a face that is not flat.
pub fn snaps(body: &SceneBody, face: u32) -> Vec<(Vec3, Snap)> {
    let tris: Vec<[Vec3; 3]> = body
        .indices
        .chunks_exact(3)
        .filter(|t| body.vertices[t[0] as usize].face == face)
        .map(|t| [0, 1, 2].map(|k| body.vertices[t[k] as usize].position()))
        .collect();
    let Some(n) = body.vertices.iter().find(|v| v.face == face).map(|v| v.normal()) else { return Vec::new() };
    if body.vertices.iter().any(|v| v.face == face && v.normal().dot(n) < 0.999) {
        return Vec::new();
    }
    let area = |t: &[Vec3; 3]| (t[1] - t[0]).cross(t[2] - t[0]).length();
    let total: f32 = tris.iter().map(area).sum();
    if total <= 0.0 {
        return Vec::new();
    }
    let centre = tris.iter().map(|t| (t[0] + t[1] + t[2]) / 3.0 * area(t)).sum::<Vec3>() / total;
    let extent = tris.iter().flatten().map(|p| p.distance(centre)).fold(1.0, f32::max);
    let on = |p: &Vec3| (*p - centre).dot(n).abs() < extent * 1e-4;
    let mut out = vec![(centre, Snap::Centre)];
    for line in super::edges::polylines(&body.source) {
        let ends = line.first().zip(line.last()).map(|(a, b)| vec![*a, *b]).unwrap_or_default();
        out.extend(ends.into_iter().filter(&on).map(|p| (p, Snap::Corner)));
        out.extend(midpoint(&line).filter(&on).map(|p| (p, Snap::Middle)));
    }
    out
}

/// Half way along `line` by length, so a curved edge's middle is on the curve.
fn midpoint(line: &[Vec3]) -> Option<Vec3> {
    let total: f32 = line.windows(2).map(|w| w[0].distance(w[1])).sum();
    if total <= 0.0 {
        return None;
    }
    let mut run = 0.0;
    for w in line.windows(2) {
        let seg = w[0].distance(w[1]);
        if run + seg >= total / 2.0 {
            return Some(w[0].lerp(w[1], if seg > 0.0 { (total / 2.0 - run) / seg } else { 0.0 }));
        }
        run += seg;
    }
    line.last().copied()
}

/// The strongest of `points` that `screen` puts within `reach` of `at`, the nearest of those equally strong.
pub fn nearest(
    points: &[(Vec3, Snap)],
    screen: impl Fn(Vec3) -> Option<Vec2>,
    at: Vec2,
    reach: f32,
) -> Option<(Vec3, Snap)> {
    points
        .iter()
        .filter_map(|&(p, k)| Some((p, k, screen(p)?.distance(at))))
        .filter(|&(_, _, d)| d <= reach)
        .min_by(|a, b| b.1.cmp(&a.1).then(a.2.total_cmp(&b.2)))
        .map(|(p, k, _)| (p, k))
}

/// `body` moved rigidly from standing at `from` to standing at `to`, its local Z turned the shortest way.
pub fn moved(body: &Body, from: Placement, to: Placement) -> Body {
    let q = Quat::from_rotation_arc(from.z.normalize(), to.z.normalize());
    let at = |p: &mut [f32]| p.copy_from_slice(&(to.origin + q * (Vec3::from_slice(p) - from.origin)).to_array());
    let mut out = body.clone();
    out.positions.chunks_exact_mut(3).for_each(at);
    out.edges.points.chunks_exact_mut(3).for_each(at);
    if let Some(n) = out.normals.as_mut() {
        n.chunks_exact_mut(3).for_each(|n| n.copy_from_slice(&(q * Vec3::from_slice(n)).to_array()));
    }
    out
}

/// The least squares circle through `points`, as a centre and a radius.
pub fn circle(points: &[Vec2]) -> Option<(Vec2, f32)> {
    if points.len() < 3 {
        return None;
    }
    let mean = points.iter().copied().sum::<Vec2>() / points.len() as f32;
    let (mut m, mut b) = (glam::DMat3::ZERO, DVec3::ZERO);
    for p in points {
        let d = (*p - mean).as_dvec2();
        let row = DVec3::new(d.x, d.y, 1.0);
        m += glam::DMat3::from_cols(row * row.x, row * row.y, row * row.z);
        b += row * d.length_squared();
    }
    if m.determinant().abs() < 1e-12 {
        return None;
    }
    let s = m.inverse() * b;
    let c = glam::DVec2::new(s.x / 2.0, s.y / 2.0);
    let r2 = s.z + c.length_squared();
    (r2 > 0.0).then(|| (mean + c.as_vec2(), r2.sqrt() as f32))
}

/// Whether `points` go at least half way round `c`, so the gap they leave is no wider than a half turn.
fn half_round(points: &[Vec2], c: Vec2) -> bool {
    let mut a: Vec<f32> = points.iter().map(|p| (p.y - c.y).atan2(p.x - c.x)).collect();
    a.sort_by(f32::total_cmp);
    let wrap = a.first().zip(a.last()).map_or(0.0, |(f, l)| f + std::f32::consts::TAU - l);
    let gap = a.windows(2).map(|w| w[1] - w[0]).fold(wrap, f32::max);
    gap <= std::f32::consts::PI * 1.06
}

impl Viewport {
    /// Where a part dropped at `position` lands and what it snapped to there, the scene body `skip` left out.
    pub(super) fn placement_at(
        &self,
        position: Point<Pixels>,
        skip: Option<usize>,
    ) -> Option<(Placement, Option<Snap>)> {
        let (origin, dir) = self.ray_at(position);
        let hit = pick::pick_where(&self.scene, origin, dir, |b| Some(b) != skip, |p| !self.clipped(p))?;
        let body = &self.scene.bodies[hit.body];
        if let Some(p) = hole(body, hit.face, dir) {
            return Some((p, None));
        }
        let local = position - self.bounds.origin;
        let at = Vec2::new(local.x.as_f32(), local.y.as_f32());
        let snapped = nearest(&snaps(body, hit.face), self.screen(), at, SNAP_PX);
        let origin = snapped.map_or(hit.point, |s| s.0);
        Some((Placement { origin, z: hit.normal }, snapped.map(|s| s.1)))
    }

    /// Shows the dragged part's built mesh moved to `to` in place of the built one, the built one again for None.
    fn ghost(&mut self, to: Option<Placement>) {
        let Some(h) = self.carry.held.as_mut() else { return };
        let (Some(from), Some(shown)) = (h.from, self.scene.bodies.get(h.body)) else { return };
        if h.ghost.as_ref().is_none_or(|g| !Arc::ptr_eq(g, &shown.source)) {
            h.original = Some(shown.source.clone());
        }
        let Some(original) = h.original.clone() else { return };
        let body = to.map_or_else(|| original.clone(), |to| Arc::new(moved(&original, from, to)));
        h.ghost = Some(body.clone());
        self.scene.bodies[h.body] = SceneBody::new(body);
        self.scene.revision += 1;
    }

    /// Puts the built model back in place of a ghost a failed move left showing.
    pub fn settle(&mut self, cx: &mut Context<Self>) {
        self.show_built();
        cx.notify();
    }

    /// Where a part inserted now lands: on the one selected face where it was clicked, or in the one selected round
    /// edge, None for any other selection.
    pub fn selected_placement(&self) -> Option<Placement> {
        use crate::selection::Pick;
        let view = self.camera.target - self.camera.eye();
        match self.picking.selection.picks.as_slice() {
            [Pick::Face { body, face, point, normal }] => {
                let b = &self.scene.bodies[self.scene.body_index(body)?];
                let (point, normal) = (Vec3::from(*point), Vec3::from(*normal));
                Some(placement(b, &Hit { body: 0, face: *face, point, normal }, view))
            }
            [Pick::Edge { body, edge, .. }] => {
                let b = &self.scene.bodies[self.scene.body_index(body)?];
                rim(super::edges::polylines(&b.source).get(*edge as usize)?, view)
            }
            _ => None,
        }
    }

    pub(super) fn carry_cancel(&mut self, cx: &mut Context<Self>) -> bool {
        let on = self.carry.held.take().is_some();
        if on {
            self.carry.shown = None;
            self.settle(cx);
        }
        on
    }

    pub(super) fn land(&mut self, carried: &Carried, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.placement_at(window.mouse_position(), None).map(|s| s.0);
        self.carry.shown = None;
        let land = carried.land.clone();
        window.defer(cx, move |w, cx| land(at, w, cx));
    }

    /// Starts dragging a placed part once a press on it moves far enough. True while a drag is on.
    pub(super) fn carry_move(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) -> bool {
        if self.carry.held.is_some() && e.pressed_button != Some(MouseButton::Left) {
            return self.carry_cancel(cx);
        }
        if let Some(h) = self.carry.held.as_mut() {
            h.at = e.position;
            let body = h.body;
            let shown = self.placement_at(e.position, Some(body));
            if shown != self.carry.shown {
                self.carry.shown = shown;
                self.ghost(shown.map(|s| s.0));
                cx.notify();
            }
            return true;
        }
        let Some((from, _)) = self.picking.pressed.filter(|_| e.pressed_button == Some(MouseButton::Left)) else {
            return false;
        };
        if !Self::dragged(from, e.position) || self.tool.is_some() || self.push.is_some() {
            return false;
        }
        let (origin, dir) = self.ray_at(from);
        let Some(hit) = self.pick_ray(origin, dir) else { return false };
        let Some(doc) = self.session.as_ref().map(|s| s.doc.clone()) else { return false };
        let owners: Vec<String> = self.scene.bodies[hit.body].source.face_owners.iter().flatten().cloned().collect();
        let movers = cx.try_global::<Movers>().map(|m| m.0.clone()).unwrap_or_default();
        let Some((land, from)) = movers.iter().find_map(|m| m(&doc, &owners, cx)) else { return false };
        self.picking.pressed = None;
        (self.hover, self.picking.hover_edge, self.blend_hover) = (None, None, None);
        self.carry.held = Some(Held { body: hit.body, at: e.position, land, from, original: None, ghost: None });
        true
    }

    /// Ends a drag of a placed part where the cursor is. True when one was on.
    pub(super) fn carry_release(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(Held { body, at, land, .. }) = self.carry.held.take() else { return false };
        self.carry.shown = None;
        let to = self.placement_at(at, Some(body)).map(|s| s.0);
        window.defer(cx, move |w, cx| land(to, w, cx));
        true
    }

    pub(super) fn drag_over(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let shown = self.bounds.contains(&position).then(|| self.placement_at(position, None)).flatten();
        if shown != self.carry.shown {
            self.carry.shown = shown;
            cx.notify();
        }
    }

    /// The marker of where a drag would land: a dot on the seat and a stroke out along the part's axis, ringed by a
    /// square on a corner, a diamond on an edge middle and a circle on a face centre it snapped to.
    pub(super) fn paint_carry(&self, bounds: Bounds<Pixels>, dragging: bool, color: Hsla, window: &mut Window) {
        let Some((p, snap)) = self.carry.shown.filter(|_| dragging || self.carry.held.is_some()) else { return };
        let project = self.screen();
        let at = |v: Vec3| project(v).map(|s| point(bounds.origin.x + px(s.x), bounds.origin.y + px(s.y)));
        let (Some(a), Some(b)) = (at(p.origin), at(p.origin + p.z * self.radius * 0.15)) else { return };
        let mut line = PathBuilder::stroke(px(2.5));
        line.move_to(a);
        line.line_to(b);
        if let Ok(path) = line.build() {
            window.paint_path(path, color);
        }
        let mut dot = PathBuilder::fill();
        for k in 0..12 {
            let t = k as f32 / 12.0 * std::f32::consts::TAU;
            let q = point(a.x + px(5.0 * t.cos()), a.y + px(5.0 * t.sin()));
            if k == 0 {
                dot.move_to(q);
            } else {
                dot.line_to(q);
            }
        }
        dot.close();
        if let Ok(path) = dot.build() {
            window.paint_path(path, color);
        }
        let Some(snap) = snap else { return };
        let (sides, turn, r) = match snap {
            Snap::Corner => (4, std::f32::consts::FRAC_PI_4, 11.0),
            Snap::Middle => (4, 0.0, 11.0),
            Snap::Centre => (20, 0.0, 9.0),
        };
        let mut ring = PathBuilder::stroke(px(1.5));
        for k in 0..=sides {
            let t = turn + k as f32 / sides as f32 * std::f32::consts::TAU;
            let q = point(a.x + px(r * t.cos()), a.y + px(r * t.sin()));
            if k == 0 {
                ring.move_to(q);
            } else {
                ring.line_to(q);
            }
        }
        if let Ok(path) = ring.build() {
            window.paint_path(path, color);
        }
    }
}
