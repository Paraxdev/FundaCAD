//! The kernel calls a ported plugin needed beyond the first set: surface
//! frames and samples, a face's stored triangulation, edges and wires, a
//! rotation, a helical sweep, a boolean with options and face selectors.

use opencascade::primitives::Shape;
use opencascade_sys::plugin_ops as ffi;
use serde_json::Value;

use super::host::fail_text;
use super::host::types::{
    BooleanOp, BooleanOptions, FaceTriangulation, Fuzzy, SurfaceFrame, SurfaceSample, Vec3,
};
use super::kernel_api::{finite, nonnull, unit};
use crate::kernel;

pub fn is_reversed(s: &Shape) -> bool {
    ffi::po_is_reversed(s.raw())
}

const SURFACE_KINDS: [&str; 11] = [
    "plane", "cylinder", "cone", "sphere", "torus", "bezier", "bspline", "revolution",
    "extrusion", "offset", "other",
];

pub fn surface_frame(face: &Shape) -> Option<SurfaceFrame> {
    let mut o = [0.0; 18];
    let code = ffi::po_surface_frame(face.raw(), &mut o);
    let kind = SURFACE_KINDS.get(usize::try_from(code).ok()?).unwrap_or(&"other");
    let v = |i: usize| (o[i], o[i + 1], o[i + 2]);
    Some(SurfaceFrame {
        kind: (*kind).to_string(),
        origin: v(0),
        x_dir: v(3),
        y_dir: v(6),
        z_dir: v(9),
        radius: o[12],
        semi_angle: o[13],
        u_first: o[14],
        u_last: o[15],
        v_first: o[16],
        v_last: o[17],
    })
}

pub fn surface_samples(face: &Shape, uvs: &[f64], tol: f64) -> Vec<SurfaceSample> {
    ffi::po_surface_samples(face.raw(), uvs, tol)
        .chunks_exact(13)
        .map(|c| SurfaceSample {
            point: (c[0], c[1], c[2]),
            du: (c[3], c[4], c[5]),
            dv: (c[6], c[7], c[8]),
            normal: (c[9] > 0.5).then_some((c[10], c[11], c[12])),
        })
        .collect()
}

pub fn triangulation(face: &Shape) -> Option<FaceTriangulation> {
    let raw = ffi::po_triangulation(face.raw());
    if raw.len() < 2 {
        return None;
    }
    let (n, m) = (raw[0] as usize, raw[1] as usize);
    if raw.len() != 2 + n * 5 + m * 3 {
        return None;
    }
    Some(FaceTriangulation {
        positions: raw[2..2 + n * 3].to_vec(),
        uvs: raw[2 + n * 3..2 + n * 5].to_vec(),
        indices: raw[2 + n * 5..].iter().map(|&i| i as u32).collect(),
    })
}

pub fn rotate(s: &Shape, o: Vec3, a: Vec3, degrees: f64) -> Result<Shape, String> {
    finite(&[o.0, o.1, o.2, degrees])?;
    let a = unit(a)?;
    nonnull(
        ffi::po_rotate(s.raw(), o.0, o.1, o.2, a.0, a.1, a.2, degrees),
        "a rotated shape",
    )
}

pub fn line_edge(a: Vec3, b: Vec3) -> Result<Shape, String> {
    finite(&[a.0, a.1, a.2, b.0, b.1, b.2])?;
    nonnull(ffi::po_line_edge(a.0, a.1, a.2, b.0, b.1, b.2), "a line edge")
}

pub fn arc_edge(a: Vec3, m: Vec3, b: Vec3) -> Result<Shape, String> {
    let pts = [a.0, a.1, a.2, m.0, m.1, m.2, b.0, b.1, b.2];
    finite(&pts)?;
    nonnull(ffi::po_arc_edge(&pts), "an arc through these three points")
}

pub fn circle_edge(c: Vec3, n: Vec3, r: f64) -> Result<Shape, String> {
    finite(&[c.0, c.1, c.2, r])?;
    let n = unit(n)?;
    if !(r > 0.0) {
        return Err("a circle needs a radius greater than 0".into());
    }
    nonnull(ffi::po_circle_edge(c.0, c.1, c.2, n.0, n.1, n.2, r), "a circle")
}

pub fn wire_from_edges(edges: &[&Shape]) -> Result<Shape, String> {
    if edges.is_empty() {
        return Err("a wire needs at least one edge".into());
    }
    let c = kernel::compound(edges.iter().copied());
    nonnull(ffi::po_wire(c.raw()), "a wire from these edges")
}

pub fn helical_sweep(profile: &Shape, o: Vec3, a: Vec3, degrees: f64, pitch: f64) -> Result<Shape, String> {
    finite(&[o.0, o.1, o.2, degrees, pitch])?;
    let a = unit(a)?;
    if pitch == 0.0 || degrees == 0.0 {
        return Err("a helical sweep needs a pitch and an angle".into());
    }
    nonnull(
        ffi::po_helical_sweep(profile.raw(), o.0, o.1, o.2, a.0, a.1, a.2, degrees, pitch),
        "a helical sweep of this profile",
    )
}

pub fn boolean_with(
    op: BooleanOp,
    base: &Shape,
    tools: &[&Shape],
    options: &BooleanOptions,
) -> Result<Shape, String> {
    let (kind, verb) = match op {
        BooleanOp::Fuse => (0, "join"),
        BooleanOp::Cut => (1, "cut"),
        BooleanOp::Common => (2, "intersect"),
    };
    if tools.is_empty() {
        return Err(format!("nothing to {verb} with"));
    }
    let fuzzy = match options.fuzzy {
        Fuzzy::Exact => 0.0,
        Fuzzy::Value(v) if v.is_finite() && v > 0.0 => v,
        Fuzzy::Value(_) => return Err("a fuzzy value must be a positive number".into()),
        Fuzzy::Picked => {
            let mut ext = kernel::extent(base);
            for t in tools {
                if let Some(e) = kernel::extent(t) {
                    ext = Some(ext.map_or(e, |m| m.max(e)));
                }
            }
            kernel::pick_fuzz(ext)
        }
    };
    let c = kernel::compound(tools.iter().copied());
    let mut status = 0;
    let out = Shape::from_raw(ffi::po_boolean_with(
        kind,
        base.raw(),
        c.raw(),
        options.parallel,
        fuzzy,
        options.clean,
        &mut status,
    ));
    if status != 0 || kernel::is_null(&out) {
        return Err(format!("the geometry engine could not {verb} this body"));
    }
    Ok(out)
}

pub fn select_faces(shape: &Shape, selectors: &str) -> Result<Vec<Shape>, String> {
    let sel: Value =
        serde_json::from_str(selectors).map_err(|e| format!("the selector does not parse: {e}"))?;
    crate::select::Resolver::new(None, None)
        .faces(shape, &sel)
        .map_err(fail_text)
}
