//! Datum planes, axes and points drawn over the model, the Origin planes once their eye is on, and a click on a plane
//! square taking it. The running datum feature and the selected planes are lit.

pub mod geom;

use std::sync::Arc;

use fundacad_client::Mesh as EngineMesh;
use glam::DVec3;
use gpui::*;
use serde_json::Map;

use super::Viewport;
use crate::selection::Pick;
use geom::Mark;

const PLANE: u32 = 0x7fb2ff;
const AXIS: u32 = 0xf5a524;
const POINT: u32 = 0xe5e7eb;
const LIT: u32 = 0x9a9ff0;

#[derive(Default)]
pub struct Datums {
    pub mesh: Option<Arc<EngineMesh>>,
}

fn rgb_a(hex: u32, a: f32) -> Hsla {
    let mut c: Hsla = rgb(hex).into();
    c.a = a;
    c
}

impl Viewport {
    fn datum_marks(&self) -> Vec<Mark> {
        let empty = Map::new();
        let result = self.datums.mesh.as_ref().map_or(&empty, |m| &m.result);
        self.doc().map(|d| geom::marks(d, result)).unwrap_or_default()
    }

    /// Half the side of a plane's square, from the size of the model.
    fn datum_half(&self) -> f64 {
        self.scene.bounds().map_or(30.0, |(_, r)| (r as f64 * 0.6).max(10.0))
    }

    /// The plane square under `position` when it is nearer than the model there.
    pub(super) fn plane_pick(&self, position: Point<Pixels>) -> Option<Pick> {
        let (o, d) = self.ray_at(position);
        let marks = self.datum_marks();
        let (id, t) = geom::plane_under(&marks, self.datum_half(), o, d)?;
        let model = super::pick::pick(&self.scene, o, d).map(|h| h.point.distance(o) as f64);
        model.is_none_or(|m| t < m).then(|| Pick::Plane { id: id.to_string() })
    }

    fn lit_datum(&self, id: &str) -> bool {
        let picked = |p: &Pick| matches!(p, Pick::Plane { id: q } if q == id);
        self.picking.selection.picks.iter().any(picked)
            || self.tool.as_ref().is_some_and(|t| t.feature == id)
            || self.arm_planes().iter().any(|q| q == id)
    }

    /// The planes the running feature's needed fields hold by name.
    fn arm_planes(&self) -> Vec<String> {
        let (Some(tool), Some(doc)) = (self.tool.as_ref(), self.doc()) else { return Vec::new() };
        if let Some(id) = crate::tools::feature(doc, &tool.feature).and_then(|f| f.get("planeId")).and_then(|p| p.as_str()) {
            return vec![id.to_string()];
        }
        tool.need
            .iter()
            .flat_map(|t| crate::tools::entries(doc, &tool.feature, t.field))
            .filter_map(|e| e.get("plane").and_then(|p| p.as_str()).map(str::to_string).or(e.as_str().map(str::to_string)))
            .collect()
    }

    pub(super) fn paint_datums(&self, window: &mut Window) {
        let marks = self.datum_marks();
        if marks.is_empty() {
            return;
        }
        let half = self.datum_half();
        let screen = |p: DVec3| self.to_screen(p.as_vec3());
        for m in &marks {
            let lit = self.lit_datum(m.id());
            match m {
                Mark::Plane { plane, .. } => {
                    let corners: Option<Vec<Point<Pixels>>> =
                        geom::square(half).iter().map(|q| screen(plane.to_3d(*q))).collect();
                    let Some(c) = corners else { continue };
                    let mut fill = PathBuilder::fill();
                    let mut edge = PathBuilder::stroke(px(if lit { 2.0 } else { 1.0 }));
                    fill.move_to(c[0]);
                    edge.move_to(c[0]);
                    for p in &c[1..] {
                        fill.line_to(*p);
                        edge.line_to(*p);
                    }
                    fill.close();
                    edge.line_to(c[0]);
                    let color = if lit { LIT } else { PLANE };
                    if let Ok(p) = fill.build() {
                        window.paint_path(p, rgb_a(color, if lit { 0.22 } else { 0.1 }));
                    }
                    if let Ok(p) = edge.build() {
                        window.paint_path(p, rgb_a(color, 0.8));
                    }
                }
                Mark::Axis { origin, dir, .. } => {
                    let (Some(a), Some(b)) = (screen(*origin - *dir * half), screen(*origin + *dir * half)) else { continue };
                    let mut line = PathBuilder::stroke(px(if lit { 2.5 } else { 1.5 })).dash_array(&[px(8.), px(4.)]);
                    line.move_to(a);
                    line.line_to(b);
                    if let Ok(p) = line.build() {
                        window.paint_path(p, rgb_a(if lit { LIT } else { AXIS }, 0.9));
                    }
                }
                Mark::Point { at, .. } => {
                    let Some(c) = screen(*at) else { continue };
                    let r = if lit { 5.0 } else { 3.5 };
                    let mut dot = PathBuilder::fill();
                    for i in 0..12 {
                        let a = i as f32 / 12.0 * std::f32::consts::TAU;
                        let p = point(c.x + px(r * a.cos()), c.y + px(r * a.sin()));
                        match i {
                            0 => dot.move_to(p),
                            _ => dot.line_to(p),
                        }
                    }
                    dot.close();
                    if let Ok(p) = dot.build() {
                        window.paint_path(p, rgb_a(if lit { LIT } else { POINT }, 0.95));
                    }
                }
            }
        }
    }
}
