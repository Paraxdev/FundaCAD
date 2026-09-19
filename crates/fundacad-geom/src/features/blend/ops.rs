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
    let began = std::time::Instant::now();
    let r = crate::bench::phase("blend_fillet", || ffi::blend_fillet(shape.raw(), es.raw(), radii, &mut status));
    traced("BRepFilletAPI_MakeFillet", began, built(r, status), || {
        format!("shape={}, {} edges, radii={radii:?}", kernel::describe(shape), edges.len())
    })
}

pub fn chamfer(
    shape: &Shape,
    edges: &[Shape],
    d1: &[f64],
    d2: &[f64],
) -> Result<(Shape, Built), String> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let began = std::time::Instant::now();
    let r = crate::bench::phase("blend_chamfer", || ffi::blend_chamfer(shape.raw(), es.raw(), d1, d2, &mut status));
    traced("BRepFilletAPI_MakeChamfer", began, built(r, status), || {
        format!("shape={}, {} edges, d1={d1:?}, d2={d2:?}", kernel::describe(shape), edges.len())
    })
}

/// A blend that throws, is not done, or builds an invalid shape all count as a
/// failure for the error report, the caller still decides what to do with it.
fn traced(
    op: &'static str,
    began: std::time::Instant,
    r: Result<(Shape, Built), String>,
    args: impl FnOnce() -> String,
) -> Result<(Shape, Built), String> {
    let ms = Some(began.elapsed().as_secs_f64() * 1000.0);
    let error = match &r {
        Err(e) => e.clone(),
        Ok((_, Built::NotDone)) => "IsDone() is false".into(),
        Ok((_, Built::Invalid)) => "result fails BRepCheck_Analyzer".into(),
        Ok((_, Built::Done)) => return r,
    };
    crate::trace::failed(op, Some(args()), error, ms);
    r
}

/// blends.py `_kernel_copy`, `None` when an edge has no image in the copy.
pub fn copy(shape: &Shape, edges: &[Shape]) -> Option<(Shape, Vec<Shape>)> {
    let es = kernel::compound(edges);
    let v = crate::bench::phase("blend_copy", || ffi::blend_copy(shape.raw(), es.raw())).ok()?;
    let mut all: Vec<Shape> = v.as_ref()?.iter().map(Shape::from_raw_ref).collect();
    if all.is_empty() {
        return None;
    }
    let copied = all.split_off(1);
    Some((all.remove(0), copied))
}

pub fn is_seam(shape: &Shape, edge: &Shape) -> bool {
    crate::bench::phase("blend_is_seam", || ffi::blend_is_seam(shape.raw(), edge.raw()))
}

/// blends.py `_edge_dihedral_deg`.
pub fn dihedral_deg(shape: &Shape, edge: &Shape) -> Option<f64> {
    let mid = EdgeEnt::new(edge.clone()).ok()?.mid;
    let d = crate::bench::phase("blend_dihedral", || {
        ffi::blend_dihedral_deg(shape.raw(), edge.raw(), mid.x, mid.y, mid.z)
    });
    (d >= 0.0).then_some(d)
}

/// Per triangle `[face index, a, b, c]` flattened, see blend_overlap.py `_triangles`.
pub fn face_triangles(faces: &[Shape], deflection: f64) -> Result<Vec<f64>, String> {
    let comp = kernel::compound(faces);
    crate::bench::phase("blend_face_triangles", || ffi::blend_face_triangles(comp.raw(), deflection))
        .map_err(|e| exception_text(&e))
}

/// conic_blend.py `conic_blend`.
pub fn conic(shape: &Shape, edges: &[Shape], radius: f64, profile: f64) -> Result<Shape, BlendErr> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let mut message = String::new();
    let out = crate::bench::phase("blend_conic", || {
        ffi::blend_conic(shape.raw(), es.raw(), radius, profile, &mut status, &mut message)
    });
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
///
/// Cutting every tool at once can leave the tools' faces inside the result,
/// lying on the faces that replaced them. BRepCheck passes such a solid, the
/// viewport draws both layers and a section cap streaks. Which answer folds
/// depends on how the body happens to be oriented, so a folded one is built
/// again without the one-shot cut, and refused if that folds too.
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
    let built = section_with(shape, edges, chamfer, sizes, size2, g2, draft, profile, true)?;
    if !super::overlap::folds_over_itself(shape, &built) {
        return Ok(built);
    }
    let again = section_with(shape, edges, chamfer, sizes, size2, g2, draft, profile, false)?;
    if super::overlap::folds_over_itself(shape, &again) {
        return Err(SectionErr::Blend(
            "at this size the blend folds over itself".into(),
        ));
    }
    Ok(again)
}

#[allow(clippy::too_many_arguments)]
fn section_with(
    shape: &Shape,
    edges: &[Shape],
    chamfer: bool,
    sizes: &[f64],
    size2: Option<f64>,
    g2: bool,
    draft: bool,
    profile: f64,
    one_shot: bool,
) -> Result<Shape, SectionErr> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let mut message = String::new();
    let progress = crate::cancel::progress();
    let range = progress.start();
    let out = crate::bench::phase("blend_section", || {
        ffi::blend_section(
            shape.raw(),
            es.raw(),
            chamfer,
            sizes,
            size2.unwrap_or(f64::NAN),
            g2,
            draft,
            profile,
            one_shot,
            range.raw(),
            &mut status,
            &mut message,
        )
    });
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
        3 => Err(SectionErr::Cancelled),
        _ => Err(SectionErr::Internal(message)),
    }
}

pub fn is_valid(shape: &Shape) -> bool {
    crate::bench::phase("blend_is_valid", || ffi::blend_is_valid(shape.raw()))
}
