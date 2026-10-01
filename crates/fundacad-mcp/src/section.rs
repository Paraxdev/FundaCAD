//! `section`: a body cut by a plane, as the outline in the plane and the
//! properties a beam calculation needs, area, centroid and second moments.
//!
//! Cut from the body's triangles rather than its exact faces: every triangle
//! the plane crosses gives one segment, and the segments chain into closed
//! loops because the faces of a solid share their edges' points. The triangles
//! are asked for at a fine tolerance, so a 5 mm radius is a polygon whose area
//! is within a fraction of a percent of the circle's.

use std::collections::HashMap;

use serde_json::Value;

use crate::describe::g_format;
use crate::mesh::MeshBody;

/// The chord tolerance the section asks the engine to mesh at, in mm.
pub const TOLERANCE: f64 = 0.01;

/// A cutting plane: a point on it, its normal, and the two in-plane axes the
/// outline is written in, with u x v = n.
#[derive(Debug, Clone)]
pub struct Plane {
    pub origin: [f64; 3],
    pub n: [f64; 3],
    pub u: [f64; 3],
    pub v: [f64; 3],
    /// How the plane reads in a reply: "Z = 10" or the point and normal.
    pub label: String,
    /// The names of u and v, "X" and "Y" for a plane across Z.
    pub axes: (String, String),
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn unit(a: [f64; 3]) -> Option<[f64; 3]> {
    let l = dot(a, a).sqrt();
    (l > 1e-12).then(|| [a[0] / l, a[1] / l, a[2] / l])
}

fn vec3(v: &Value) -> Option<[f64; 3]> {
    let a = v.as_array()?;
    if a.len() != 3 {
        return None;
    }
    Some([a[0].as_f64()?, a[1].as_f64()?, a[2].as_f64()?])
}

/// `axis` and `at`, or `origin` and `normal`.
pub fn plane_of(args: &serde_json::Map<String, Value>) -> Result<Plane, String> {
    let at = match args.get("at").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => Some(v.as_f64().ok_or_else(|| format!("`at` is a distance in mm, got {v}"))?),
    };
    if let Some(axis) = args.get("axis").and_then(Value::as_str) {
        if args.contains_key("origin") || args.contains_key("normal") {
            return Err("give `axis` and `at`, or `origin` and `normal`, not both".into());
        }
        let at = at.ok_or("a section across an axis needs `at`, where along it to cut, in mm")?;
        let (n, u, v, names) = match axis.trim().to_ascii_uppercase().as_str() {
            "X" => ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], ("Y", "Z")),
            "Y" => ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], ("Z", "X")),
            "Z" => ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], ("X", "Y")),
            other => return Err(format!("`axis` is X, Y or Z, got '{other}'")),
        };
        let origin = [n[0] * at, n[1] * at, n[2] * at];
        return Ok(Plane {
            origin,
            n,
            u,
            v,
            label: format!("{} = {}", axis.trim().to_ascii_uppercase(), g_format(at)),
            axes: (names.0.into(), names.1.into()),
        });
    }
    let (Some(o), Some(nv)) = (args.get("origin"), args.get("normal")) else {
        return Err("say where to cut: {axis: \"Z\", at: 10}, or origin [x,y,z] and normal [x,y,z]".into());
    };
    let origin = vec3(o).ok_or("`origin` is [x, y, z] in mm")?;
    let n = vec3(nv).and_then(unit).ok_or("`normal` is a direction [x, y, z], not zero")?;
    // u along whichever world axis is least like the normal, made square to it.
    let pick = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let u = unit(cross(cross(n, pick), n)).expect("pick is not parallel to n");
    let v = cross(n, u);
    let r = |a: [f64; 3]| format!("({}, {}, {})", g_format(round(a[0], 6)), g_format(round(a[1], 6)), g_format(round(a[2], 6)));
    // `at` slides the plane along its normal; the label and every number
    // in the reply are measured from where it ends up.
    let origin = match at {
        Some(t) => [origin[0] + n[0] * t, origin[1] + n[1] * t, origin[2] + n[2] * t],
        None => origin,
    };
    Ok(Plane {
        origin,
        n,
        u,
        v,
        label: format!("the plane through {} normal to {}", r(origin), r(n)),
        axes: (format!("u {}", r(u)), format!("v {}", r(v))),
    })
}

