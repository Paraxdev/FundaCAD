//! ptb_holes.py: teardrop and roof bridge reshape the top of a sideways hole.

use crate::g::{self, py_g, V};
use crate::read::{end_is_open, holes_from_faces, picked_faces, Hole};
use crate::{feature, Shape, F};

const ALONG_BUILD_DEG: f64 = 1.0;

fn roof_frame(hole: &Hole, bdir: V, label: &str) -> Result<(V, V), String> {
    let a = hole.axis;
    let up = g::sub(bdir, g::mul(a, g::dot(bdir, a)));
    if g::norm(up) < ALONG_BUILD_DEG.to_radians().sin() {
        return Err(format!(
            "{label}: this hole runs along the build direction, so it already prints round. Pick a hole that lies across the build direction."
        ));
    }
    let up = g::unit(up);
    Ok((up, g::cross(a, up)))
}

fn swept_span(shape: &Shape, hole: &Hole) -> (f64, f64) {
    let r = hole.radius;
    let probe = (0.05 * r).max(0.01);
    let over = (0.25 * r).max(0.05);
    let start = hole.t0 - if end_is_open(shape, hole, true, probe) { over } else { 0.0 };
    let end = hole.t1 + if end_is_open(shape, hole, false, probe) { over } else { 0.0 };
    (start, end - start)
}

fn teardrop_section(center: V, up: V, side: V, r: f64, angle_deg: f64, flat: Option<f64>) -> Vec<V> {
    let th = angle_deg.to_radians();
    let (s, c) = (th.sin(), th.cos());
    let tip = r / s;
    let p1 = g::lin(center, &[(r * s, up), (r * c, side)]);
    let p2 = g::lin(center, &[(r * s, up), (-r * c, side)]);
    let apex = g::lin(center, &[(tip, up)]);
    match flat {
        Some(h) if h < tip - 1e-9 => {
            let t = (h - r * s) / (tip - r * s);
            let q1 = g::add(p1, g::mul(g::sub(apex, p1), t));
            let q2 = g::add(p2, g::mul(g::sub(apex, p2), t));
            vec![center, p1, q1, q2, p2]
        }
        _ => vec![center, p1, apex, p2],
    }
}

fn bridge_section(center: V, up: V, side: V, r: f64, extra: f64) -> Vec<V> {
    let top = r + extra;
    vec![
        g::lin(center, &[(-r, side)]),
        g::lin(center, &[(r, side)]),
        g::lin(center, &[(r, side), (top, up)]),
        g::lin(center, &[(-r, side), (top, up)]),
    ]
}

fn apply(f: &F, label: &str, section: &dyn Fn(V, V, V, f64) -> Vec<V>) -> Result<(), String> {
    let bdir = g::build_dir(f, label)?;
    let mut staged = Vec::new();
    for (body, shape, faces) in picked_faces(label)? {
        let mut tools = Vec::new();
        for hole in holes_from_faces(&shape, &faces, label)? {
            let (up, side) = roof_frame(&hole, bdir, label)?;
            let (start, length) = swept_span(&shape, &hole);
            let center = g::lin(hole.origin, &[(start, hole.axis)]);
            let pts = section(center, up, side, hole.radius);
            tools.push(g::prism(&pts, g::mul(hole.axis, length))?);
        }
        staged.push((body, g::cut(&shape, &tools, label)?));
    }
    for (body, out) in staged {
        feature::set_body_shape(body, &out)?;
    }
    Ok(())
}

pub fn teardrop(f: &F) -> Result<(), String> {
    let label = "Teardrop";
    let angle = f.num("angle", 45.0)?;
    if !(10.0..=80.0).contains(&angle) {
        return Err(format!(
            "{label}: the roof angle must be between 10 and 80 degrees (got {})",
            py_g(angle)
        ));
    }
    let roof = f.text("roof", "pointed");
    if roof != "pointed" && roof != "flat" {
        return Err(format!("{label}: unknown roof '{roof}'"));
    }
    let extra = f.num("flatHeight", 0.0)?;
    if roof == "flat" && extra < 0.0 {
        return Err(format!("{label}: the flat roof cannot sit below the top of the hole"));
    }
    let flat = roof == "flat";
    apply(f, label, &|center, up, side, r| {
        teardrop_section(center, up, side, r, angle, flat.then_some(r + extra))
    })
}

pub fn roof_bridge(f: &F) -> Result<(), String> {
    let label = "Roof bridge";
    let extra = f.num("height", 0.0)?;
    if extra < 0.0 {
        return Err(format!("{label}: the extra height cannot be negative"));
    }
    apply(f, label, &|center, up, side, r| bridge_section(center, up, side, r, extra))
}
