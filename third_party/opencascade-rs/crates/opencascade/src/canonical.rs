//! Canonical recognition of imported B-rep: swept and near analytic spline
//! surfaces rebuilt as planes, cylinders, cones and spheres.

use crate::primitives::Shape;
use crate::Error;
use opencascade_sys::canonical as ffi;

/// Whether any face is a B-spline, Bezier, extrusion or revolution surface.
pub fn convertible(shape: &Shape) -> Result<bool, Error> {
    Ok(ffi::canonical_convertible(&shape.inner)?)
}

/// Each face's surface kind, named as `GeomAbs_SurfaceType` names it.
pub fn surface_types(shape: &Shape) -> Result<Vec<&'static str>, Error> {
    const NAMES: [&str; 11] = [
        "GeomAbs_Plane",
        "GeomAbs_Cylinder",
        "GeomAbs_Cone",
        "GeomAbs_Sphere",
        "GeomAbs_Torus",
        "GeomAbs_BezierSurface",
        "GeomAbs_BSplineSurface",
        "GeomAbs_SurfaceOfRevolution",
        "GeomAbs_SurfaceOfExtrusion",
        "GeomAbs_OffsetSurface",
        "GeomAbs_OtherSurface",
    ];
    Ok(ffi::canonical_surface_types(&shape.inner)?
        .iter()
        .map(|&k| NAMES.get(k as usize).copied().unwrap_or("GeomAbs_OtherSurface"))
        .collect())
}

/// `ShapeCustom::SweptToElementary` over the whole shape.
pub fn swept_to_elementary(shape: &Shape) -> Result<Option<Shape>, Error> {
    let inner = ffi::canonical_swept_to_elementary(&shape.inner)?;
    Ok((!inner.is_null()).then_some(Shape { inner }))
}

/// Spline faces within `tol` of an analytic surface rebuilt on it, where the
/// mesher still draws the result, then sewn and made solid. The count is of
/// faces converted; no shape comes back when it is zero or nothing solid came
/// of the rebuild.
pub fn convert(work: &Shape, tol: f64) -> Result<(Option<Shape>, usize), Error> {
    let mut converted = 0;
    let inner = ffi::canonical_convert(&work.inner, tol, &mut converted)?;
    Ok(((!inner.is_null()).then_some(Shape { inner }), converted.max(0) as usize))
}