fn round(x: f64, places: i32) -> f64 {
    let k = 10f64.powi(places);
    let r = (x * k).round() / k;
    if r == 0.0 { 0.0 } else { r }
}

/// The cut through one body: closed loops in (u, v), counter-clockwise for
/// material and clockwise for holes, plus any chain that did not close.
#[derive(Debug, Default)]
pub struct Cut {
    pub loops: Vec<Vec<[f64; 2]>>,
    pub open: Vec<Vec<[f64; 2]>>,
}

/// Where a triangle edge from `a` to `b` crosses the plane, written so the
/// two triangles that share the edge compute the very same point.
fn crossing(a: ([f64; 3], f64), b: ([f64; 3], f64)) -> [f64; 3] {
    let (p, q) = if (a.0[0], a.0[1], a.0[2]) <= (b.0[0], b.0[1], b.0[2]) { (a, b) } else { (b, a) };
    let t = p.1 / (p.1 - q.1);
    [p.0[0] + (q.0[0] - p.0[0]) * t, p.0[1] + (q.0[1] - p.0[1]) * t, p.0[2] + (q.0[2] - p.0[2]) * t]
}

fn key(p: [f64; 2]) -> (i64, i64) {
    ((p[0] * 1e5).round() as i64, (p[1] * 1e5).round() as i64)
}

/// Cut a body's triangles with the plane.
pub fn cut(body: &MeshBody, plane: &Plane) -> Cut {
    let pos = &body.positions;
    let point = |i: u32| -> [f64; 3] {
        let k = i as usize * 3;
        [pos[k] as f64, pos[k + 1] as f64, pos[k + 2] as f64]
    };
    let in_plane = |p: [f64; 3]| -> [f64; 2] {
        let d = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
        [dot(d, plane.u), dot(d, plane.v)]
    };
    let mut segments: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for tri in body.indices.chunks_exact(3) {
        let ps: Vec<([f64; 3], f64)> = tri
            .iter()
            .map(|&i| {
                let p = point(i);
                let d = dot([p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]], plane.n);
                // A point exactly on the plane counts as above it, so a face
                // lying in the plane cuts nothing and an edge in it is cut once.
                (p, if d == 0.0 { 1e-12 } else { d })
            })
            .collect();
        let mut exit = None;
        let mut enter = None;
        for k in 0..3 {
            let (a, b) = (ps[k], ps[(k + 1) % 3]);
            if a.1 > 0.0 && b.1 < 0.0 {
                exit = Some(crossing(a, b));
            } else if a.1 < 0.0 && b.1 > 0.0 {
                enter = Some(crossing(a, b));
            }
        }
        if let (Some(x), Some(e)) = (exit, enter) {
            let (s, t) = (in_plane(x), in_plane(e));
            if key(s) != key(t) {
                segments.push((s, t));
            }
        }
    }

    // Chain them: each segment's end is the next one's start.
    let mut from: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, s) in segments.iter().enumerate() {
        from.entry(key(s.0)).or_default().push(i);
    }
    let mut used = vec![false; segments.len()];
    let mut out = Cut::default();
    // An open chain is walked from its first segment, the one no other
    // segment leads into, so it comes out whole rather than in pieces. The
    // closed loops are what is left.
    let ends: std::collections::HashSet<(i64, i64)> = segments.iter().map(|s| key(s.1)).collect();
    let (heads, rest): (Vec<usize>, Vec<usize>) =
        (0..segments.len()).partition(|&i| !ends.contains(&key(segments[i].0)));
    for start in heads.into_iter().chain(rest) {
        if used[start] {
            continue;
        }
        used[start] = true;
        let first = key(segments[start].0);
        let mut chain = vec![segments[start].0, segments[start].1];
        let mut at = key(segments[start].1);
        let closed = loop {
            if at == first {
                break true;
            }
            let next = from.get(&at).and_then(|c| c.iter().copied().find(|&i| !used[i]));
            let Some(i) = next else { break false };
            used[i] = true;
            chain.push(segments[i].1);
            at = key(segments[i].1);
        };
        if closed {
            chain.pop();
            let chain = simplify(chain);
            if chain.len() >= 3 {
                out.loops.push(chain);
            }
        } else {
            out.open.push(chain);
        }
    }
    // The winding the rule above gives depends on which way the triangles
    // face; a solid's loops sum to a positive area once it is the right way.
    let total: f64 = out.loops.iter().map(|l| signed_area(l)).sum();
    if total < 0.0 {
        for l in &mut out.loops {
            l.reverse();
        }
    }
    out
}

