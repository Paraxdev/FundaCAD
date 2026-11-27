//! Putting a part on the model where it is dropped or dragged to, as FundaCAD 1's fastener insert: on a flat face it
//! stands on the point under the cursor along the face's normal, in a round hole it sits on the hole's rim along its
//! axis. A plugin hands over a `Carried` to drag from its panel, and registers a mover for parts already placed.

#[cfg(test)]
mod tests;

use std::rc::Rc;

use fundacad_client::Doc;
use glam::{DVec3, Vec2, Vec3};
use gpui::*;
use serde_json::{json, Value};

use super::pick::{self, Hit};
use super::scene::SceneBody;
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
}

/// What a drop or a drag does with where it landed, None when it landed on no face.
pub type Land = Rc<dyn Fn(Option<Placement>, &mut Window, &mut App)>;

/// The payload of a drag from a panel onto the view.
#[derive(Clone)]
pub struct Carried {
    pub label: SharedString,
    pub land: Land,
}

/// A body whose faces `owners` made, to what dragging it does, None for a body the mover does not move.
type Mover = Rc<dyn Fn(&Doc, &[String], &mut App) -> Option<Land>>;

#[derive(Default)]
struct Movers(Vec<Mover>);
impl Global for Movers {}

pub fn add_mover(cx: &mut App, f: impl Fn(&Doc, &[String], &mut App) -> Option<Land> + 'static) {
    cx.default_global::<Movers>().0.push(Rc::new(f));
}

/// A placed part being dragged: its scene body, left out of the pick, and where the cursor is. `shown` is where a
/// drag would land now, drawn as a marker.
#[derive(Default)]
pub struct Carry {
    held: Option<(usize, Point<Pixels>, Land)>,
    shown: Option<Placement>,
}

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
    /// Where a part dropped at `position` lands, the scene body `skip` left out.
    pub(super) fn placement_at(&self, position: Point<Pixels>, skip: Option<usize>) -> Option<Placement> {
        let (origin, dir) = self.ray_at(position);
        let hit = pick::pick_where(&self.scene, origin, dir, |b| Some(b) != skip, |p| !self.clipped(p))?;
        Some(placement(&self.scene.bodies[hit.body], &hit, dir))
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
            cx.notify();
        }
        on
    }

    pub(super) fn land(&mut self, carried: &Carried, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.placement_at(window.mouse_position(), None);
        self.carry.shown = None;
        let land = carried.land.clone();
        window.defer(cx, move |w, cx| land(at, w, cx));
    }

    /// Starts dragging a placed part once a press on it moves far enough. True while a drag is on.
    pub(super) fn carry_move(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) -> bool {
        if self.carry.held.is_some() && e.pressed_button != Some(MouseButton::Left) {
            return self.carry_cancel(cx);
        }
        if let Some((body, at, _)) = self.carry.held.as_mut() {
            *at = e.position;
            let (body, at) = (*body, *at);
            self.carry.shown = self.placement_at(at, Some(body));
            cx.notify();
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
        let Some(land) = movers.iter().find_map(|m| m(&doc, &owners, cx)) else { return false };
        self.picking.pressed = None;
        self.carry.held = Some((hit.body, e.position, land));
        true
    }

    /// Ends a drag of a placed part where the cursor is. True when one was on.
    pub(super) fn carry_release(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((body, at, land)) = self.carry.held.take() else { return false };
        self.carry.shown = None;
        let to = self.placement_at(at, Some(body));
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

    /// The marker of where a drag would land: a dot on the seat and a stroke out along the part's axis.
    pub(super) fn paint_carry(&self, bounds: Bounds<Pixels>, dragging: bool, color: Hsla, window: &mut Window) {
        let Some(p) = self.carry.shown.filter(|_| dragging || self.carry.held.is_some()) else { return };
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
    }
}
