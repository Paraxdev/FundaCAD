//! ptb_layers.py: counterbore bridges and sacrificial layers.

use std::f64::consts::PI;

use crate::g::{self, py_g, V};
use crate::read::{
    circular_openings, cylinder_of, edge_points, end_is_open, holes_from_faces, picked_faces, plane_of,
};
use crate::{feature, kernel, Shape, F};

fn layer_height(f: &F, label: &str) -> Result<f64, String> {
    let h = f.num("layerHeight", 0.2)?;
    if !(0.01..=5.0).contains(&h) {
        return Err(format!(
            "{label}: the layer height must be between 0.01 and 5 mm (got {})",
            py_g(h)
        ));
    }
    Ok(h)
}

fn layer_count(f: &F, label: &str, default: f64, most: i64) -> Result<i64, String> {
    let raw = f.num("layers", default)?;
    let n = raw.round_ties_even() as i64;
    if (raw - n as f64).abs() > 1e-9 || !(1..=most).contains(&n) {
        return Err(format!(
            "{label}: the number of layers must be a whole number from 1 to {most} (got {})",
            py_g(raw)
        ));
    }
    Ok(n)
}

/// The open region of each bridging layer, nearest the floor first.
fn bridge_openings(center: V, x: V, y: V, r: f64, reach: f64, count: i64) -> Vec<Vec<V>> {
    let corners = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
    let mut shapes = vec![
        corners.iter().map(|(sx, sy)| g::lin(center, &[(sx * reach, x), (sy * r, y)])).collect(),
        corners.iter().map(|(sx, sy)| g::lin(center, &[(sx * r, x), (sy * r, y)])).collect(),
    ];
    let rr = r / (PI / 8.0).cos();
    shapes.push(
        (0..8)
            .map(|k| {
                let a = PI / 8.0 + k as f64 * PI / 4.0;
                g::lin(center, &[(rr * a.cos(), x), (rr * a.sin(), y)])
            })
            .collect(),
    );
    shapes.truncate(count as usize);
    shapes
}

fn walled(shape: &Shape, center: V, n: V, outer: &[V], probe: f64) -> bool {
    let mut hits = 0;
    for &p in outer {
        let radial = g::sub(p, center);
        let radial = g::sub(radial, g::mul(n, g::dot(radial, n)));
        if g::norm(radial) < 1e-9 {
            continue;
        }
        if g::inside(shape, g::lin(p, &[(probe, g::unit(radial)), (probe, n)])) {
            hits += 1;
        }
    }
    hits * 2 >= outer.len().max(1)
}

pub fn counterbore_bridge(f: &F) -> Result<(), String> {
    let label = "Counterbore bridge";
    let lh = layer_height(f, label)?;
    let count = layer_count(f, label, 2.0, 3)?;
    let turn = f.num("angle", 0.0)?.to_radians();
    let mut staged = Vec::new();
    for (body, shape, faces) in picked_faces(label)? {
        let mut tools = Vec::new();
        for fc in &faces {
            let Some((n, _)) = plane_of(fc) else {
                return Err(format!("{label}: pick the flat floor of a counterbore, this face is curved"));
            };
            let openings = circular_openings(fc);
            if openings.len() != 1 {
                return Err(format!(
                    "{label}: the picked floor needs exactly one round bore through it (found {})",
                    openings.len()
                ));
            }
            let (center, r) = openings[0];
            let outer_wire = fc.outer_wire().ok_or_else(|| format!("{label}: the picked face has no outer boundary"))?;
            let outer_pts = edge_points(&outer_wire);
            let probe = (0.1 * lh).max(0.01);
            if !walled(&shape, center, n, &outer_pts, probe) {
                return Err(format!("{label}: the picked face is not a counterbore floor, nothing walls it in"));
            }
            let total = count as f64 * lh;
            for k in 0..count {
                if g::inside(&shape, g::lin(center, &[(-(k as f64 + 0.5) * lh, n)])) {
                    return Err(format!(
                        "{label}: the bore below this floor is shorter than {count} layers of {} mm",
                        py_g(lh)
                    ));
                }
            }
            let reach = outer_pts
                .iter()
                .map(|p| g::norm(g::sub(*p, center)))
                .fold(f64::NEG_INFINITY, f64::max)
                + 1.0;
            let (hx, hy) = g::perp_frame_rotated(n, turn);
            let footprint = kernel::face_from_wire(&outer_wire)?;
            let slab = kernel::prism(&footprint, g::mul(n, -total))?;
            for (k, pts) in bridge_openings(center, hx, hy, r, reach, count).into_iter().enumerate() {
                let pts: Vec<V> = pts.into_iter().map(|p| g::lin(p, &[(-(k as f64) * lh, n)])).collect();
                let layer = g::prism(&pts, g::mul(n, -lh))?;
                let tool = g::common(&slab, &layer)
                    .ok_or_else(|| format!("{label}: could not shape layer {}", k + 1))?;
                tools.push(tool);
            }
        }
        staged.push((body, g::cut(&shape, &tools, label)?));
    }
    for (body, out) in staged {
        feature::set_body_shape(body, &out)?;
    }
    Ok(())
}

