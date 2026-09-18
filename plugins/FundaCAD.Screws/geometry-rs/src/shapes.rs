//! scr_shapes.py: solids for fastener parts, in millimetres, on the Z axis,
//! through the engine's kernel with build123d's own boolean semantics
//! (parallel, merged faces, a lone solid unwrapped).
//!
//! Screws hang from the XY plane: the head's bearing face is at z = 0 with the
//! head above it, the shank runs down to z = -length. A countersunk head is
//! the exception, its top is at z = 0 so the screw sits flush. Nuts and
//! washers stand on z = 0. An insert's top is at z = 0 and it goes down into
//! the part.

use std::f64::consts::PI;

use crate::fundacad::plugin::types::{BooleanOp, BooleanOptions, Fuzzy};
use crate::kernel;
use crate::Shape;

pub type R<T> = Result<T, String>;

const Z: (f64, f64, f64) = (0.0, 0.0, 1.0);
const O: (f64, f64, f64) = (0.0, 0.0, 0.0);

fn tan30() -> f64 {
    (30f64).to_radians().tan()
}

/// build123d's `+`, `-` and `&`.
pub fn op(kind: BooleanOp, a: &Shape, b: &Shape) -> R<Shape> {
    kernel::boolean_with(
        kind,
        a,
        &[b],
        BooleanOptions {
            parallel: true,
            fuzzy: Fuzzy::Exact,
            clean: true,
        },
    )
}

/// A solid of revolution about Z from a closed (r, z) outline.
pub fn revolve_rz(points: &[(f64, f64)]) -> R<Shape> {
    let pts: Vec<_> = points.iter().map(|&(r, z)| (r, 0.0, z)).collect();
    let face = kernel::polygon_face(&pts)?;
    kernel::revolve(&face, O, Z, 360.0)
}

pub fn revolve_edges(edges: &[Shape]) -> R<Shape> {
    let refs: Vec<&Shape> = edges.iter().collect();
    let wire = kernel::wire_from_edges(&refs)?;
    let face = kernel::face_from_wire(&wire)?;
    kernel::revolve(&face, O, Z, 360.0)
}

pub fn prism(points_xy: &[(f64, f64)], z0: f64, height: f64) -> R<Shape> {
    let pts: Vec<_> = points_xy.iter().map(|&(x, y)| (x, y, z0)).collect();
    let face = kernel::polygon_face(&pts)?;
    kernel::prism(&face, (0.0, 0.0, height))
}

pub fn hexagon(across_flats: f64) -> Vec<(f64, f64)> {
    let r = across_flats / 3f64.sqrt();
    (0..6)
        .map(|i| {
            let a = (60.0 * i as f64).to_radians();
            (r * a.cos(), r * a.sin())
        })
        .collect()
}

pub fn square(side: f64) -> Vec<(f64, f64)> {
    let h = side / 2.0;
    vec![(-h, -h), (h, -h), (h, h), (-h, h)]
}

/// Straight knurl ribs. An even count puts a rib on both ends of each axis,
/// so the knurl measures its full diameter.
pub fn star(outer: f64, inner: f64, teeth: i64) -> Vec<(f64, f64)> {
    let teeth = teeth + teeth % 2;
    (0..teeth * 2)
        .map(|i| {
            let a = PI * i as f64 / teeth as f64;
            let r = if i % 2 == 0 { outer } else { inner };
            (r * a.cos(), r * a.sin())
        })
        .collect()
}

pub fn cylinder(r: f64, z0: f64, z1: f64) -> R<Shape> {
    revolve_rz(&[(0.0, z0), (r, z0), (r, z1), (0.0, z1)])
}

