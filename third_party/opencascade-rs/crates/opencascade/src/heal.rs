//! Shape healing (`ShapeFix_*`) and validity checking (`BRepCheck_Analyzer`).

use crate::{
    primitives::{Face, Shape, ShapeType, Wire},
    Error,
};
use opencascade_sys as ffi;

/// Tolerances for [`Shape::fix`]. A non-positive value keeps the ShapeFix default.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FixOptions {
    pub precision: f64,
    pub min_tolerance: f64,
    pub max_tolerance: f64,
}

/// A healed shape and what `Perform` returned. Not a reliable "changed" flag:
/// righting an inside-out solid leaves it false.
pub struct Fixed<T> {
    pub shape: T,
    pub modified: bool,
}

impl Shape {
    /// `ShapeFix_Shape`: the whole healing pipeline, solids, shells, faces, wires and edges.
    pub fn fix(&self, options: FixOptions) -> Result<Fixed<Shape>, Error> {
        let mut modified = false;
        let inner = ffi::shape_fix::ShapeFix_Shape_perform(
            &self.inner,
            options.precision,
            options.min_tolerance,
            options.max_tolerance,
            &ffi::message::Message_ProgressRange_new(),
            &mut modified,
        )?;
        Ok(Fixed { shape: Shape { inner }, modified })
    }

    /// `ShapeFix_Solid`: orients a solid outwards, or builds a solid from a closed shell.
    pub fn fix_solid(&self, precision: f64, max_tolerance: f64) -> Result<Shape, Error> {
        match self.shape_type() {
            ShapeType::Shell | ShapeType::Solid => {},
            _ => return Err(Error::InvalidInput("ShapeFix_Solid takes a solid or a shell")),
        }
        let inner = ffi::shape_fix::ShapeFix_Solid_perform(&self.inner, precision, max_tolerance)?;
        if inner.IsNull() {
            return Err(Error::OperationFailed("ShapeFix_Solid"));
        }
        Ok(Shape { inner })
    }

    /// `BRepCheck_Analyzer::IsValid` with geometric checks on, the sub-shapes
    /// checked on OpenCASCADE's thread pool.
    pub fn is_valid(&self) -> Result<bool, Error> {
        Ok(ffi::b_rep_check::BRepCheck_Analyzer_is_valid(&self.inner, true, true, false)?)
    }

    #[must_use]
    pub fn reversed(&self) -> Shape {
        Shape { inner: ffi::topo_ds::TopoDS_Shape_reversed(&self.inner) }
    }

    /// Every sub-shape of `shape_type`, in `TopExp_Explorer` order (shared ones repeat).
    pub fn subshapes(&self, shape_type: ShapeType) -> Vec<Shape> {
        let mut explorer = ffi::top_exp::TopExp_Explorer_new(&self.inner, shape_type.into());
        let mut out = Vec::new();
        while explorer.More() {
            out.push(Shape::from_shape(explorer.Current()));
            explorer.pin_mut().Next();
        }
        out
    }
}

impl Wire {
    /// `ShapeFix_Wire` against the face the wire bounds.
    pub fn fix(&self, face: &Face, precision: f64) -> Result<Fixed<Wire>, Error> {
        let mut modified = false;
        let inner =
            ffi::shape_fix::ShapeFix_Wire_perform(&self.inner, &face.inner, precision, &mut modified)?;
        Ok(Fixed { shape: Wire { inner }, modified })
    }
}

impl Face {
    /// `ShapeFix_Face`. A shape, not a face: fixing a missing seam can split the face.
    pub fn fix(&self, precision: f64) -> Result<Fixed<Shape>, Error> {
        let mut modified = false;
        let inner = ffi::shape_fix::ShapeFix_Face_perform(&self.inner, precision, &mut modified)?;
        Ok(Fixed { shape: Shape { inner }, modified })
    }
}
