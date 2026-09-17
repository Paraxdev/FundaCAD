//! The kernel calls the blend port makes, over opencascade-sys `blend_ops`.

use cxx::UniquePtr;
use opencascade::primitives::Shape;
use opencascade_sys::blend_ops as ffi;
use opencascade_sys::topo_ds::TopoDS_Shape;

use super::{BlendErr, SectionErr};
use crate::kernel;
use crate::select::entity::EdgeEnt;

/// What a Python caller of an OCP exception reads: the detail, else the class.
fn exception_text(e: &cxx::Exception) -> String {
    let what = e.what();
    match what.split_once(": ") {
        Some((_, detail)) if !detail.is_empty() => detail.to_owned(),
        _ => what.to_owned(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Built {
    Done,
    NotDone,
    Invalid,
}

fn built(
    r: Result<UniquePtr<TopoDS_Shape>, cxx::Exception>,
    status: i32,
) -> Result<(Shape, Built), String> {
    let p = r.map_err(|e| exception_text(&e))?;
    let state = match status {
        0 => Built::Done,
        1 => Built::NotDone,
        _ => Built::Invalid,
    };
    Ok((Shape::from_raw(p), state))
}

pub fn fillet(shape: &Shape, edges: &[Shape], radii: &[f64]) -> Result<(Shape, Built), String> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let r = ffi::blend_fillet(shape.raw(), es.raw(), radii, &mut status);
    built(r, status)
}

pub fn chamfer(
    shape: &Shape,
    edges: &[Shape],
    d1: &[f64],
    d2: &[f64],
) -> Result<(Shape, Built), String> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let r = ffi::blend_chamfer(shape.raw(), es.raw(), d1, d2, &mut status);
    built(r, status)
}

/// blends.py `_kernel_copy`, `None` when an edge has no image in the copy.
pub fn copy(shape: &Shape, edges: &[Shape]) -> Option<(Shape, Vec<Shape>)> {
    let es = kernel::compound(edges);
    let v = ffi::blend_copy(shape.raw(), es.raw()).ok()?;
    let mut all: Vec<Shape> = v.as_ref()?.iter().map(Shape::from_raw_ref).collect();
    if all.is_empty() {
        return None;
    }
    let copied = all.split_off(1);
    Some((all.remove(0), copied))
}

pub fn is_seam(shape: &Shape, edge: &Shape) -> bool {
    ffi::blend_is_seam(shape.raw(), edge.raw())
}

/// blends.py `_edge_dihedral_deg`.
pub fn dihedral_deg(shape: &Shape, edge: &Shape) -> Option<f64> {
    let mid = EdgeEnt::new(edge.clone()).ok()?.mid;
    let d = ffi::blend_dihedral_deg(shape.raw(), edge.raw(), mid.x, mid.y, mid.z);
    (d >= 0.0).then_some(d)
}

/// Per triangle `[face index, a, b, c]` flattened, see blend_overlap.py `_triangles`.
pub fn face_triangles(faces: &[Shape], deflection: f64) -> Result<Vec<f64>, String> {
    let comp = kernel::compound(faces);
    ffi::blend_face_triangles(comp.raw(), deflection).map_err(|e| exception_text(&e))
}

/// conic_blend.py `conic_blend`.
pub fn conic(shape: &Shape, edges: &[Shape], radius: f64, profile: f64) -> Result<Shape, BlendErr> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let mut message = String::new();
    let out = ffi::blend_conic(
        shape.raw(),
        es.raw(),
        radius,
        profile,
        &mut status,
        &mut message,
    );
    match status {
        0 if !out.is_null() => {
            let shape = Shape::from_raw(out);
            if kernel::is_null(&shape) {
                Err(BlendErr::Kernel(
                    "Fillet: the conic profile produced no usable solid".into(),
                ))
            } else {
                Ok(shape)
            }
        }
        1 => Err(BlendErr::Conic(message)),
        _ => Err(BlendErr::Kernel(message)),
    }
}

/// section_blend.py `section_blend` through blends.py `section_fn`.
#[allow(clippy::too_many_arguments)]
pub fn section(
    shape: &Shape,
    edges: &[Shape],
    chamfer: bool,
    sizes: &[f64],
    size2: Option<f64>,
    g2: bool,
    draft: bool,
    profile: f64,
) -> Result<Shape, SectionErr> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let mut message = String::new();
    let out = ffi::blend_section(
        shape.raw(),
        es.raw(),
        chamfer,
        sizes,
        size2.unwrap_or(f64::NAN),
        g2,
        draft,
        profile,
        &mut status,
        &mut message,
    );
    match status {
        0 if !out.is_null() => {
            let shape = Shape::from_raw(out);
            if kernel::is_null(&shape) {
                Err(SectionErr::Value(
                    "the blend produced no usable solid".into(),
                ))
            } else {
                Ok(shape)
            }
        }
        1 => Err(SectionErr::Blend(message)),
        _ => Err(SectionErr::Internal(message)),
    }
}

pub fn is_valid(shape: &Shape) -> bool {
    ffi::blend_is_valid(shape.raw())
}
