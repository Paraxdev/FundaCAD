//! Transcendentals from the engine's C math library (the `numeric` import), so
//! they round as the Python half's math and numpy calls do on the same machine:
//! both end in the platform libm, where Rust's own wasm copies can land one ulp
//! apart, and one ulp moves a Delaunay tie or a floor at a cell boundary.
//! Native builds (the unit tests) call the platform libm directly.

#[cfg(target_arch = "wasm32")]
mod imp {
    use crate::fundacad::plugin::numeric::{self, BinaryOp, UnaryOp};

    pub fn sin(xs: &[f64]) -> Vec<f64> {
        numeric::unary(UnaryOp::Sin, xs)
    }
    pub fn cos(xs: &[f64]) -> Vec<f64> {
        numeric::unary(UnaryOp::Cos, xs)
    }
    pub fn exp(xs: &[f64]) -> Vec<f64> {
        numeric::unary(UnaryOp::Exp, xs)
    }
    pub fn acos(xs: &[f64]) -> Vec<f64> {
        numeric::unary(UnaryOp::Acos, xs)
    }
    pub fn pow(xs: &[f64], ys: &[f64]) -> Vec<f64> {
        numeric::binary(BinaryOp::Pow, xs, ys)
    }
    pub fn hypot(xs: &[f64], ys: &[f64]) -> Vec<f64> {
        numeric::binary(BinaryOp::Hypot, xs, ys)
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    pub fn sin(xs: &[f64]) -> Vec<f64> {
        xs.iter().map(|x| x.sin()).collect()
    }
    pub fn cos(xs: &[f64]) -> Vec<f64> {
        xs.iter().map(|x| x.cos()).collect()
    }
    pub fn exp(xs: &[f64]) -> Vec<f64> {
        xs.iter().map(|x| x.exp()).collect()
    }
    pub fn acos(xs: &[f64]) -> Vec<f64> {
        xs.iter().map(|x| x.acos()).collect()
    }
    pub fn pow(xs: &[f64], ys: &[f64]) -> Vec<f64> {
        xs.iter().zip(ys).map(|(x, y)| x.powf(*y)).collect()
    }
    pub fn hypot(xs: &[f64], ys: &[f64]) -> Vec<f64> {
        xs.iter().zip(ys).map(|(x, y)| x.hypot(*y)).collect()
    }
}

pub use imp::{acos, cos, exp, hypot, sin};

/// numpy's `x ** y` for a scalar exponent: its fast paths, then pow.
pub fn pow_scalar(xs: &[f64], y: f64) -> Vec<f64> {
    if y == 1.0 {
        return xs.to_vec();
    }
    if y == 2.0 {
        return xs.iter().map(|x| x * x).collect();
    }
    if y == 0.5 {
        return xs.iter().map(|x| x.sqrt()).collect();
    }
    if y == 0.0 {
        return vec![1.0; xs.len()];
    }
    if y == -1.0 {
        return xs.iter().map(|x| 1.0 / x).collect();
    }
    imp::pow(xs, &vec![y; xs.len()])
}

pub fn sin1(x: f64) -> f64 {
    sin(&[x])[0]
}

pub fn cos1(x: f64) -> f64 {
    cos(&[x])[0]
}

pub fn hypot1(x: f64, y: f64) -> f64 {
    hypot(&[x], &[y])[0]
}

/// (cos, sin) of an angle in degrees, `math.radians` then the libm pair,
/// remembered per angle: a height field asks for the same few angles often.
pub fn cos_sin_deg(deg: f64) -> (f64, f64) {
    use std::cell::RefCell;
    thread_local! {
        static MEMO: RefCell<Vec<(u64, f64, f64)>> = const { RefCell::new(Vec::new()) };
    }
    let key = deg.to_bits();
    if let Some(hit) = MEMO.with(|m| m.borrow().iter().find(|e| e.0 == key).map(|e| (e.1, e.2))) {
        return hit;
    }
    let a = deg.to_radians();
    let (c, s) = (cos1(a), sin1(a));
    MEMO.with(|m| m.borrow_mut().push((key, c, s)));
    (c, s)
}
