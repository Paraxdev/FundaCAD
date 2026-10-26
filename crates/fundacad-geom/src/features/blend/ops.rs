//! The kernel calls the blend port makes, over opencascade-sys `blend_ops`.

use cxx::UniquePtr;
use opencascade::primitives::Shape;
use opencascade_sys::blend_ops as ffi;
use opencascade_sys::topo_ds::TopoDS_Shape;

use super::{BlendErr, Fits, Misfit, SectionErr};
use crate::kernel;
use crate::select::entity::EdgeEnt;

/// A round of the last section build on this thread that runs past one of its
/// faces: the largest size at which it rests on both, and a point on its edge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Overrun {
    pub fits: Option<f64>,
    pub at: [f64; 3],
}

thread_local! {
    static OVERRUN: std::cell::Cell<Option<Overrun>> = const { std::cell::Cell::new(None) };
}

pub fn take_overrun() -> Option<Overrun> {
    OVERRUN.with(std::cell::Cell::take)
}

fn overrun_of(message: &str) -> Option<Overrun> {
    let rest = message.strip_prefix("overrun ")?;
    let n: Vec<f64> = rest.split(' ').filter_map(|w| w.parse().ok()).collect();
    match n.as_slice() {
        [fits, x, y, z] => Some(Overrun { fits: Some(*fits).filter(|k| *k > 0.0), at: [*x, *y, *z] }),
        _ => None,
    }
}

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
    /// A fillet's shape is then a compound of the vertices the kernel gave up at.
    NotDone,
    Invalid,
}

fn built(r: Result<UniquePtr<TopoDS_Shape>, cxx::Exception>, status: i32) -> Result<(Shape, Built), String> {
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
    let (shape, n, radii) = (shape.clone(), edges.len(), radii.to_vec());
    traced("BRepFilletAPI_MakeFillet", began, built(r, status), move || {
        format!("shape={}, {n} edges, radii={radii:?}", kernel::describe(&shape))
    })
}

pub fn chamfer(shape: &Shape, edges: &[Shape], d1: &[f64], d2: &[f64]) -> Result<(Shape, Built), String> {
    let es = kernel::compound(edges);
    let mut status = 0;
    let began = std::time::Instant::now();
    let r = crate::bench::phase("blend_chamfer", || ffi::blend_chamfer(shape.raw(), es.raw(), d1, d2, &mut status));
    let (shape, n, d1, d2) = (shape.clone(), edges.len(), d1.to_vec(), d2.to_vec());
    traced("BRepFilletAPI_MakeChamfer", began, built(r, status), move || {
        format!("shape={}, {n} edges, d1={d1:?}, d2={d2:?}", kernel::describe(&shape))
    })
}

/// A blend that throws, is not done, or builds an invalid shape all count as a
/// failure for the error report, the caller still decides what to do with it.
fn traced(
    op: &'static str,
    began: std::time::Instant,
    r: Result<(Shape, Built), String>,
    args: impl FnOnce() -> String + 'static,
) -> Result<(Shape, Built), String> {
    let ms = Some(began.elapsed().as_secs_f64() * 1000.0);
    let error = match &r {
        Err(e) => e.clone(),
        Ok((_, Built::NotDone)) => "IsDone() is false".into(),
        Ok((_, Built::Invalid)) => "result fails BRepCheck_Analyzer".into(),
        Ok((_, Built::Done)) => return r,
    };
    crate::trace::failed_later(op, args, error, ms);
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
    let body = all.remove(0);
    kernel::remember_copy(shape, &body);
    Some((body, copied))
}

/// blends.py `_edge_dihedral_deg`.
pub fn dihedral_deg(shape: &Shape, edge: &Shape) -> Option<f64> {
    let mid = EdgeEnt::new(edge.clone()).ok()?.mid;
    let d =
        crate::bench::phase("blend_dihedral", || ffi::blend_dihedral_deg(shape.raw(), edge.raw(), mid.x, mid.y, mid.z));
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
                Err(BlendErr::Kernel("Fillet: the conic profile produced no usable solid".into()))
            } else {
                Ok(shape)
            }
        }
        1 => Err(BlendErr::Conic(message)),
        _ => Err(BlendErr::Kernel(message)),
    }
}

