//! Drag handles over the view for a running Move or pattern: arrows slide a move or set a pattern's spacing, Move's
//! rings turn it, a circular pattern's arrows choose the axis and sweep its angle.

#[cfg(test)]
mod tests;

use glam::{DQuat, DVec3, EulerRot, Vec2, Vec3};
use gpui::{point, px, Context, Hsla, MouseMoveEvent, PathBuilder, Pixels, Point, Window};
use serde_json::{json, Value};

use super::Viewport;
use crate::tools;

/// In screen pixels, as FundaCAD 1's transform gizmo.
const ARROW: f32 = 68.0;
const HEAD: f32 = 14.0;
const RING: f32 = 46.0;
const GRAB: f32 = 7.0;
const RING_STEPS: usize = 48;
const AXES: [Vec3; 3] = [Vec3::X, Vec3::Y, Vec3::Z];
const NAMES: [&str; 3] = ["X", "Y", "Z"];
/// Degrees a turn snaps to, Shift makes it 1.
const TURN_STEP: f64 = 15.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Move,
    Linear,
    Rect,
    Circular,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Handle {
    Arrow(usize),
    Ring(usize),
}

#[derive(Default)]
pub struct Gizmo {
    key: String,
    pivot: Vec3,
    hover: Option<Handle>,
    drag: Option<Drag>,
}

struct Drag {
    handle: Handle,
    start: Value,
    at: Vec3,
    last: f64,
    travel: f64,
}

/// None too when a value the handles drag is bound to a parameter, a drag would write a number over the name.
pub fn kind(f: &Value) -> Option<Kind> {
    let (kind, keys): (Kind, &[&str]) = match f.get("type")?.as_str()? {
        "move" | "duplicate" => (Kind::Move, &["dx", "dy", "dz", "rx", "ry", "rz"]),
        "patternLinear" => (Kind::Linear, &["spacing"]),
        "patternRect" => (Kind::Rect, &["spacingX", "spacingY"]),
        "patternCircular" => (Kind::Circular, &["angle"]),
        _ => return None,
    };
    let bound = keys.iter().any(|k| f.get(*k).is_some_and(|v| !v.is_null() && !v.is_number()));
    (!bound).then_some(kind)
}

/// A linear pattern's arrow for another axis turns the pattern to it, one body length apart along it as it opens.
pub fn linear_axis(f: &Value, k: usize, extent: Option<([f32; 3], [f32; 3])>) -> Value {
    let mut out = f.clone();
    if f.get("axis").and_then(Value::as_str) == Some(NAMES[k]) {
        return out;
    }
    let span = extent.map(|(lo, hi)| clean(f64::from(hi[k] - lo[k]))).filter(|s| *s > 1e-6);
    out["axis"] = json!(NAMES[k]);
    out["spacing"] = json!(span.unwrap_or(20.0));
    out
}

pub fn handles(kind: Kind) -> Vec<Handle> {
    let arrows = if kind == Kind::Rect { 2 } else { 3 };
    let mut out: Vec<Handle> = (0..arrows).map(Handle::Arrow).collect();
    if kind == Kind::Move {
        out.extend((0..3).map(Handle::Ring));
    }
    out
}

