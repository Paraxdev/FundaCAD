//! Minimum distance between shapes (`BRepExtrema_DistShapeShape`) and mass
//! properties (`BRepGProp`).

use crate::{
    primitives::{Edge, Face, Shape},
    Error,
};
use glam::{dvec3, DVec3};
use opencascade_sys as ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportKind {
    Vertex,
    Edge,
    Face,
}

/// Where one end of a closest pair lies. `params` is `(t, 0)` on an edge and
/// `(u, v)` in a face.
#[derive(Clone)]
pub struct DistanceEnd {
    pub point: DVec3,
    pub kind: SupportKind,
    pub params: (f64, f64),
    pub support: Shape,
}

#[derive(Clone)]
pub struct DistanceSolution {
    pub on_first: DistanceEnd,
    pub on_second: DistanceEnd,
}

#[derive(Clone)]
pub struct ShapeDistance {
    pub value: f64,
    /// One shape is a solid and the other lies at least partly inside it.
    pub inner_solution: bool,
    pub solutions: Vec<DistanceSolution>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MassProperties {
    /// Length, area or volume, by the kind asked for.
    pub mass: f64,
    pub centre_of_mass: DVec3,
    /// About the centre of mass, axes parallel to the global ones, `[row][col]`.
    pub inertia: [[f64; 3]; 3],
    pub principal_moments: [f64; 3],
}

impl Shape {
    /// `BRepExtrema_DistShapeShape`, bounded by the real topology (trimmed
    /// faces, finite edges). A non-positive `deflection` keeps the default.
    pub fn distance(&self, other: &Shape, deflection: f64) -> Result<ShapeDistance, Error> {
        let dist = ffi::b_rep_extrema::BRepExtrema_DistShapeShape_perform(
            &self.inner,
            &other.inner,
            deflection,
            &ffi::message::Message_ProgressRange_new(),
        )?;
        if !dist.IsDone() {
            return Err(Error::OperationFailed("BRepExtrema_DistShapeShape"));
        }
        let end = |index: i32, on_first: bool| -> Result<DistanceEnd, Error> {
            let mut out = [0.0; 6];
            ffi::b_rep_extrema::BRepExtrema_DistShapeShape_solution(&dist, index, on_first, &mut out)?;
            let kind = match out[3] as i32 {
                0 => SupportKind::Vertex,
                1 => SupportKind::Edge,
                _ => SupportKind::Face,
            };
            let support = ffi::b_rep_extrema::BRepExtrema_DistShapeShape_support(&dist, index, on_first)?;
            Ok(DistanceEnd {
                point: dvec3(out[0], out[1], out[2]),
                kind,
                params: (out[4], out[5]),
                support: Shape { inner: support },
            })
        };
        let solutions = (1..=dist.NbSolution())
            .map(|i| Ok(DistanceSolution { on_first: end(i, true)?, on_second: end(i, false)? }))
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(ShapeDistance { value: dist.Value()?, inner_solution: dist.InnerSolution(), solutions })
    }

    pub fn distance_to_point(&self, point: DVec3) -> Result<f64, Error> {
        let vertex = Shape {
            inner: ffi::b_rep_extrema::BRepExtrema_vertex(point.x, point.y, point.z),
        };
        Ok(self.distance(&vertex, 0.0)?.value)
    }

    pub fn linear_properties(&self) -> Result<MassProperties, Error> {
        mass_properties(&self.inner, 1)
    }

    pub fn surface_properties(&self) -> Result<MassProperties, Error> {
        mass_properties(&self.inner, 2)
    }

    pub fn volume_properties(&self) -> Result<MassProperties, Error> {
        mass_properties(&self.inner, 3)
    }
}

impl Face {
    pub fn properties(&self) -> Result<MassProperties, Error> {
        mass_properties(ffi::topo_ds::cast_face_to_shape(&self.inner), 2)
    }
}

impl Edge {
    pub fn properties(&self) -> Result<MassProperties, Error> {
        mass_properties(ffi::topo_ds::cast_edge_to_shape(&self.inner), 1)
    }
}

fn mass_properties(shape: &ffi::topo_ds::TopoDS_Shape, kind: i32) -> Result<MassProperties, Error> {
    let mut out = [0.0; 16];
    ffi::mass_props::BRepGProp_properties(shape, kind, true, &mut out)?;
    let mut inertia = [[0.0; 3]; 3];
    for (row, values) in inertia.iter_mut().enumerate() {
        values.copy_from_slice(&out[4 + row * 3..7 + row * 3]);
    }
    Ok(MassProperties {
        mass: out[0],
        centre_of_mass: dvec3(out[1], out[2], out[3]),
        inertia,
        principal_moments: [out[13], out[14], out[15]],
    })
}
