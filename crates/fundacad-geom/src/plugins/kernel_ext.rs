//! The kernel calls a ported plugin needed beyond the first set: surface
//! frames and samples, a face's stored triangulation, edges and wires, a
//! rotation, a helical sweep, a boolean with options and face selectors, and
//! the smooth-surface set: ellipse edges, lofts, interpolated edges and an
//! affine map.

use opencascade::primitives::Shape;
use opencascade_sys::plugin_ops as ffi;
use serde_json::Value;

use super::host::types::{
    BooleanOp, BooleanOptions, FaceTriangulation, Fuzzy, SurfaceFrame, SurfaceSample, Vec3,
};
use super::host::kernel::LoftOptions;
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

extern "C" {
    fn fc_delaunay_2d(xy: *const f64, n: i32, out: *mut i32, cap: i32, count: *mut i32, err: *mut u8, errlen: i32) -> i32;
}

/// scipy.spatial.Delaunay's triangles of 2D points, from the same Qhull run
/// the same way (third_party/qhull/fc_delaunay.c).
pub fn delaunay_2d(points: &[f64]) -> Result<Vec<u32>, String> {
    if points.len() % 2 != 0 {
        return Err("points come as x, y pairs".into());
    }
    if points.iter().any(|v| v.is_nan()) {
        return Err("Points cannot contain NaN".into());
    }
    let n = i32::try_from(points.len() / 2).map_err(|_| "too many points".to_string())?;
    let cap = n.saturating_mul(2).saturating_add(16);
    let mut out = vec![0i32; cap as usize * 3];
    let mut count = 0i32;
    let mut err = vec![0u8; 2048];
    // SAFETY: every buffer is sized as the call is told, and the C side only
    // writes within `cap` triangles and `errlen` bytes.
    let code = unsafe {
        fc_delaunay_2d(points.as_ptr(), n, out.as_mut_ptr(), cap, &mut count, err.as_mut_ptr(), err.len() as i32)
    };
    if code != 0 {
        let end = err.iter().position(|&b| b == 0).unwrap_or(err.len());
        let text = String::from_utf8_lossy(&err[..end]).trim().to_string();
        return Err(if text.is_empty() { format!("qhull failed with code {code}") } else { text });
    }
    out.truncate(count as usize * 3);
    Ok(out.into_iter().map(|i| i as u32).collect())
}

pub fn select_faces(shape: &Shape, selectors: &str) -> Result<Vec<Shape>, crate::builder::Fail> {
    let sel: Value = serde_json::from_str(selectors)
        .map_err(|e| crate::builder::Fail::msg(format!("the selector does not parse: {e}")))?;
    crate::select::Resolver::new(None, None).faces(shape, &sel)
}

pub fn ellipse_edge(c: Vec3, n: Vec3, x: Vec3, rx: f64, ry: f64, start: f64) -> Result<Shape, String> {
    finite(&[c.0, c.1, c.2, rx, ry, start])?;
    let n = unit(n)?;
    let x = unit(x)?;
    let along = x.0 * n.0 + x.1 * n.1 + x.2 * n.2;
    if along.abs() > 1.0 - 1e-9 {
        return Err("an ellipse's x direction must not lie along its normal".into());
    }
    if !(rx > 0.0 && ry > 0.0) {
        return Err("an ellipse needs both radii greater than 0".into());
    }
    let p = [c.0, c.1, c.2, n.0, n.1, n.2, x.0, x.1, x.2, rx, ry, start];
    nonnull(ffi::po_ellipse_edge(&p), "an ellipse")
}

pub fn loft(sections: &[&Shape], start: Option<Vec3>, end: Option<Vec3>, o: &LoftOptions) -> Result<Shape, String> {
    let ends = usize::from(start.is_some()) + usize::from(end.is_some());
    if sections.is_empty() || sections.len() + ends < 2 {
        return Err("a loft needs at least two sections, or one and a point".into());
    }
    let mut caps = [0.0; 8];
    for (i, p) in [start, end].into_iter().enumerate() {
        if let Some(p) = p {
            finite(&[p.0, p.1, p.2])?;
            caps[i * 4..i * 4 + 4].copy_from_slice(&[1.0, p.0, p.1, p.2]);
        }
    }
    let c = kernel::compound(sections.iter().copied());
    let out = nonnull(
        ffi::po_loft(c.raw(), &caps, o.ruled, o.smooth, o.match_seams),
        "a loft through these sections",
    )?;
    if kernel::volume(&out).abs() < 1e-9 {
        return Err("the loft through these sections is empty".into());
    }
    Ok(out)
}

pub fn interpolate_edge(points: &[Vec3], closed: bool) -> Result<Shape, String> {
    let flat: Vec<f64> = points.iter().flat_map(|p| [p.0, p.1, p.2]).collect();
    finite(&flat)?;
    if points.len() < 2 || (closed && points.len() < 3) {
        return Err("an interpolated edge needs at least two points, three when closed".into());
    }
    nonnull(ffi::po_interpolate_edge(&flat, closed), "a curve through these points")
}

pub fn gtransform(s: &Shape, m: &[f64]) -> Result<Shape, String> {
    if m.len() != 12 {
        return Err("an affine map is twelve numbers, three rows of four".into());
    }
    finite(m)?;
    nonnull(ffi::po_gtransform(s.raw(), m), "the shape under this map (it must not mirror or flatten)")
}
