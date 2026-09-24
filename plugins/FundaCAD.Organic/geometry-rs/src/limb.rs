//! One chain as a limb: a single smooth loft through an elliptical section at
//! every node, each normal to the spine through the node centres, and through
//! shrinking sections of the end nodes' own ellipsoids out to a point, so the
//! limb ends round with no seam between the tube and its caps.

use crate::fundacad::plugin::kernel::LoftOptions;
use crate::kernel;
use crate::math::{self, V};
use crate::nodes::Node;
use crate::Shape;

/// How far round each end cap its sections sit, degrees of latitude on the
/// end node's ellipsoid, from the node's own section toward the tip.
const CAP_LATITUDES: [f64; 4] = [30.0, 55.0, 72.0, 84.0];

/// The spine direction at every node: the mean of the unit chords either
/// side inside, the end chord mirrored about its neighbour's direction at
/// the ends, so the spine leaves an end as a circle through three nodes would.
pub fn tangents(p: &[V]) -> Vec<V> {
    let n = p.len();
    let chords: Vec<V> = p.windows(2).map(|w| math::unit(math::sub(w[1], w[0]))).collect();
    if n == 2 {
        return vec![chords[0], chords[0]];
    }
    let mut t = vec![[0.0; 3]; n];
    for i in 1..n - 1 {
        let s = math::add(chords[i - 1], chords[i]);
        t[i] = if math::norm(s) < 1e-9 { chords[i] } else { math::unit(s) };
    }
    let mirror = |chord: V, inner: V| {
        let m = math::sub(math::mul(chord, 2.0 * math::dot(chord, inner)), inner);
        if math::dot(m, chord) > 1e-6 { math::unit(m) } else { chord }
    };
    t[0] = mirror(chords[0], t[1]);
    t[n - 1] = mirror(chords[n - 2], t[n - 2]);
    t
}

