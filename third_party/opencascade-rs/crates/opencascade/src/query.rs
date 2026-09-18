//! Geometry questions about one face or edge: parameter ranges, closure,
//! projection and point classification.

use crate::{
    primitives::{Edge, Face},
    Error,
};
use glam::{dvec3, DVec3};
use opencascade_sys as ffi;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UvBounds {
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Closure {
    pub u_closed: bool,
    pub v_closed: bool,
    pub u_periodic: bool,
    pub v_periodic: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SurfaceProjection {
    pub u: f64,
    pub v: f64,
    pub distance: f64,
    pub point: DVec3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointState {
    In,
    Out,
    On,
    Unknown,
}

impl From<i32> for PointState {
    fn from(state: i32) -> Self {
        match state {
            0 => Self::In,
            1 => Self::Out,
            2 => Self::On,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurveRange {
    pub first: f64,
    pub last: f64,
    pub closed: bool,
    pub periodic: bool,
    pub degenerated: bool,
}

impl Face {
    /// `BRepTools::UVBounds`, the parameter box of the trimmed face.
    pub fn uv_bounds(&self) -> Result<UvBounds, Error> {
        let mut out = [0.0; 4];
        ffi::surface_query::BRepTools_uv_bounds(&self.inner, &mut out)?;
        Ok(UvBounds { u_min: out[0], u_max: out[1], v_min: out[2], v_max: out[3] })
    }

    pub fn closure(&self) -> Result<Closure, Error> {
        let bits = ffi::surface_query::BRepAdaptor_Surface_closure(&self.inner)?;
        Ok(Closure {
            u_closed: bits & 1 != 0,
            v_closed: bits & 2 != 0,
            u_periodic: bits & 4 != 0,
            v_periodic: bits & 8 != 0,
        })
    }

    /// Closes on itself in u or v (a cylinder side, a full torus), as
    /// the Python engine's `topo_adj.py` `face_wraps`.
    pub fn wraps(&self) -> bool {
        self.closure().is_ok_and(|c| c.u_closed || c.v_closed)
    }

    /// Point and outward unit normal at `(u, v)`, the face orientation applied.
    pub fn point_and_normal(&self, u: f64, v: f64) -> Result<(DVec3, DVec3), Error> {
        let mut out = [0.0; 6];
        ffi::surface_query::BRepGProp_Face_point_normal(&self.inner, u, v, &mut out)?;
        Ok((dvec3(out[0], out[1], out[2]), dvec3(out[3], out[4], out[5])))
    }

    /// `GeomAPI_ProjectPointOnSurf` onto the untrimmed surface.
    pub fn project_point(&self, point: DVec3) -> Result<Option<SurfaceProjection>, Error> {
        let mut out = [0.0; 6];
        let found = ffi::surface_query::GeomAPI_ProjectPointOnSurf_face(
            &self.inner,
            point.x,
            point.y,
            point.z,
            &mut out,
        )?;
        Ok(found.then(|| SurfaceProjection {
            u: out[0],
            v: out[1],
            distance: out[2],
            point: dvec3(out[3], out[4], out[5]),
        }))
    }

    /// `BRepClass_FaceClassifier` against the trimming wires at `(u, v)`.
    pub fn classify_uv(&self, u: f64, v: f64, tolerance: f64) -> Result<PointState, Error> {
        Ok(ffi::surface_query::BRepClass_FaceClassifier_uv(&self.inner, u, v, tolerance)?.into())
    }

    /// A 3D point, projected onto the surface by the classifier first.
    pub fn classify_point(&self, point: DVec3, tolerance: f64) -> Result<PointState, Error> {
        Ok(ffi::surface_query::BRepClass_FaceClassifier_point(
            &self.inner,
            point.x,
            point.y,
            point.z,
            tolerance,
        )?
        .into())
    }

    pub fn tolerance(&self) -> f64 {
        ffi::surface_query::BRep_Tool_face_tolerance(&self.inner)
    }
}

impl Edge {
    pub fn range(&self) -> Result<CurveRange, Error> {
        let mut out = [0.0; 2];
        let bits = ffi::surface_query::BRepAdaptor_Curve_range(&self.inner, &mut out)?;
        Ok(CurveRange {
            first: out[0],
            last: out[1],
            closed: bits & 1 != 0,
            periodic: bits & 2 != 0,
            degenerated: bits & 4 != 0,
        })
    }

    /// Point and first derivative at curve parameter `t`.
    pub fn d1(&self, t: f64) -> Result<(DVec3, DVec3), Error> {
        let mut out = [0.0; 6];
        ffi::surface_query::BRepAdaptor_Curve_d1(&self.inner, t, &mut out)?;
        Ok((dvec3(out[0], out[1], out[2]), dvec3(out[3], out[4], out[5])))
    }

    /// A seam of `face`: the edge where a wrapping face closes on itself.
    pub fn is_seam_of(&self, face: &Face) -> bool {
        ffi::surface_query::BRep_Tool_is_closed_on(&self.inner, &face.inner)
    }

    pub fn tolerance(&self) -> f64 {
        ffi::surface_query::BRep_Tool_edge_tolerance(&self.inner)
    }
}
