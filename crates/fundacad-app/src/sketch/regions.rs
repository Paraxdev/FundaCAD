//! The closed areas of a sketch, as outlines to fill: closed shapes, and chains of lines and arcs whose ends meet.

use std::collections::HashMap;
use std::f64::consts::TAU;

use fundacad_sketch::geom::{coinc_key, rect_corners};
use fundacad_sketch::Entity;
use glam::DVec2;

fn d2(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

fn circle(c: DVec2, r: f64) -> Vec<DVec2> {
    (0..64).map(|k| c + DVec2::from_angle(k as f64 / 64.0 * TAU) * r).collect()
}

/// An arc from start to end through `m`, sampled.
pub fn arc_points(a: DVec2, b: DVec2, m: DVec2) -> Vec<DVec2> {
    let Some(c) = fundacad_sketch::geom::circumcenter(
        fundacad_sketch::geom::v(a.x, a.y),
        fundacad_sketch::geom::v(b.x, b.y),
        fundacad_sketch::geom::v(m.x, m.y),
    ) else {
        return vec![a, b];
    };
    let c = d2(c.x, c.y);
    let r = (a - c).length();
    let ang = |p: DVec2| (p - c).y.atan2((p - c).x);
    let (a0, a1, am) = (ang(a), ang(b), ang(m));
    let ccw = |from: f64, to: f64| (to - from).rem_euclid(TAU);
    let sweep = if ccw(a0, am) <= ccw(a0, a1) { ccw(a0, a1) } else { ccw(a0, a1) - TAU };
    let n = ((sweep.abs() / TAU * 64.0).ceil() as usize).max(4);
    (0..=n).map(|k| c + DVec2::from_angle(a0 + sweep * k as f64 / n as f64) * r).collect()
}

/// The polyline of an open curve, None for a closed shape.
pub fn path(e: &Entity) -> Option<Vec<DVec2>> {
    match e {
        Entity::Line { x1, y1, x2, y2, .. } => Some(vec![d2(*x1, *y1), d2(*x2, *y2)]),
        Entity::Arc { x1, y1, x2, y2, mx, my, .. } => Some(arc_points(d2(*x1, *y1), d2(*x2, *y2), d2(*mx, *my))),
        _ => None,
    }
}

/// The outline of a closed shape.
pub fn outline(e: &Entity) -> Option<Vec<DVec2>> {
    match e {
        Entity::Circle { x, y, radius, .. } => Some(circle(d2(*x, *y), *radius)),
        Entity::Rectangle { x, y, width, height, angle, .. } => {
            Some(rect_corners(*x, *y, *width, *height, *angle).iter().map(|p| d2(p.x, p.y)).collect())
        }
        _ => None,
    }
}

/// Every closed outline among `entities`, skipping the ids in `construction`.
pub fn regions(entities: &[Entity], construction: &[String]) -> Vec<Vec<DVec2>> {
    let live: Vec<&Entity> = entities.iter().filter(|e| !construction.iter().any(|c| c == e.id())).collect();
    let mut out: Vec<Vec<DVec2>> = live.iter().filter_map(|e| outline(e)).collect();
    let paths: Vec<Vec<DVec2>> = live.iter().filter_map(|e| path(e)).filter(|p| p.len() >= 2).collect();
    let key = |p: DVec2| coinc_key(p.x, p.y);
    let mut at: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, p) in paths.iter().enumerate() {
        at.entry(key(p[0])).or_default().push(i);
        at.entry(key(p[p.len() - 1])).or_default().push(i);
    }
    let mut used = vec![false; paths.len()];
    for start in 0..paths.len() {
        if used[start] {
            continue;
        }
        let mut loop_pts = paths[start].clone();
        let mut chain = vec![start];
        used[start] = true;
        let first = key(loop_pts[0]);
        let closed = loop {
            let end = key(*loop_pts.last().expect("a path has points"));
            if end == first && chain.len() > 1 {
                break true;
            }
            let ends = &at[&end];
            if ends.len() != 2 {
                break false;
            }
            let Some(&next) = ends.iter().find(|&&j| !chain.contains(&j)) else { break end == first };
            used[next] = true;
            chain.push(next);
            let mut p = paths[next].clone();
            if key(p[0]) != end {
                p.reverse();
            }
            loop_pts.extend(p.into_iter().skip(1));
        };
        if closed && loop_pts.len() > 3 {
            loop_pts.pop();
            out.push(loop_pts);
        }
    }
    out
}

/// One point per area to fill, for an extrude's `regions`: an outline nested inside an odd number of others is a
/// hole, so a circle inside a rectangle cuts through it.
pub fn fill_points(outlines: &[Vec<DVec2>]) -> Vec<DVec2> {
    let within = |a: &[DVec2], b: &[DVec2]| !std::ptr::eq(a, b) && a.iter().all(|p| contains(b, *p));
    let mut out = Vec::new();
    for o in outlines {
        let depth = outlines.iter().filter(|b| within(o, b)).count();
        if depth % 2 == 1 {
            continue;
        }
        let kids: Vec<&Vec<DVec2>> = outlines.iter().filter(|k| within(k, o)).collect();
        if let Some(p) = inside(o, &kids) {
            out.push(p);
        }
    }
    out
}

/// The point inside `outline` and outside every `holes` that sits farthest from all their edges.
pub fn inside(outline: &[DVec2], holes: &[&Vec<DVec2>]) -> Option<DVec2> {
    let (lo, hi) = outline.iter().fold((DVec2::MAX, DVec2::MIN), |(lo, hi), p| (lo.min(*p), hi.max(*p)));
    let edge_gap = |ring: &[DVec2], p: DVec2| {
        (0..ring.len())
            .map(|i| {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                let t = ((p - a).dot(b - a) / (b - a).length_squared().max(1e-12)).clamp(0.0, 1.0);
                (a + (b - a) * t - p).length()
            })
            .fold(f64::MAX, f64::min)
    };
    let n = 40;
    let mut best: Option<(f64, DVec2)> = None;
    for i in 0..n {
        for j in 0..n {
            let p = lo + (hi - lo) * DVec2::new((i as f64 + 0.5) / n as f64, (j as f64 + 0.5) / n as f64);
            if !contains(outline, p) || holes.iter().any(|h| contains(h, p)) {
                continue;
            }
            let gap = holes.iter().map(|h| edge_gap(h, p)).fold(edge_gap(outline, p), f64::min);
            if best.is_none_or(|(g, _)| gap > g) {
                best = Some((gap, p));
            }
        }
    }
    best.map(|(_, p)| p)
}

pub fn contains(outline: &[DVec2], p: DVec2) -> bool {
    let mut inside = false;
    let n = outline.len();
    for i in 0..n {
        let (a, b) = (outline[i], outline[(i + 1) % n]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
    }
    inside
}