/// A reference direction normal to the spine at every node, carried along
/// without twisting (double reflection), so the sections' start points line
/// up and the loft does not wring.
pub fn seams(p: &[V], t: &[V]) -> Vec<V> {
    let up = if t[0][2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
    let mut r = vec![math::perp_pair(t[0], up).0];
    for i in 0..p.len() - 1 {
        let v1 = math::sub(p[i + 1], p[i]);
        let c1 = math::dot(v1, v1);
        let r_l = math::sub(r[i], math::mul(v1, 2.0 / c1 * math::dot(v1, r[i])));
        let t_l = math::sub(t[i], math::mul(v1, 2.0 / c1 * math::dot(v1, t[i])));
        let v2 = math::sub(t[i + 1], t_l);
        let c2 = math::dot(v2, v2);
        let next = if c2 < 1e-18 { r_l } else { math::sub(r_l, math::mul(v2, 2.0 / c2 * math::dot(v2, r_l))) };
        let next = math::sub(next, math::mul(t[i + 1], math::dot(next, t[i + 1])));
        r.push(math::unit(next));
    }
    r
}

/// The ellipse with semi-axis vectors `a` and `b` about `center`, in the plane
/// normal to `t`, starting in the direction `seam`.
fn ellipse(center: V, t: V, a: V, b: V, seam: V) -> Result<Shape, String> {
    let (ra, rb) = (math::norm(a), math::norm(b));
    let x = math::mul(a, 1.0 / ra);
    let y = math::cross(t, x);
    let phi = math::dot(seam, y).atan2(math::dot(seam, x));
    let start = (ra * phi.sin()).atan2(rb * phi.cos());
    kernel::ellipse_edge(math::tuple(center), math::tuple(t), math::tuple(x), ra, rb, start)
}

/// How a limb is lofted. Sections go between nodes about `step` times the
/// mean section radius apart, at most `max_between` per span, so the surface
/// follows the spine instead of swinging wide across a long gap.
struct Plan {
    step: f64,
    max_between: usize,
    smooth: bool,
    degree: u32,
}

/// A few sections at degree 5 is preferred over the rest. Through many
/// sections the kernel's own degree 8 surface meshes with a gap along a long
/// span, and its smoothed loft, which meshes whole, loses pieces in later
/// booleans. The smoothed loft stays as the fallback for a limb the first
/// is refused on.
const PLANS: [Plan; 2] = [
    Plan { step: 1.2, max_between: 3, smooth: false, degree: 5 },
    Plan { step: 0.5, max_between: 12, smooth: true, degree: 0 },
];

struct Station {
    center: V,
    t: V,
    /// The node this station sits on, if it sits on one.
    node: Option<usize>,
}

/// Where along the spine each section goes: every node, and points on the
/// cubic through each pair of neighbours with the spine direction at both.
fn stations(nodes: &[Node], chain: &[usize], t: &[V], plan: &Plan) -> Vec<Station> {
    let mut out = Vec::new();
    for k in 0..chain.len() {
        let (p0, t0) = (nodes[chain[k]].center, t[k]);
        out.push(Station { center: p0, t: t0, node: Some(k) });
        if k + 1 == chain.len() {
            break;
        }
        let (p1, t1) = (nodes[chain[k + 1]].center, t[k + 1]);
        let len = math::norm(math::sub(p1, p0));
        let mean_r = |n: &Node, tt: V| {
            let (a, b) = n.section(tt);
            0.5 * (math::norm(a) + math::norm(b))
        };
        let r = 0.5 * (mean_r(&nodes[chain[k]], t0) + mean_r(&nodes[chain[k + 1]], t1));
        let between = ((len / (plan.step * r)).round() as usize).saturating_sub(1).min(plan.max_between);
        for j in 1..=between {
            let s = j as f64 / (between + 1) as f64;
            let (s2, s3) = (s * s, s * s * s);
            let at = [2.0 * s3 - 3.0 * s2 + 1.0, s3 - 2.0 * s2 + s, -2.0 * s3 + 3.0 * s2, s3 - s2];
            let d = [6.0 * s2 - 6.0 * s, 3.0 * s2 - 4.0 * s + 1.0, -6.0 * s2 + 6.0 * s, 3.0 * s2 - 2.0 * s];
            let mix = |w: [f64; 4]| {
                math::add(
                    math::add(math::mul(p0, w[0]), math::mul(t0, len * w[1])),
                    math::add(math::mul(p1, w[2]), math::mul(t1, len * w[3])),
                )
            };
            out.push(Station { center: mix(at), t: math::unit(mix(d)), node: None });
        }
    }
    out
}

/// A node's section as (turn from the seam, radius along it, radius across).
fn polar(a: V, b: V, t: V, seam: V) -> (f64, f64, f64) {
    let across = math::cross(t, seam);
    (math::dot(a, across).atan2(math::dot(a, seam)), math::norm(a), math::norm(b))
}

/// The same ellipse written with the turn nearest `near`: a half turn is the
/// same ellipse, a quarter turn is the same with its radii swapped.
fn nearest(e: (f64, f64, f64), near: f64) -> (f64, f64, f64) {
    use std::f64::consts::FRAC_PI_2;
    let mut best = e;
    let mut gap = f64::INFINITY;
    for q in -8i32..=8 {
        let turn = e.0 + q as f64 * FRAC_PI_2;
        let (ra, rb) = if q.rem_euclid(2) == 0 { (e.1, e.2) } else { (e.2, e.1) };
        if (turn - near).abs() < gap {
            gap = (turn - near).abs();
            best = (turn, ra, rb);
        }
    }
    best
}

/// A limb through `chain`, indices into `nodes`.
pub fn limb(nodes: &[Node], chain: &[usize]) -> Result<Shape, String> {
    let mut last = Err(String::new());
    for plan in &PLANS {
        last = limb_with(nodes, chain, plan);
        if last.is_ok() {
            break;
        }
    }
    last
}

fn limb_with(nodes: &[Node], chain: &[usize], plan: &Plan) -> Result<Shape, String> {
    let p: Vec<V> = chain.iter().map(|&i| nodes[i].center).collect();
    let t = tangents(&p);
    let st = stations(nodes, chain, &t, plan);
    let sp: Vec<V> = st.iter().map(|s| s.center).collect();
    let stt: Vec<V> = st.iter().map(|s| s.t).collect();
    let r = seams(&sp, &stt);

    let at_node: Vec<usize> = (0..st.len()).filter(|&i| st[i].node.is_some()).collect();
    let mut shape: Vec<(f64, f64, f64)> = Vec::with_capacity(at_node.len());
    for (k, &i) in at_node.iter().enumerate() {
        let (a, b) = nodes[chain[k]].section(st[i].t);
        let e = polar(a, b, st[i].t, r[i]);
        shape.push(match shape.last() {
            Some(prev) => nearest(e, prev.0),
            None => e,
        });
    }
    let axes = |i: usize, e: (f64, f64, f64)| {
        let across = math::cross(st[i].t, r[i]);
        let (s, c) = e.0.sin_cos();
        let x = math::add(math::mul(r[i], c), math::mul(across, s));
        (math::mul(x, e.1), math::mul(math::cross(st[i].t, x), e.2))
    };

    let mut sections: Vec<Shape> = Vec::new();
    let mut seg = 0;
    for i in 0..st.len() {
        let e = if let Some(k) = st[i].node {
            seg = k;
            shape[k]
        } else {
            let (i0, i1) = (at_node[seg], at_node[seg + 1]);
            let f = (i - i0) as f64 / (i1 - i0) as f64;
            let (e0, e1) = (shape[seg], shape[seg + 1]);
            (e0.0 + (e1.0 - e0.0) * f, e0.1 + (e1.1 - e0.1) * f, e0.2 + (e1.2 - e0.2) * f)
        };
        let (a, b) = axes(i, e);
        sections.push(ellipse(st[i].center, st[i].t, a, b, r[i])?);
    }

    let cap = |i: usize, k: usize, outward: V, rev: bool| -> Result<(Vec<Shape>, V), String> {
        let node = &nodes[chain[k]];
        let (a, b) = axes(i, shape[k]);
        let reach = node.conjugate(outward);
        let mut ring = Vec::new();
        for lat in CAP_LATITUDES {
            let (s, c) = lat.to_radians().sin_cos();
            let centre = math::add(node.center, math::mul(reach, s));
            ring.push(ellipse(centre, st[i].t, math::mul(a, c), math::mul(b, c), r[i])?);
        }
        if rev {
            ring.reverse();
        }
        Ok((ring, math::add(node.center, reach)))
    };
    let last = st.len() - 1;
    let (head, start_tip) = cap(0, 0, math::mul(st[0].t, -1.0), true)?;
    let (tail, end_tip) = cap(last, chain.len() - 1, st[last].t, false)?;
    let all: Vec<&Shape> = head.iter().chain(sections.iter()).chain(tail.iter()).collect();
    let options = LoftOptions { ruled: false, smooth: plan.smooth, match_seams: false, max_degree: plan.degree };
    kernel::loft(&all, Some(math::tuple(start_tip)), Some(math::tuple(end_tip)), options)
}
