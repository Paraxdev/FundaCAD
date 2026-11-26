//! Finished sketches in the view: the ones shown in Items, and every one while a tool picks their areas, with the area
//! under the cursor and the ones the running feature holds lit.

#[cfg(test)]
mod tests;

use glam::DVec2;
use gpui::*;
use serde_json::Value;

use super::Viewport;
use crate::selection::{Pick, PickKind};
use crate::sketch::areas::{self, Area, Shown};
use crate::sketch::Plane;
use crate::tools;

const LINE: u32 = 0x8fa4bd;
const FILL: u32 = 0x3a7bd5;
const LIT: u32 = 0x9a9ff0;

#[derive(Default)]
pub struct Profiles {
    key: Option<(u64, u64, bool, Option<String>)>,
    shown: Vec<Shown>,
    /// The area under the cursor, as its sketch and stored point.
    hover: Option<(String, [f64; 3])>,
}

fn rgb_a(hex: u32, a: f32) -> Hsla {
    let mut c: Hsla = rgb(hex).into();
    c.a = a;
    c
}

/// Whether a held entry of `field` names `area`: a region point of the feature's sketch, a loft profile, or a sweep's
/// sketch id.
fn names(area: &Area, entry: &Value, sketch: Option<&str>) -> bool {
    let point = |v: &Value| -> Option<[f64; 3]> {
        let a = v.as_array()?;
        Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
    };
    match entry {
        Value::String(s) => *s == area.sketch,
        Value::Object(o) => {
            let (k, p) = (o.get("sketch").and_then(Value::as_str), o.get("region").and_then(point));
            k.zip(p).is_some_and(|(k, p)| area.holds(k, p))
        }
        v => sketch.zip(point(v)).is_some_and(|(k, p)| area.holds(k, p)),
    }
}

impl Viewport {
    fn picking_areas(&self) -> bool {
        self.arm().is_some_and(|a| a.kind == PickKind::Area)
    }

    fn refresh_profiles(&mut self) {
        let all = self.picking_areas();
        let open = self.sketch.as_ref().map(|e| e.feature.clone());
        let key = Some((self.changes, self.opened, all, open.clone()));
        if self.profiles.key == key {
            return;
        }
        self.profiles.key = key;
        self.profiles.shown = self.doc().map(|d| areas::shown(d, all, open.as_deref())).unwrap_or_default();
    }

    fn area_at(&mut self, position: Point<Pixels>) -> Option<&Area> {
        self.refresh_profiles();
        let (o, d) = self.ray_at(position);
        areas::under(self.profiles.shown.iter().flat_map(|s| &s.areas), o, d)
    }

    pub(super) fn area_pick(&mut self, position: Point<Pixels>) -> Option<Pick> {
        self.area_at(position).map(|a| Pick::Area { sketch: a.sketch.clone(), point: a.point })
    }

    pub(super) fn hover_area_at(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let took = match self.picking_areas() {
            true => self.area_at(position).map(|a| (a.sketch.clone(), a.point)),
            false => None,
        };
        if took != self.profiles.hover {
            self.profiles.hover = took;
            cx.notify();
        }
    }

    /// Whether the held `entry` of the running feature is the area `pick` landed in, so the click drops it.
    pub(super) fn holds_area(&self, feature: &str, entry: &Value, pick: &Pick) -> bool {
        let Pick::Area { sketch, point } = pick else { return false };
        let own = self.doc().and_then(|d| tools::feature(d, feature)).and_then(|f| f.get("sketch")).and_then(Value::as_str);
        let area = self.profiles.shown.iter().flat_map(|s| &s.areas).find(|a| a.holds(sketch, *point));
        area.is_some_and(|a| names(a, entry, own))
    }

    /// The areas the running feature holds in its area fields.
    fn held_areas(&self) -> Vec<&Area> {
        let (Some(tool), Some(doc)) = (self.tool.as_ref(), self.doc()) else { return Vec::new() };
        let own = tools::feature(doc, &tool.feature).and_then(|f| f.get("sketch")).and_then(Value::as_str);
        let held: Vec<Value> = tool
            .need
            .iter()
            .filter(|t| t.kind == PickKind::Area)
            .flat_map(|t| tools::entries(doc, &tool.feature, t.field))
            .collect();
        self.profiles.shown.iter().flat_map(|s| &s.areas).filter(|a| held.iter().any(|e| names(a, e, own))).collect()
    }

    pub(super) fn paint_profiles(&mut self, window: &mut Window) {
        self.refresh_profiles();
        if self.profiles.shown.is_empty() {
            return;
        }
        let stroke = |pts: &[DVec2], plane: &Plane, color: Hsla, window: &mut Window| {
            let mut b = PathBuilder::stroke(px(1.5));
            for (i, q) in pts.iter().enumerate() {
                let Some(s) = self.to_screen(plane.to_3d(*q).as_vec3()) else { return };
                match i {
                    0 => b.move_to(s),
                    _ => b.line_to(s),
                }
            }
            if let Ok(p) = b.build() {
                window.paint_path(p, color);
            }
        };
        let fill = |area: &Area, color: Hsla, window: &mut Window| {
            let mut b = PathBuilder::fill();
            for ring in std::iter::once(&area.outline).chain(&area.holes) {
                for (i, q) in ring.iter().enumerate() {
                    let Some(s) = self.to_screen(area.plane.to_3d(*q).as_vec3()) else { return };
                    match i {
                        0 => b.move_to(s),
                        _ => b.line_to(s),
                    }
                }
                b.close();
            }
            if let Ok(p) = b.build() {
                window.paint_path(p, color);
            }
        };
        let picking = self.picking_areas();
        let held = self.held_areas();
        for s in &self.profiles.shown {
            for a in &s.areas {
                let lit = held.iter().any(|h| std::ptr::eq(*h, a));
                let hot = self.profiles.hover.as_ref().is_some_and(|(k, p)| a.holds(k, *p));
                let alpha = match (lit, hot, picking) {
                    (true, _, _) => 0.45,
                    (_, true, _) => 0.3,
                    (_, _, true) => 0.1,
                    _ => 0.0,
                };
                if alpha > 0.0 {
                    fill(a, rgb_a(if lit { LIT } else { FILL }, alpha), window);
                }
            }
            for l in &s.lines {
                stroke(l, &s.plane, rgb_a(LINE, 0.9), window);
            }
        }
    }
}
