//! The small 2D helpers the sketch compiler shares with FundaCAD 1's arc.ts, region.ts, bspline.ts and angleWedge.ts.

use std::f64::consts::{PI, TAU};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct V {
    pub x: f64,
    pub y: f64,
}

pub const fn v(x: f64, y: f64) -> V {
    V { x, y }
}

pub fn ccw_delta(from: f64, to: f64) -> f64 {
    ((to - from) % TAU + TAU) % TAU
}

/// JavaScript's `Math.round`, which rounds halves up where Rust's rounds them away from zero.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Two points merge iff their keys match, 0.001 mm buckets.
pub fn coinc_key(x: f64, y: f64) -> (i64, i64) {
    #[allow(clippy::cast_possible_truncation)]
    (js_round(x * 1000.0) as i64, js_round(y * 1000.0) as i64)
}

pub fn circumcenter(a: V, b: V, c: V) -> Option<V> {
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1e-9 {
        return None;
    }
    let a2 = a.x * a.x + a.y * a.y;
    let b2 = b.x * b.x + b.y * b.y;
    let c2 = c.x * c.x + c.y * c.y;
    Some(v(
        (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
        (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
    ))
}

/// Counterclockwise from bottom left: bl, br, tr, tl. Angle 0 must stay bit identical to the unrotated corners, saved
/// axis aligned rectangles depend on it.
pub fn rect_corners(x: f64, y: f64, width: f64, height: f64, angle_deg: f64) -> [V; 4] {
    let (hw, hh) = (width / 2.0, height / 2.0);
    let local = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)];
    if angle_deg == 0.0 || angle_deg.is_nan() {
        return local.map(|(lx, ly)| v(x + lx, y + ly));
    }
    let a = angle_deg * PI / 180.0;
    let (s, c) = a.sin_cos();
    local.map(|(lx, ly)| v(x + lx * c - ly * s, y + lx * s + ly * c))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RectDef {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub angle: f64,
}

const RECT_EPS: f64 = 1e-4;

/// The rectangle with edge a to b whose opposite side passes through c.
pub fn rect_from_three_points(a: V, b: V, c: V) -> Option<RectDef> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let width = dx.hypot(dy);
    if width.is_nan() || width <= RECT_EPS {
        return None;
    }
    let (ux, uy) = (dx / width, dy / width);
    let signed_height = (c.x - a.x) * -uy + (c.y - a.y) * ux;
    if signed_height.is_nan() || signed_height.abs() <= RECT_EPS {
        return None;
    }
    Some(RectDef {
        x: (a.x + b.x) / 2.0 + -uy * (signed_height / 2.0),
        y: (a.y + b.y) / 2.0 + ux * (signed_height / 2.0),
        width,
        height: signed_height.abs(),
        angle: dy.atan2(dx) * 180.0 / PI,
    })
}

/// A B-spline pole's reference index: 0 the first pole, 1 the last, k + 1 interior pole k.
pub fn pole_ref(k: usize, n: usize) -> i64 {
    if k == 0 {
        0
    } else if k + 1 == n {
        1
    } else {
        k as i64 + 1
    }
}

/// The inverse of `pole_ref`.
pub fn pole_of_ref(p: i64, n: usize) -> Option<usize> {
    if n < 1 {
        return None;
    }
    match p {
        0 => Some(0),
        1 => Some(n - 1),
        _ => {
            let k = p - 1;
            (k >= 1 && k <= n as i64 - 2).then_some(k as usize)
        }
    }
}

/// The signed angle in degrees, in (-180, 180], from l1's direction to l2's that an angle dimension means.
pub fn solver_angle_deg(value: f64, rays: Option<[i8; 2]>) -> f64 {
    let mut d = match rays {
        Some([a, b]) if a != b => value + 180.0,
        _ => value,
    };
    d = (d % 360.0 + 360.0) % 360.0;
    if d > 180.0 {
        d - 360.0
    } else {
        d
    }
}