fn num(f: &Value, key: &str) -> f64 {
    f.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn clean(v: f64) -> f64 {
    (v * 1e4).round() / 1e4 + 0.0
}

/// A move's turn and how far its pivot travels. The kernel turns about the world origin (Rx Ry Rz) and then
/// translates, so a turn about `pivot` carries pivot - R pivot in its d.
pub fn decompose(f: &Value, pivot: DVec3) -> (DQuat, DVec3) {
    let r = |k| num(f, k).to_radians();
    let rot = DQuat::from_euler(EulerRot::XYZ, r("rx"), r("ry"), r("rz"));
    let d = DVec3::new(num(f, "dx"), num(f, "dy"), num(f, "dz"));
    (rot, d + rot * pivot - pivot)
}

pub fn compose(f: &mut Value, pivot: DVec3, rot: DQuat, travel: DVec3) {
    let (x, y, z) = rot.to_euler(EulerRot::XYZ);
    let d = travel + pivot - rot * pivot;
    for (k, v) in [("dx", d.x), ("dy", d.y), ("dz", d.z)] {
        f[k] = json!(clean(v));
    }
    for (k, v) in [("rx", x), ("ry", y), ("rz", z)] {
        f[k] = json!(clean(v.to_degrees()));
    }
}

/// A round drag step about ten pixels long, a tenth of it with Shift.
pub fn step(world_per_px: f32, fine: bool) -> f64 {
    let raw = (world_per_px as f64 * 10.0).max(1e-6);
    let tens = 10f64.powf(raw.log10().floor());
    let nice = [1.0, 2.0, 5.0, 10.0].into_iter().map(|m| m * tens).find(|s| *s >= raw * 0.999).unwrap_or(raw);
    if fine {
        nice / 10.0
    } else {
        nice
    }
}

fn snap(v: f64, step: f64) -> f64 {
    clean((v / step).round() * step)
}

/// The line a circular pattern turns about, None when it follows a picked edge.
pub fn turn_line(f: &Value) -> Option<(Vec3, Vec3)> {
    if f.get("axisRef").is_some() {
        return None;
    }
    match f.get("axis")? {
        Value::String(n) => NAMES.iter().position(|x| x == n).map(|k| (Vec3::ZERO, AXES[k])),
        Value::Object(o) => {
            let v = |k: &str| -> Option<Vec3> {
                let a: Vec<f32> = o.get(k)?.as_array()?.iter().filter_map(|x| x.as_f64().map(|x| x as f32)).collect();
                (a.len() == 3).then(|| Vec3::new(a[0], a[1], a[2]))
            };
            Some((v("origin")?, v("dir")?.try_normalize()?))
        }
        _ => None,
    }
}

/// Where the handles sit: on the moved pivot for a move, on the turn line beside the sources for a circular pattern.
pub fn anchor(kind: Kind, f: &Value, pivot: Vec3) -> Vec3 {
    match kind {
        Kind::Move => (pivot.as_dvec3() + decompose(f, pivot.as_dvec3()).1).as_vec3(),
        Kind::Circular => match turn_line(f) {
            Some((o, d)) => o + d * (pivot - o).dot(d),
            None => pivot,
        },
        _ => pivot,
    }
}

/// The pivot whose box centre `centre` is now: a move's pivot is where the sources stood before it.
pub fn pivot_of(kind: Kind, f: &Value, centre: Vec3) -> Vec3 {
    if kind != Kind::Move {
        return centre;
    }
    let r = |k| num(f, k).to_radians();
    let rot = DQuat::from_euler(EulerRot::XYZ, r("rx"), r("ry"), r("rz"));
    let d = DVec3::new(num(f, "dx"), num(f, "dy"), num(f, "dz"));
    (rot.inverse() * (centre.as_dvec3() - d)).as_vec3()
}

/// The world polylines of each handle, sized for `world_per_px`.
pub fn outline(kind: Kind, at: Vec3, world_per_px: f32) -> Vec<(Handle, Vec<Vec3>)> {
    handles(kind)
        .into_iter()
        .map(|h| {
            let line = match h {
                Handle::Arrow(k) => vec![at, at + AXES[k] * ARROW * world_per_px],
                Handle::Ring(k) => {
                    let (u, v) = (AXES[(k + 1) % 3], AXES[(k + 2) % 3]);
                    let r = RING * world_per_px;
                    (0..=RING_STEPS)
                        .map(|i| {
                            let a = i as f32 / RING_STEPS as f32 * std::f32::consts::TAU;
                            at + (u * a.cos() + v * a.sin()) * r
                        })
                        .collect()
                }
            };
            (h, line)
        })
        .collect()
}

fn to_segment(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let t = if ab.length_squared() < 1e-6 { 0.0 } else { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) };
    p.distance(a + ab * t)
}

