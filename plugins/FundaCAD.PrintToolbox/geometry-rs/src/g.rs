//! ptb_occ.py: plain tuples for vectors, the host kernel for anything exact.

use crate::fundacad::plugin::types::{BooleanOp, PointState};
use crate::kernel;
use crate::{Shape, F};

pub type V = (f64, f64, f64);

pub fn add(a: V, b: V) -> V {
    (a.0 + b.0, a.1 + b.1, a.2 + b.2)
}

pub fn sub(a: V, b: V) -> V {
    (a.0 - b.0, a.1 - b.1, a.2 - b.2)
}

pub fn mul(a: V, s: f64) -> V {
    (a.0 * s, a.1 * s, a.2 * s)
}

pub fn dot(a: V, b: V) -> f64 {
    a.0 * b.0 + a.1 * b.1 + a.2 * b.2
}

pub fn cross(a: V, b: V) -> V {
    (a.1 * b.2 - a.2 * b.1, a.2 * b.0 - a.0 * b.2, a.0 * b.1 - a.1 * b.0)
}

pub fn norm(a: V) -> f64 {
    dot(a, a).sqrt()
}

pub fn unit(a: V) -> V {
    let n = norm(a);
    (a.0 / n, a.1 / n, a.2 / n)
}

/// origin + sum(scale * vector).
pub fn lin(origin: V, terms: &[(f64, V)]) -> V {
    terms.iter().fold(origin, |o, (s, v)| add(o, mul(*v, *s)))
}

pub fn build_dir(f: &F, label: &str) -> Result<V, String> {
    let key = f.text("buildDir", "+Z");
    Ok(match key {
        "+X" => (1.0, 0.0, 0.0),
        "-X" => (-1.0, 0.0, 0.0),
        "+Y" => (0.0, 1.0, 0.0),
        "-Y" => (0.0, -1.0, 0.0),
        "+Z" => (0.0, 0.0, 1.0),
        "-Z" => (0.0, 0.0, -1.0),
        other => return Err(format!("{label}: unknown build direction '{other}'")),
    })
}

/// Two unit vectors spanning the plane normal to `n`, the first nearest +X.
pub fn perp_frame(n: V) -> (V, V) {
    let hint = (1.0, 0.0, 0.0);
    let mut x = sub(hint, mul(n, dot(hint, n)));
    if norm(x) < 1e-6 {
        x = sub((0.0, 1.0, 0.0), mul(n, n.1));
    }
    let x = unit(x);
    (x, cross(n, x))
}

pub fn perp_frame_rotated(n: V, turn: f64) -> (V, V) {
    let (x, y) = perp_frame(n);
    let (c, s) = (turn.cos(), turn.sin());
    (add(mul(x, c), mul(y, s)), add(mul(y, c), mul(x, -s)))
}

/// A closed planar polygon swept along `vec`.
pub fn prism(points: &[V], vec: V) -> Result<Shape, String> {
    let face = kernel::polygon_face(points)?;
    kernel::prism(&face, vec)
}

pub fn inside(shape: &Shape, p: V) -> bool {
    shape.classify(p, 1e-6) == PointState::Inside
}

fn run_bool(op: BooleanOp, base: &Shape, tools: &[Shape], label: &str) -> Result<Shape, String> {
    let refs: Vec<&Shape> = tools.iter().collect();
    kernel::boolean(op, base, &refs).map_err(|e| format!("{label}: {e}"))
}

pub fn cut(base: &Shape, tools: &[Shape], label: &str) -> Result<Shape, String> {
    run_bool(BooleanOp::Cut, base, tools, label)
}

pub fn fuse(base: &Shape, tools: &[Shape], label: &str) -> Result<Shape, String> {
    run_bool(BooleanOp::Fuse, base, tools, label)
}

pub fn common(a: &Shape, b: &Shape) -> Option<Shape> {
    kernel::boolean(BooleanOp::Common, a, &[b]).ok()
}

/// Python's `format(v, "g")`, which the messages quote numbers with.
pub fn py_g(v: f64) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if v == 0.0 {
        return if v.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    let strip = |s: &str| {
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_owned()
        } else {
            s.to_owned()
        }
    };
    let sci = format!("{v:.5e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if (-4..6).contains(&exp) {
        let decimals = usize::try_from(5 - exp).unwrap_or(0);
        strip(&format!("{v:.decimals$}"))
    } else {
        let sign = if exp < 0 { '-' } else { '+' };
        format!("{}e{sign}{:02}", strip(mantissa), exp.abs())
    }
}