/// (point on the opening plane, inward unit vector, radius, depth available).
fn openings_for(
    shape: &Shape,
    fc: &Shape,
    bdir: V,
    side: &str,
    probe: f64,
    label: &str,
) -> Result<Vec<(V, V, f64, Option<f64>)>, String> {
    if cylinder_of(fc).is_some() {
        let mut out = Vec::new();
        for hole in holes_from_faces(shape, std::slice::from_ref(fc), label)? {
            let (a, length) = (hole.axis, hole.t1 - hole.t0);
            let mut ends: Vec<(V, V)> = Vec::new();
            if end_is_open(shape, &hole, true, probe) {
                ends.push((g::lin(hole.origin, &[(hole.t0, a)]), a));
            }
            if end_is_open(shape, &hole, false, probe) {
                ends.push((g::lin(hole.origin, &[(hole.t1, a)]), g::mul(a, -1.0)));
            }
            if ends.is_empty() {
                return Err(format!("{label}: this hole does not open onto any face"));
            }
            let key = |e: &(V, V)| {
                let v = g::dot(e.0, bdir);
                (v * 1e9).round_ties_even() / 1e9
            };
            let mut pick = ends[0];
            for e in &ends[1..] {
                let better = if side == "bottom" { key(e) < key(&pick) } else { key(e) > key(&pick) };
                if better {
                    pick = *e;
                }
            }
            out.push((pick.0, pick.1, hole.radius, Some(length)));
        }
        return Ok(out);
    }
    let Some((n, _)) = plane_of(fc) else {
        return Err(format!(
            "{label}: pick the inside face of a round hole, or the flat face it opens onto"
        ));
    };
    let out: Vec<_> = circular_openings(fc)
        .into_iter()
        .filter(|(center, _)| !g::inside(shape, g::lin(*center, &[(-probe, n)])))
        .map(|(center, r)| (center, g::mul(n, -1.0), r, None))
        .collect();
    if out.is_empty() {
        return Err(format!("{label}: no round hole opens onto the picked face"));
    }
    Ok(out)
}

pub fn sacrificial_layer(f: &F) -> Result<(), String> {
    let label = "Sacrificial layer";
    let lh = layer_height(f, label)?;
    let count = layer_count(f, label, 1.0, 5)?;
    let depth = f.num("depth", 0.0)?;
    if depth < 0.0 {
        return Err(format!("{label}: the depth cannot be negative"));
    }
    let side = f.text("side", "bottom");
    if side != "bottom" && side != "top" {
        return Err(format!("{label}: unknown side '{side}'"));
    }
    let bdir = g::build_dir(f, label)?;
    let thick = count as f64 * lh;
    let mut staged = Vec::new();
    for (body, shape, faces) in picked_faces(label)? {
        let mut membranes = Vec::new();
        for fc in &faces {
            let probe = (0.1 * lh).max(0.01);
            for (p, inward, r, available) in openings_for(&shape, fc, bdir, side, probe, label)? {
                if let Some(avail) = available {
                    if depth + thick > avail + 1e-9 {
                        return Err(format!(
                            "{label}: {} mm deep plus {} mm of layers runs past the end of the {} mm hole",
                            py_g(depth),
                            py_g(thick),
                            py_g(avail)
                        ));
                    }
                }
                let start = g::lin(p, &[(depth, inward)]);
                if g::inside(&shape, g::lin(start, &[(thick / 2.0, inward)])) {
                    return Err(format!("{label}: at {} mm deep the hole is already closed", py_g(depth)));
                }
                let grip = (0.1 * r).min(0.05);
                membranes.push(kernel::make_cylinder(start, inward, r + grip, thick)?);
            }
        }
        let fused = g::fuse(&shape, &membranes, label)?;
        staged.push((body, kernel::unify(&fused)));
    }
    for (body, out) in staged {
        feature::set_body_shape(body, &out)?;
    }
    Ok(())
}