pub fn make_box(x0: f64, x1: f64, y0: f64, y1: f64, z0: f64, z1: f64) -> R<Shape> {
    prism(&[(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1 - z0)
}

pub fn fuse(shapes: &[Shape]) -> R<Shape> {
    let mut out: Option<Shape> = None;
    for s in &shapes[1..] {
        out = Some(op(BooleanOp::Fuse, out.as_ref().unwrap_or(&shapes[0]), s)?);
    }
    Ok(kernel::unify(out.as_ref().unwrap_or(&shapes[0])))
}

pub fn cut(a: &Shape, tools: &[Shape]) -> R<Shape> {
    let mut out: Option<Shape> = None;
    for t in tools {
        out = Some(op(BooleanOp::Cut, out.as_ref().unwrap_or(a), t)?);
    }
    Ok(kernel::unify(out.as_ref().unwrap_or(a)))
}

pub fn intersect(a: &Shape, b: &Shape) -> R<Shape> {
    op(BooleanOp::Common, a, b)
}

/// A hex prism with the 30 degree bearing-face chamfers a pressed hex has.
pub fn chamfered_hex(across_flats: f64, z0: f64, z1: f64, top: bool, bottom: bool) -> R<Shape> {
    let body = prism(&hexagon(across_flats), z0, z1 - z0)?;
    let big = across_flats / 3f64.sqrt() * 1.05;
    let rw = across_flats / 2.0 * 0.95;
    let drop = (big - rw) * tan30();
    let mut pts = vec![(0.0, z0)];
    if bottom {
        pts.extend([(rw, z0), (big, z0 + drop)]);
    } else {
        pts.push((big, z0));
    }
    if top {
        pts.extend([(big, z1 - drop), (rw, z1)]);
    } else {
        pts.push((big, z1));
    }
    pts.push((0.0, z1));
    intersect(&body, &revolve_rz(&pts)?)
}

// --- the axisymmetric outline of a screw -------------------------------------

/// `head_outline`: (r, z) from the top of the axis outward and down to the
/// shank at z = 0, or none when the head is not a solid of revolution; and the
/// z of the head's top face, where a drive recess starts.
pub fn head_outline(head: &crate::P, shank_r: f64) -> (Option<Vec<(f64, f64)>>, f64) {
    let t = head.s("type");
    match t {
        "socketCap" | "lowHead" | "cheese" => {
            let (r, k) = (head.f("diameter") / 2.0, head.f("height"));
            let c = (k * if t == "cheese" { 0.15 } else { 0.1 }).min(r * 0.08);
            (Some(vec![(0.0, k), (r - c, k), (r, k - c), (r, 0.0), (shank_r, 0.0)]), k)
        }
        "countersunk" => {
            let (r, k) = (head.f("diameter") / 2.0, head.f("height"));
            (Some(vec![(0.0, 0.0), (r, 0.0), (shank_r, -k)]), 0.0)
        }
        "none" => (Some(vec![(0.0, 0.0)]), 0.0),
        _ => (None, head.f_or("height", 0.0)),
    }
}

fn xz(r: f64, z: f64) -> (f64, f64, f64) {
    (r, 0.0, z)
}

/// `curved_head`: the domed heads' edges, from the axis top to (shank_r, 0).
pub fn curved_head(head: &crate::P, shank_r: f64) -> R<Option<Vec<Shape>>> {
    let t = head.s("type");
    if t != "button" && t != "pan" {
        return Ok(None);
    }
    let (r, k) = (head.f("diameter") / 2.0, head.f("height"));
    if t == "button" {
        let h0 = k * 0.18;
        let rise = k - h0;
        let rs = (r * r + rise * rise) / (2.0 * rise);
        let theta = (r / rs).min(1.0).asin();
        let mid = (rs * (theta / 2.0).sin(), k - rs + rs * (theta / 2.0).cos());
        return Ok(Some(vec![
            kernel::arc_edge(xz(0.0, k), xz(mid.0, mid.1), xz(r, h0))?,
            kernel::line_edge(xz(r, h0), xz(r, 0.0))?,
            kernel::line_edge(xz(r, 0.0), xz(shank_r, 0.0))?,
        ]));
    }
    let rf = (k * 0.45).min(r * 0.35);
    let (cx, cz) = (r - rf, k - rf);
    let a = 45f64.to_radians();
    Ok(Some(vec![
        kernel::line_edge(xz(0.0, k), xz(cx, k))?,
        kernel::arc_edge(xz(cx, k), xz(cx + rf * a.sin(), cz + rf * a.cos()), xz(r, cz))?,
        kernel::line_edge(xz(r, cz), xz(r, 0.0))?,
        kernel::line_edge(xz(r, 0.0), xz(shank_r, 0.0))?,
    ]))
}

/// `point_outline`: (r, z) from the shank radius at the start of the point
/// down to the axis at z_end.
pub fn point_outline(point: &crate::P, r: f64, z_end: f64, pitch: f64, length: f64) -> Vec<(f64, f64)> {
    let t = point.s("type");
    let c = (pitch * 0.6134).min(r * 0.4).min(length * 0.2);
    match t {
        "flat" => {
            let rp = (point.f("diameter") / 2.0).min(r * 0.98);
            let c = (r - rp).min(length * 0.3);
            vec![(r, z_end + c), (r - c, z_end), (0.0, z_end)]
        }
        "cone" => {
            let tip = r * 0.12;
            let h = ((r - tip) / 59f64.to_radians().tan()).min(length * 0.4);
            vec![(r, z_end + h), (tip, z_end), (0.0, z_end)]
        }
        "cup" => {
            let rc = (point.f("diameter") / 2.0).min(r * 0.9);
            let c = (r - rc).min(length * 0.3);
            vec![(r, z_end + c), (rc, z_end), (0.0, z_end + (rc * 0.55).min(length * 0.25))]
        }
        "tapping" => {
            let h = (2.0 * pitch).min(length * 0.5);
            vec![(r, z_end + h), (r * 0.35, z_end), (0.0, z_end)]
        }
        _ => vec![(r, z_end + c), (r - c, z_end), (0.0, z_end)],
    }
}

// --- drive recesses, as tools to cut, from z_top downward ---------------------

fn cone_tip(r: f64, z_top_of_cone: f64) -> R<Shape> {
    let h = r / (118f64 / 2.0).to_radians().tan();
    revolve_rz(&[(0.0, z_top_of_cone - h), (r, z_top_of_cone), (0.0, z_top_of_cone)])
}

pub fn drive_tool(drive: &crate::P, z_top: f64, head_room: f64) -> R<Option<Shape>> {
    let t = drive.s("type");
    if t == "none" {
        return Ok(None);
    }
    let (s, depth) = (drive.f("size"), drive.f("depth"));
    let above = depth.max(1.0);
    Ok(Some(match t {
        "hex" => {
            let body = prism(&hexagon(s), z_top - depth, depth + above)?;
            fuse(&[body, cone_tip(s / 3f64.sqrt(), z_top - depth)?])?
        }
        "square" => {
            let body = prism(&square(s), z_top - depth, depth + above)?;
            fuse(&[body, cone_tip(s / 2f64.sqrt(), z_top - depth)?])?
        }
        "slot" => {
            let half = head_room / 2.0 + 1.0;
            make_box(-half, half, -s / 2.0, s / 2.0, z_top - depth, z_top + above)?
        }
        "torx" => fuse(&[torx_prism(s, z_top - depth, depth + above)?, cone_tip(s * 0.36, z_top - depth)?])?,
        "phillips" | "pozidriv" => cross_recess(s, depth, z_top, above, t == "pozidriv")?,
        other => return Err(format!("Fastener: unknown drive type {}", crate::py_repr(other))),
    }))
}

fn circle_face(x: f64, y: f64, r: f64) -> R<Shape> {
    let edge = kernel::circle_edge((x, y, 0.0), Z, r)?;
    let wire = kernel::wire_from_edges(&[&edge])?;
    kernel::face_from_wire(&wire)
}

/// A hexalobular recess: six rounded lobes, point to point `a`.
pub fn torx_prism(a: f64, z0: f64, height: f64) -> R<Shape> {
    let ro = a / 2.0;
    let b = a * 0.72 / 2.0;
    let ri = a * 0.175;
    let mut shape = circle_face(0.0, 0.0, ro)?;
    for i in 0..6 {
        let ang = (30.0 + 60.0 * i as f64).to_radians();
        let dist = b + ri;
        let lobe = circle_face(dist * ang.cos(), dist * ang.sin(), ri)?;
        shape = op(BooleanOp::Cut, &shape, &lobe)?;
    }
    let face = shape
        .faces()
        .into_iter()
        .next()
        .ok_or("Fastener: the hexalobular outline came out empty")?;
    let solid = kernel::prism(&face, (0.0, 0.0, height))?;
    kernel::translate(&solid, (0.0, 0.0, z0))
}

pub fn cross_recess(m: f64, depth: f64, z_top: f64, above: f64, pozi: bool) -> R<Shape> {
    let w = m * 0.2;
    let half = m / 2.0;
    let arms = fuse(&[
        make_box(-half, half, -w / 2.0, w / 2.0, z_top - depth, z_top + above)?,
        make_box(-w / 2.0, w / 2.0, -half, half, z_top - depth, z_top + above)?,
    ])?;
    let taper = revolve_rz(&[
        (0.0, z_top - depth),
        (w * 0.55, z_top - depth),
        (half, z_top),
        (half, z_top + above),
        (0.0, z_top + above),
    ])?;
    let mut tool = intersect(&arms, &taper)?;
    let centre = revolve_rz(&[
        (0.0, z_top - depth),
        (m * 0.24, z_top),
        (m * 0.24, z_top + above),
        (0.0, z_top + above),
    ])?;
    tool = fuse(&[tool, centre])?;
    if pozi {
        let tick = make_box(-half * 0.8, half * 0.8, -w * 0.18, w * 0.18, z_top - depth * 0.45, z_top + above)?;
        let ticks = fuse(&[kernel::rotate(&tick, O, Z, 45.0)?, kernel::rotate(&tick, O, Z, -45.0)?])?;
        let shallow = revolve_rz(&[
            (0.0, z_top - depth * 0.45),
            (half * 0.3, z_top - depth * 0.45),
            (half * 0.8, z_top),
            (half * 0.8, z_top + above),
            (0.0, z_top + above),
        ])?;
        tool = fuse(&[tool, intersect(&ticks, &shallow)?])?;
    }
    Ok(tool)
}