/// section_blend.py `section_blend` through blends.py `section_fn`. Cutting every tool at once can leave tool
/// faces inside the result on the faces that replaced them, which BRepCheck passes. Which answer folds depends on
/// the body's orientation, so a folded one is built again without the one-shot cut, and refused if that folds too.
/// `continuity` is 1, 2 or 3, the section's continuity with the faces.
#[allow(clippy::too_many_arguments)]
pub fn section(
    shape: &Shape,
    edges: &[Shape],
    chamfer: bool,
    sizes: &[f64],
    size2: Option<f64>,
    unit: f64,
    continuity: i32,
    draft: bool,
    profile: f64,
) -> Result<Shape, SectionErr> {
    let built = section_with(shape, edges, chamfer, sizes, size2, unit, continuity, draft, profile, true)?;
    let size = sizes.iter().copied().fold(f64::INFINITY, f64::min).min(size2.unwrap_or(f64::INFINITY));
    if !super::overlap::folds_over_itself(shape, &built, size) {
        return Ok(built);
    }
    let again = section_with(shape, edges, chamfer, sizes, size2, unit, continuity, draft, profile, false)?;
    if super::overlap::folds_over_itself(shape, &again, size) {
        return Err(SectionErr::Blend("at this size the blend folds over itself".into()));
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
    unit: f64,
    continuity: i32,
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
            unit,
            continuity,
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
                Err(SectionErr::Value("the blend produced no usable solid".into()))
            } else {
                OVERRUN.with(|c| c.set(overrun_of(&message)));
                Ok(shape)
            }
        }
        1 => Err(SectionErr::Blend(message)),
        3 => Err(SectionErr::Cancelled),
        4 => {
            let n: Vec<f64> = message.split(' ').filter_map(|w| w.parse().ok()).collect();
            match n.as_slice() {
                [why, fits, x, y, z] => Err(SectionErr::TooLarge {
                    why: Misfit::from_code(*why as i32),
                    fits: match *fits {
                        k if k > 0.0 => Fits::UpTo(k),
                        k if k > -1.5 => Fits::Nothing,
                        _ => Fits::Unknown,
                    },
                    at: [*x, *y, *z],
                }),
                _ => Err(SectionErr::Internal(message)),
            }
        }
        _ => Err(SectionErr::Internal(message)),
    }
}

/// The highest continuity (1, 2 or 3) the section build reaches on `edge` of `shape`.
pub fn reach(shape: &Shape, edge: &Shape) -> u8 {
    ffi::blend_reach(shape.raw(), edge.raw()).clamp(1, 3) as u8
}

/// How smoothly a blended body's faces meet, see blend_measure.hxx.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContactJumps {
    /// The largest curvature jump across a tangent contact, times the radius.
    pub curvature: f64,
    /// The largest jump in the curvature's rate along the walk across it, times the radius squared.
    pub rate: f64,
    /// The largest angle, in degrees, between faces that meet within 5 degrees.
    pub crease_deg: f64,
    pub contacts: usize,
    pub max_tolerance: f64,
    pub valid: bool,
}

/// `reach` is about the blend's setback; the walks span 4 percent of it into each face.
pub fn contact_jumps(shape: &Shape, radius: f64, reach: f64) -> ContactJumps {
    let v = ffi::blend_contact_jumps(shape.raw(), radius, reach);
    ContactJumps {
        curvature: v[0],
        rate: v[1],
        crease_deg: v[2],
        contacts: v[3] as usize,
        max_tolerance: v[4],
        valid: v[5] > 0.5,
    }
}

pub fn is_valid(shape: &Shape) -> bool {
    crate::bench::phase("blend_is_valid", || ffi::blend_is_valid(shape.raw()))
}