/// The handle nearest `p` within the grab distance, arrows first when a ring crosses one.
pub fn hit(shapes: &[(Handle, Vec<Vec2>)], p: Vec2) -> Option<Handle> {
    let mut best: Option<(f32, Handle)> = None;
    for (h, line) in shapes {
        let d = line.windows(2).map(|w| to_segment(p, w[0], w[1])).fold(f32::INFINITY, f32::min);
        let d = if matches!(h, Handle::Arrow(_)) { d - 1.5 } else { d };
        if d <= GRAB && best.is_none_or(|(b, _)| d < b) {
            best = Some((d, *h));
        }
    }
    best.map(|(_, h)| h)
}

/// The feature after a drag of `travel` (a length along an arrow, degrees about a ring or a circular axis) from `start`.
pub fn dragged(kind: Kind, start: &Value, pivot: Vec3, handle: Handle, travel: f64, step: f64, fine: bool) -> Value {
    let mut f = start.clone();
    let turn = if fine { 1.0 } else { TURN_STEP };
    match (kind, handle) {
        (Kind::Move, Handle::Arrow(k)) => {
            let (rot, mut t) = decompose(start, pivot.as_dvec3());
            t[k] += snap(travel, step);
            compose(&mut f, pivot.as_dvec3(), rot, t);
        }
        (Kind::Move, Handle::Ring(k)) => {
            let (rot, t) = decompose(start, pivot.as_dvec3());
            let by = DQuat::from_axis_angle(AXES[k].as_dvec3(), snap(travel, turn).to_radians());
            compose(&mut f, pivot.as_dvec3(), by * rot, t);
        }
        (Kind::Linear, Handle::Arrow(k)) => {
            f["axis"] = json!(NAMES[k]);
            f["spacing"] = json!(snap(num(start, "spacing") + travel, step));
        }
        (Kind::Rect, Handle::Arrow(k)) => {
            let field = if k == 0 { "spacingX" } else { "spacingY" };
            f[field] = json!(snap(num(start, field) + travel, step));
        }
        (Kind::Circular, Handle::Arrow(_)) => {
            f["angle"] = json!(snap(num(start, "angle") + travel, turn).clamp(-360.0, 360.0));
        }
        _ => {}
    }
    f
}

/// A circular pattern's arrow turns about its own axis: pressing another one switches to it, through the same point.
pub fn grabbed_axis(f: &Value, k: usize) -> Value {
    let mut out = f.clone();
    match turn_line(f) {
        Some((_, d)) if d.abs_diff_eq(AXES[k], 1e-4) => {}
        Some((o, _)) if o != Vec3::ZERO => {
            let r = |v: f32| ((v as f64) * 100.0).round() / 100.0 + 0.0;
            let dir: Vec<f64> = AXES[k].to_array().iter().map(|v| *v as f64).collect();
            out["axis"] = json!({"origin": [r(o.x), r(o.y), r(o.z)], "dir": dir});
        }
        _ => {
            out["axis"] = json!(NAMES[k]);
            if let Some(o) = out.as_object_mut() {
                o.remove("axisRef");
            }
        }
    }
    out
}

/// Degrees of `p` about the line through `at` along `axis`.
fn angle_at(p: Vec3, at: Vec3, axis: Vec3) -> f64 {
    let u = if axis.x.abs() < 0.9 { Vec3::X } else { Vec3::Z };
    let e1 = (u - axis * u.dot(axis)).normalize();
    let e2 = axis.cross(e1);
    let r = p - at;
    (r.dot(e2) as f64).atan2(r.dot(e1) as f64).to_degrees()
}

/// The shortest way round, so a drag across the seam does not read as a near full turn back.
pub fn wrap(d: f64) -> f64 {
    let mut d = d % 360.0;
    if d > 180.0 {
        d -= 360.0;
    } else if d < -180.0 {
        d += 360.0;
    }
    d
}

