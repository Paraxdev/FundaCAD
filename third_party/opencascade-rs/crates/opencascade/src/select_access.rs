//! Safe geometry readback for selector resolution: the entities of a shape in
//! build123d's order and the per-entity measurements its fingerprints use.

use crate::primitives::Shape;
use opencascade_sys::select_access as ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Vertex = 0,
    Edge = 1,
    Face = 2,
}

/// build123d `vertices()`, `edges()` (degenerate edges dropped) or `faces()`.
pub fn items(shape: &Shape, kind: ItemKind) -> Vec<Shape> {
    let v = ffi::sa_items(&shape.inner, kind as i32);
    match v.as_ref() {
        Some(v) => v.iter().map(Shape::from_raw_ref).collect(),
        None => Vec::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurveType {
    Line,
    Circle,
    Ellipse,
    Bspline,
    Other,
}

impl CurveType {
    pub fn name(self) -> &'static str {
        match self {
            CurveType::Line => "line",
            CurveType::Circle => "circle",
            CurveType::Ellipse => "ellipse",
            CurveType::Bspline => "bspline",
            CurveType::Other => "other",
        }
    }
}

/// An edge as build123d measures it; `None` where the Python call raises.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeProbe {
    /// `position_at(0.5)`, half way along the length.
    pub mid: Option<[f64; 3]>,
    /// `tangent_at(0.5)`, unit, following the edge orientation.
    pub tangent: Option<[f64; 3]>,
    pub length: Option<f64>,
    pub curve: CurveType,
    /// Radius and centre, circles only.
    pub circle: Option<(f64, [f64; 3])>,
    /// The first and last of `vertices()`.
    pub ends: Option<([f64; 3], [f64; 3])>,
}

fn v3(o: &[f64]) -> [f64; 3] {
    [o[0], o[1], o[2]]
}

pub fn edge_probe(edge: &Shape) -> Option<EdgeProbe> {
    let mut o = [0.0; 23];
    if !ffi::sa_edge_probe(&edge.inner, &mut o) {
        return None;
    }
    let flag = |i: usize| o[i] != 0.0;
    Some(EdgeProbe {
        mid: flag(0).then(|| v3(&o[1..4])),
        tangent: flag(4).then(|| v3(&o[5..8])),
        length: flag(8).then_some(o[9]),
        curve: match o[10] as i32 {
            0 => CurveType::Line,
            1 => CurveType::Circle,
            2 => CurveType::Ellipse,
            3 => CurveType::Bspline,
            _ => CurveType::Other,
        },
        circle: flag(11).then(|| (o[12], v3(&o[13..16]))),
        ends: flag(16).then(|| (v3(&o[17..20]), v3(&o[20..23]))),
    })
}

/// build123d `tangent_at(position)`, position a length fraction in 0..1.
pub fn edge_tangent(edge: &Shape, position: f64) -> Option<[f64; 3]> {
    let mut o = [0.0; 3];
    ffi::sa_edge_tangent(&edge.inner, position, &mut o).then_some(o)
}

/// Whether a line edge is parallel to `axis` within `ang_tol` radians, `None`
/// where the kernel raised.
pub fn edge_line_parallel(edge: &Shape, axis: [f64; 3], ang_tol: f64) -> Option<bool> {
    match ffi::sa_edge_line_parallel(&edge.inner, axis[0], axis[1], axis[2], ang_tol) {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceType {
    Plane,
    Cylinder,
    Cone,
    Sphere,
    Torus,
    Bspline,
    Other,
}

impl SurfaceType {
    pub fn name(self) -> &'static str {
        match self {
            SurfaceType::Plane => "plane",
            SurfaceType::Cylinder => "cylinder",
            SurfaceType::Cone => "cone",
            SurfaceType::Sphere => "sphere",
            SurfaceType::Torus => "torus",
            SurfaceType::Bspline => "bspline",
            SurfaceType::Other => "other",
        }
    }
}

/// A face as build123d measures it; `None` where the Python call raises.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceProbe {
    /// `center()`.
    pub centre: Option<[f64; 3]>,
    /// `normal_at()`, unit.
    pub normal: Option<[f64; 3]>,
    pub area: Option<f64>,
    pub surface: SurfaceType,
    /// `radius`, cylinders and spheres only.
    pub radius: Option<f64>,
}

pub fn face_probe(face: &Shape) -> Option<FaceProbe> {
    let mut o = [0.0; 13];
    if !ffi::sa_face_probe(&face.inner, &mut o) {
        return None;
    }
    let flag = |i: usize| o[i] != 0.0;
    Some(FaceProbe {
        centre: flag(0).then(|| v3(&o[1..4])),
        normal: flag(4).then(|| v3(&o[5..8])),
        area: flag(8).then_some(o[9]),
        surface: match o[10] as i32 {
            0 => SurfaceType::Plane,
            1 => SurfaceType::Cylinder,
            2 => SurfaceType::Cone,
            3 => SurfaceType::Sphere,
            4 => SurfaceType::Torus,
            5 => SurfaceType::Bspline,
            _ => SurfaceType::Other,
        },
        radius: flag(11).then_some(o[12]),
    })
}

/// The bounded distance from `shape` to a point and the closest point on the
/// shape, `BRepExtrema_DistShapeShape`.
pub fn distance_to_point(shape: &Shape, p: [f64; 3]) -> Option<(f64, [f64; 3])> {
    let mut o = [0.0; 4];
    ffi::sa_distance(&shape.inner, p[0], p[1], p[2], &mut o).then(|| (o[0], v3(&o[1..4])))
}

/// The distance to a face's untrimmed surface, infinite where no projection exists.
pub fn surface_distance(face: &Shape, p: [f64; 3]) -> f64 {
    ffi::sa_surface_distance(&face.inner, p[0], p[1], p[2])
}

/// The optimal bounding box's diagonal, 1.0 for an empty shape.
pub fn bbox_diagonal(shape: &Shape) -> f64 {
    ffi::sa_bbox_diag(&shape.inner)
}
