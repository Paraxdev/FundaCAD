//! Datum planes, axes and points drawn in the model's depth, the Origin planes once their eye is on, and a click on a
//! plane square taking it. The running datum feature and the selected planes are lit.

pub mod draw;
pub mod geom;

use std::sync::Arc;

use fundacad_client::Mesh as EngineMesh;
use gpui::*;
use serde_json::Map;

use super::Viewport;
use super::renderer::DatumVertex;
use crate::selection::{Pick, PickKind};
use geom::Mark;

const PLANE: u32 = 0x7fb2ff;
const AXIS: u32 = 0xf5a524;
const POINT: u32 = 0xe5e7eb;
const LIT: u32 = 0x9a9ff0;

#[derive(Default)]
pub struct Datums {
    pub mesh: Option<Arc<EngineMesh>>,
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

    /// The datum marks as triangles, and whether they go over the model: FundaCAD 1 tests them against it except
    /// while a plane is being picked.
    pub(super) fn datum_triangles(&self) -> (Vec<DatumVertex>, bool) {
        let mut out = Vec::new();
        let marks = self.datum_marks();
        let on_top = self.tool.as_ref().and_then(|t| t.arm).is_some_and(|a| a.kind == PickKind::Plane);
        if marks.is_empty() {
            return (out, on_top);
        }
        let half = self.datum_half();
        let view = draw::View::new(&self.camera, self.bounds.size.height.as_f32());
        for m in &marks {
            let lit = self.lit_datum(m.id());
            match m {
                Mark::Plane { plane, .. } => {
                    let c = geom::square(half).map(|q| plane.to_3d(q).as_vec3());
                    let color = if lit { LIT } else { PLANE };
                    draw::quad(&mut out, c, draw::linear(color, if lit { 0.22 } else { 0.1 }));
                    let (width, edge) = (if lit { 2.0 } else { 1.0 }, draw::linear(color, 0.8));
                    for i in 0..4 {
                        draw::line(&mut out, &view, c[i], c[(i + 1) % 4], width, edge);
                    }
                }
                Mark::Axis { origin, dir, .. } => {
                    let (a, b) = ((*origin - *dir * half).as_vec3(), (*origin + *dir * half).as_vec3());
                    let color = draw::linear(if lit { LIT } else { AXIS }, 0.9);
                    draw::dashed(&mut out, &view, a, b, if lit { 2.5 } else { 1.5 }, 8.0, 4.0, color);
                }
                Mark::Point { at, .. } => {
                    let color = draw::linear(if lit { LIT } else { POINT }, 0.95);
                    draw::disc(&mut out, &view, at.as_vec3(), if lit { 5.0 } else { 3.5 }, color);
                }
            }
        }
        (out, on_top)
    }
}
