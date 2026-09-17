//! Measurements over a shape: volume, area, bounding box.
//!
//! These are the numbers `inspect` reports and the tests assert on, so they
//! come straight from `BRepGProp` and `BRepBndLib` rather than from a mesh.

use opencascade::primitives::Shape;
use serde::{Deserialize, Serialize};

/// Axis-aligned bounding box in model units, `min`/`max` corners.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bbox {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

/// Volume of a closed shape; zero for open shells, faces and wires.
pub fn volume(shape: &Shape) -> f64 {
    shape.volume()
}

/// Sum of the area of every face.
pub fn surface_area(shape: &Shape) -> f64 {
    shape.surface_area()
}

/// Bounding box of the shape, or `None` for empty geometry.
pub fn bbox(shape: &Shape) -> Option<Bbox> {
    let bb = opencascade::bounding_box::aabb(shape);
    if bb.is_void() {
        return None;
    }
    let (min, max) = (bb.min(), bb.max());
    Some(Bbox { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] })
}