impl Viewport {
    /// The running tool's feature when it has handles, with its kind and where they sit.
    fn gizmo_target(&mut self) -> Option<(Kind, Value, Vec3)> {
        let tool = self.tool.as_ref().filter(|t| t.arm.is_none())?;
        let f = tools::feature(self.doc()?, &tool.feature)?.clone();
        let kind = kind(&f)?;
        let key = format!(
            "{} {} {}",
            tool.feature,
            f.get("bodies").unwrap_or(&Value::Null),
            f.get("features").unwrap_or(&Value::Null)
        );
        if key != self.gizmo.key && self.gizmo.drag.is_none() {
            let shown = self.shown_bodies();
            let (lo, hi) = tools::sources_extent(&f, &shown)?;
            let centre = (Vec3::from(lo) + Vec3::from(hi)) * 0.5;
            self.gizmo.pivot = pivot_of(kind, &f, centre);
            self.gizmo.key = key;
        }
        let at = anchor(kind, &f, self.gizmo.pivot);
        Some((kind, f, at))
    }

    /// Drops the cached pivot and takes it again from the bodies as they stand, before the tool's feature builds.
    pub(super) fn gizmo_reset(&mut self) {
        self.gizmo = Gizmo::default();
        self.gizmo_target();
    }

    fn world_per_px(&self, at: Vec3) -> Option<f32> {
        let right = self.camera.view().row(0).truncate().normalize();
        let (a, b) = (self.to_screen(at)?, self.to_screen(at + right)?);
        let d = ((b.x - a.x).as_f32().powi(2) + (b.y - a.y).as_f32().powi(2)).sqrt();
        (d > 1e-6).then(|| 1.0 / d)
    }

    fn gizmo_shapes(&self, kind: Kind, at: Vec3) -> Option<Vec<(Handle, Vec<Vec2>)>> {
        let wpp = self.world_per_px(at)?;
        let screen = |w: &Vec3| self.to_screen(*w).map(|p| Vec2::new(p.x.as_f32(), p.y.as_f32()));
        outline(kind, at, wpp)
            .iter()
            .map(|(h, line)| line.iter().map(screen).collect::<Option<Vec<_>>>().map(|l| (*h, l)))
            .collect()
    }

    /// A reading of the cursor for `handle`: a length along an arrow, degrees about a ring or a circular axis.
    fn gizmo_reading(&self, kind: Kind, handle: Handle, at: Vec3, position: Point<Pixels>) -> Option<f64> {
        let (o, d) = self.ray_at(position);
        let (axis, angular) = match handle {
            Handle::Arrow(k) => (AXES[k], kind == Kind::Circular),
            Handle::Ring(k) => (AXES[k], true),
        };
        if !angular {
            return super::drag::axis_travel(at, axis, o, d).map(f64::from);
        }
        let facing = d.dot(axis);
        // Edge on, a pixel of mouse would be an unbounded turn.
        if facing.abs() < 0.12 {
            return None;
        }
        let p = o + d * ((at - o).dot(axis) / facing);
        Some(angle_at(p, at, axis))
    }

    pub(super) fn gizmo_press(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        let Some((kind, mut f, at)) = self.gizmo_target() else { return false };
        let Some(shapes) = self.gizmo_shapes(kind, at) else { return false };
        let Some(handle) = hit(&shapes, Vec2::new(position.x.as_f32(), position.y.as_f32())) else { return false };
        let turned = match (kind, handle) {
            (Kind::Circular, Handle::Arrow(k)) => Some(grabbed_axis(&f, k)),
            (Kind::Linear, Handle::Arrow(k)) => Some(linear_axis(&f, k, crate::tools::sources_extent(&f, &self.shown_bodies()))),
            _ => None,
        };
        if let Some(turned) = turned {
            if turned != f {
                self.gizmo_apply(&turned, cx);
                f = turned;
            }
        }
        let at = anchor(kind, &f, self.gizmo.pivot);
        let last = self.gizmo_reading(kind, handle, at, position).unwrap_or(0.0);
        self.gizmo.drag = Some(Drag { handle, start: f, at, last, travel: 0.0 });
        cx.notify();
        true
    }