/// Drop points that lie on the line through their neighbours: a flat side is
/// two points, not one per triangle that touches it.
fn simplify(pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    if pts.len() < 4 {
        return pts;
    }
    let mut out: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
    let n = pts.len();
    for i in 0..n {
        let (a, b, c) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
        let ab = [b[0] - a[0], b[1] - a[1]];
        let bc = [c[0] - b[0], c[1] - b[1]];
        let twice = (ab[0] * bc[1] - ab[1] * bc[0]).abs();
        let len = (ab[0].hypot(ab[1])) * (bc[0].hypot(bc[1]));
        if len > 0.0 && twice <= 1e-9 * len && ab[0] * bc[0] + ab[1] * bc[1] > 0.0 {
            continue;
        }
        out.push(b);
    }
    out
}

pub fn signed_area(l: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..l.len() {
        let (p, q) = (l[i], l[(i + 1) % l.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

/// Area, centroid and second moments of a set of loops, holes subtracted by
/// their winding.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Props {
    pub area: f64,
    pub centroid: [f64; 2],
    /// About axes through the centroid parallel to u and v: Iu = ∫v² dA,
    /// Iv = ∫u² dA, Iuv = ∫uv dA.
    pub iu: f64,
    pub iv: f64,
    pub iuv: f64,
    /// Furthest material from the centroid along v and along u, for S = I / c.
    pub cv: f64,
    pub cu: f64,
}

pub fn properties(loops: &[Vec<[f64; 2]>]) -> Props {
    let (mut a, mut sx, mut sy, mut ixx, mut iyy, mut ixy) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for l in loops {
        for i in 0..l.len() {
            let (p, q) = (l[i], l[(i + 1) % l.len()]);
            let c = p[0] * q[1] - q[0] * p[1];
            a += c;
            sx += (p[0] + q[0]) * c;
            sy += (p[1] + q[1]) * c;
            ixx += (p[1] * p[1] + p[1] * q[1] + q[1] * q[1]) * c;
            iyy += (p[0] * p[0] + p[0] * q[0] + q[0] * q[0]) * c;
            ixy += (p[0] * q[1] + 2.0 * p[0] * p[1] + 2.0 * q[0] * q[1] + q[0] * p[1]) * c;
        }
    }
    let area = a / 2.0;
    if area.abs() < 1e-12 {
        return Props { area: 0.0, centroid: [0.0, 0.0], iu: 0.0, iv: 0.0, iuv: 0.0, cv: 0.0, cu: 0.0 };
    }
    let cx = sx / (6.0 * area);
    let cy = sy / (6.0 * area);
    let (ixx, iyy, ixy) = (ixx / 12.0, iyy / 12.0, ixy / 24.0);
    let mut cu: f64 = 0.0;
    let mut cv: f64 = 0.0;
    for l in loops {
        for p in l {
            cu = cu.max((p[0] - cx).abs());
            cv = cv.max((p[1] - cy).abs());
        }
    }
    Props {
        area,
        centroid: [cx, cy],
        iu: ixx - area * cy * cy,
        iv: iyy - area * cx * cx,
        iuv: ixy - area * cx * cy,
        cv,
        cu,
    }
}

fn num(x: f64) -> String {
    // Four significant figures past the point is what a hand calculation
    // uses, and it keeps a 1e-13 of rounding from reading as a real number.
    let r = if x.abs() < 1e-9 { 0.0 } else { x };
    g_format(format!("{r:.6}").parse::<f64>().unwrap_or(r))
}

fn num4(x: f64) -> String {
    if x.abs() < 1e-9 {
        return "0".into();
    }
    // Four significant figures however small: a thin wire's I is 1e-6 mm4.
    let digits = (4 - x.abs().log10().floor() as i32 - 1).max(0);
    g_format(round(x, digits))
}

/// One body's cut, as text.
pub fn report(id: &str, name: &str, plane: &Plane, cut: &Cut, outline: bool) -> String {
    let who = if name.is_empty() || name == id { id.to_string() } else { format!("{id} \"{name}\"") };
    if cut.loops.is_empty() && cut.open.is_empty() {
        return format!("{who}: the plane misses it.");
    }
    let (u, v) = (&plane.axes.0, &plane.axes.1);
    let p = properties(&cut.loops);
    let world = [
        plane.origin[0] + plane.u[0] * p.centroid[0] + plane.v[0] * p.centroid[1],
        plane.origin[1] + plane.u[1] * p.centroid[0] + plane.v[1] * p.centroid[1],
        plane.origin[2] + plane.u[2] * p.centroid[0] + plane.v[2] * p.centroid[1],
    ];
    let holes = cut.loops.iter().filter(|l| signed_area(l) < 0.0).count();
    let mut out = vec![format!(
        "{who}: area {} mm2 in {} piece{}{}",
        num4(p.area),
        cut.loops.len() - holes,
        if cut.loops.len() - holes == 1 { "" } else { "s" },
        match holes {
            0 => String::new(),
            1 => " with 1 hole".into(),
            n => format!(" with {n} holes"),
        }
    )];
    out.push(format!(
        "  centroid ({}, {}) in the plane, ({}, {}, {}) in the model",
        num(p.centroid[0]),
        num(p.centroid[1]),
        num(world[0]),
        num(world[1]),
        num(world[2])
    ));
    // Principal axes: where the product of inertia vanishes.
    let mid = (p.iu + p.iv) / 2.0;
    let half = (((p.iu - p.iv) / 2.0).powi(2) + p.iuv * p.iuv).sqrt();
    let angle = 0.5 * (-2.0 * p.iuv).atan2(p.iu - p.iv);
    out.push(format!(
        "  about the centroid: I{u} = {} mm4 (bending about {u}), I{v} = {} mm4, I{u}{v} = {} mm4",
        num4(p.iu),
        num4(p.iv),
        num4(p.iuv),
        u = short(u),
        v = short(v)
    ));
    if p.iuv.abs() > 1e-6 * mid.abs().max(1e-12) {
        out.push(format!(
            "  principal: I1 = {} mm4, I2 = {} mm4, I1's axis at {} deg from {}",
            num4(mid + half),
            num4(mid - half),
            num(round(angle.to_degrees(), 3)),
            short(u)
        ));
    }
    out.push(format!(
        "  furthest fibre {} mm along {} and {} mm along {}, so S{} = {} mm3 and S{} = {} mm3; polar J = {} mm4",
        num(p.cv),
        short(v),
        num(p.cu),
        short(u),
        short(u),
        num4(if p.cv > 0.0 { p.iu / p.cv } else { 0.0 }),
        short(v),
        num4(if p.cu > 0.0 { p.iv / p.cu } else { 0.0 }),
        num4(p.iu + p.iv)
    ));
    if !cut.open.is_empty() {
        out.push(format!(
            "  {} chain{} did not close, the body is not a closed solid here; the numbers count only the closed loops",
            cut.open.len(),
            if cut.open.len() == 1 { "" } else { "s" }
        ));
    }
    if outline {
        for (i, l) in cut.loops.iter().enumerate() {
            let kind = if signed_area(l) < 0.0 { "hole" } else { "outline" };
            let pts: Vec<String> = l.iter().map(|q| format!("[{},{}]", g_format(round(q[0], 4)), g_format(round(q[1], 4)))).collect();
            out.push(format!("  loop {} ({kind}, {} points): [{}]", i + 1, l.len(), pts.join(",")));
        }
    }
    out.join("\n")
}

fn short(axis: &str) -> String {
    match axis {
        "X" | "Y" | "Z" => axis.to_lowercase(),
        other if other.starts_with("u ") => "u".into(),
        other if other.starts_with("v ") => "v".into(),
        other => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rectangle_with_a_hole() {
        // 20 x 10 centred on (5, 0), with a 4 x 2 hole in the middle.
        let outer = vec![[-5.0, -5.0], [15.0, -5.0], [15.0, 5.0], [-5.0, 5.0]];
        let hole = vec![[3.0, -1.0], [3.0, 1.0], [7.0, 1.0], [7.0, -1.0]];
        let p = properties(&[outer, hole]);
        assert!((p.area - 192.0).abs() < 1e-9);
        assert!((p.centroid[0] - 5.0).abs() < 1e-9 && p.centroid[1].abs() < 1e-9);
        // bh^3/12 less the hole's.
        assert!((p.iu - (20.0 * 1000.0 / 12.0 - 4.0 * 8.0 / 12.0)).abs() < 1e-9, "{}", p.iu);
        assert!((p.iv - (10.0 * 8000.0 / 12.0 - 2.0 * 64.0 / 12.0)).abs() < 1e-9, "{}", p.iv);
        assert!(p.iuv.abs() < 1e-9);
        assert_eq!((p.cu, p.cv), (10.0, 5.0));
    }

    #[test]
    fn a_shape_along_the_diagonal_has_a_product_of_inertia() {
        let p = properties(&[vec![[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]]]);
        assert!(p.iuv.abs() < 1e-12);
        let l = properties(&[vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]]);
        // A right triangle with legs 1 lying along u = v: Ixy about its
        // centroid is +1/72.
        assert!((l.iuv - 1.0 / 72.0).abs() < 1e-12, "{}", l.iuv);
    }

    #[test]
    fn a_plane_needs_a_place() {
        let m = |v: Value| v.as_object().cloned().unwrap();
        assert!(plane_of(&m(serde_json::json!({"axis": "Z"}))).is_err());
        assert!(plane_of(&m(serde_json::json!({"axis": "W", "at": 1}))).is_err());
        let p = plane_of(&m(serde_json::json!({"origin": [0, 0, 0], "normal": [0, 0, 2]}))).unwrap();
        assert_eq!(cross(p.u, p.v), [0.0, 0.0, 1.0]);
        // `at` moves the plane, and the label says where it went.
        let p = plane_of(&m(serde_json::json!({"origin": [0, 0, 0], "normal": [0, 0, 1], "at": 10}))).unwrap();
        assert_eq!(p.origin, [0.0, 0.0, 10.0]);
        assert_eq!(p.label, "the plane through (0, 0, 10) normal to (0, 0, 1)");
    }

    #[test]
    fn small_moments_keep_four_figures() {
        assert_eq!(num4(4.9087e-6), "4.909e-06");
        assert_eq!(num4(3.0680e-7), "3.068e-07");
        assert_eq!(num4(1666.6667), "1667");
    }

    #[test]
    fn one_open_chain_is_one_chain_whatever_order_its_triangles_come_in() {
        // A strip standing across z = 0, three squares wide, its middle
        // square's triangles listed first.
        let positions: Vec<f32> = vec![
            0.0, 0.0, -1.0, 1.0, 0.0, -1.0, 2.0, 0.0, -1.0, 3.0, 0.0, -1.0, // bottom row
            0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 2.0, 0.0, 1.0, 3.0, 0.0, 1.0, // top row
        ];
        let indices = vec![1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6];
        let body = MeshBody { info: Default::default(), positions, indices, face_ids: vec![], edges: vec![] };
        let m = |v: Value| v.as_object().cloned().unwrap();
        let plane = plane_of(&m(serde_json::json!({"axis": "Z", "at": 0}))).unwrap();
        let c = cut(&body, &plane);
        assert!(c.loops.is_empty());
        assert_eq!(c.open.len(), 1, "{:?}", c.open);
        assert_eq!(c.open[0].len(), 7, "{:?}", c.open);
    }
}