    pub(super) fn gizmo_move(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) -> bool {
        let Some(drag) = &self.gizmo.drag else {
            if e.pressed_button.is_none() {
                let hover = self
                    .gizmo_target()
                    .and_then(|(kind, _, at)| self.gizmo_shapes(kind, at))
                    .and_then(|s| hit(&s, Vec2::new(e.position.x.as_f32(), e.position.y.as_f32())));
                if hover != self.gizmo.hover {
                    self.gizmo.hover = hover;
                    cx.notify();
                }
            }
            return false;
        };
        let Some(kind) = kind(&drag.start) else { return false };
        let (handle, at) = (drag.handle, drag.at);
        let Some(reading) = self.gizmo_reading(kind, handle, at, e.position) else { return true };
        let step = step(self.world_per_px(at).unwrap_or(0.1), e.modifiers.shift);
        let Some(drag) = &mut self.gizmo.drag else { return true };
        let angular = matches!(handle, Handle::Ring(_)) || kind == Kind::Circular;
        drag.travel = if angular { drag.travel + wrap(reading - drag.last) } else { drag.travel + reading - drag.last };
        drag.last = reading;
        let next = dragged(kind, &drag.start, self.gizmo.pivot, handle, drag.travel, step, e.modifiers.shift);
        self.gizmo_apply(&next, cx);
        true
    }

    fn gizmo_apply(&mut self, f: &Value, cx: &mut Context<Self>) {
        let Some(id) = f.get("id").and_then(Value::as_str).map(str::to_string) else { return };
        if self.doc().and_then(|d| tools::feature(d, &id)) == Some(f) {
            return;
        }
        let f = f.clone();
        if let Err(e) = self.edit(move |d| tools::replace(d, &id, f.clone()), cx) {
            self.message = Some(e);
        }
    }

    pub(super) fn gizmo_release(&mut self, cx: &mut Context<Self>) {
        if self.gizmo.drag.take().is_some() {
            cx.notify();
        }
    }

    pub(super) fn paint_gizmo(&mut self, axes: [Hsla; 3], hot: Hsla, window: &mut Window) {
        let Some((kind, _, at)) = self.gizmo_target() else { return };
        let Some(shapes) = self.gizmo_shapes(kind, at) else { return };
        let lit = self.gizmo.drag.as_ref().map(|d| d.handle).or(self.gizmo.hover);
        let pt = |v: Vec2| point(px(v.x), px(v.y));
        for (h, line) in &shapes {
            let (k, ring) = match h {
                Handle::Arrow(k) => (*k, false),
                Handle::Ring(k) => (*k, true),
            };
            let color = if lit == Some(*h) { hot } else { axes[k] };
            let mut b = PathBuilder::stroke(px(if ring { 2.0 } else { 2.5 }));
            for (i, v) in line.iter().enumerate() {
                if i == 0 {
                    b.move_to(pt(*v))
                } else {
                    b.line_to(pt(*v))
                }
            }
            if let Ok(p) = b.build() {
                window.paint_path(p, color);
            }
            if let (false, [root, tip]) = (ring, line.as_slice()) {
                let dir = (*tip - *root).try_normalize().unwrap_or(Vec2::X);
                let side = Vec2::new(-dir.y, dir.x) * HEAD * 0.32;
                let mut b = PathBuilder::fill();
                b.move_to(pt(*tip + dir * HEAD * 0.6));
                b.line_to(pt(*tip - dir * HEAD * 0.4 + side));
                b.line_to(pt(*tip - dir * HEAD * 0.4 - side));
                b.close();
                if let Ok(p) = b.build() {
                    window.paint_path(p, color);
                }
            }
        }
    }
}
