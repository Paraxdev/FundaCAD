//! Expression evaluation against a name to value scope, a port of
//! `src/params/eval.ts`.
//!
//! Arithmetic never fails (a division by zero is infinite, the caller gates on
//! finiteness); structure does (unknown parameter or function, wrong arity).
//! Truth is a number: comparisons and logic give 1 or 0, and NaN poisons them
//! so a broken input cannot quietly read as false. The JavaScript semantics of
//! `Math.round`, `Math.min`, `Math.max` and `Math.pow` are kept on purpose,
//! they are what the document's cached values were computed with.

use super::parse::{constant, parse_expr, BinOp, Expr, ExprError, FUNCTIONS, RESERVED_FUNCTIONS};

pub trait Scope {
    fn get(&self, name: &str) -> Option<f64>;
}

impl<S: std::hash::BuildHasher> Scope for std::collections::HashMap<String, f64, S> {
    fn get(&self, name: &str) -> Option<f64> {
        std::collections::HashMap::get(self, name).copied()
    }
}

impl<S: std::hash::BuildHasher> Scope for indexmap::IndexMap<String, f64, S> {
    fn get(&self, name: &str) -> Option<f64> {
        indexmap::IndexMap::get(self, name).copied()
    }
}

impl Scope for [(&str, f64)] {
    fn get(&self, name: &str) -> Option<f64> {
        self.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
    }
}

/// `==` in the language: a relative tolerance of 1e-9, so `0.1 + 0.2 == 0.3`.
pub fn nearly_equal(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    (a - b).abs() <= 1e-9 * 1f64.max(a.abs()).max(b.abs())
}

fn truth(b: bool) -> f64 {
    if b {
        1.0
    } else {
        0.0
    }
}

/// `Math.round`: halves go toward positive infinity.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        x.ceil()
    } else {
        f
    }
}

/// `Math.pow`, which differs from `powf` where the base is 1 or -1.
pub fn js_pow(x: f64, y: f64) -> f64 {
    if y.is_nan() || (x.abs() == 1.0 && y.is_infinite()) {
        return f64::NAN;
    }
    x.powf(y)
}

/// `Math.min` and `Math.max`: any NaN makes the result NaN.
fn js_fold(args: &[f64], pick: fn(f64, f64) -> f64) -> f64 {
    if args.iter().any(|a| a.is_nan()) {
        return f64::NAN;
    }
    args.iter().copied().reduce(pick).unwrap_or(f64::NAN)
}

fn apply(name: &str, a: &[f64]) -> f64 {
    let first = a.first().copied().unwrap_or(f64::NAN);
    match name {
        "sin" => ((first * std::f64::consts::PI) / 180.0).sin(),
        "cos" => ((first * std::f64::consts::PI) / 180.0).cos(),
        "tan" => ((first * std::f64::consts::PI) / 180.0).tan(),
        "asin" => (first.asin() * 180.0) / std::f64::consts::PI,
        "acos" => (first.acos() * 180.0) / std::f64::consts::PI,
        "atan" => (first.atan() * 180.0) / std::f64::consts::PI,
        "floor" => first.floor(),
        "ceil" => first.ceil(),
        "round" => js_round(first),
        "abs" => first.abs(),
        "sqrt" => first.sqrt(),
        "min" => js_fold(a, f64::min),
        "max" => js_fold(a, f64::max),
        "if" => {
            let (c, t, e) = (first, a.get(1).copied(), a.get(2).copied());
            if c.is_nan() {
                f64::NAN
            } else if c != 0.0 {
                t.unwrap_or(f64::NAN)
            } else {
                e.unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

fn arity_message(name: &str, lo: usize, hi: Option<usize>) -> String {
    let count = match hi {
        None => format!("at least {lo}"),
        Some(h) if h == lo => lo.to_string(),
        Some(h) => format!("{lo}, {h}"),
    };
    let plural = if lo == 1 && hi == Some(1) { "" } else { "s" };
    format!("{name}() takes {count} argument{plural}")
}

pub fn eval_node(n: &Expr, values: &(impl Scope + ?Sized)) -> Result<f64, ExprError> {
    Ok(match n {
        Expr::Num { v, .. } => *v,
        Expr::Ref(name) => values
            .get(name)
            .or_else(|| constant(name))
            .ok_or_else(|| ExprError::new(format!("unknown parameter \"{name}\""), None))?,
        Expr::Call { name, args } => {
            let Some((_, lo, hi)) = FUNCTIONS.iter().find(|(f, _, _)| f == name) else {
                let message = if RESERVED_FUNCTIONS.contains(&name.as_str()) {
                    format!("{name}() is not supported yet")
                } else {
                    format!("unknown function \"{name}\"")
                };
                return Err(ExprError::new(message, None));
            };
            if args.len() < *lo || hi.is_some_and(|h| args.len() > h) {
                return Err(ExprError::new(arity_message(name, *lo, *hi), None));
            }
            let vals = args
                .iter()
                .map(|a| eval_node(a, values))
                .collect::<Result<Vec<_>, _>>()?;
            apply(name, &vals)
        }
        Expr::Bin { op, l, r } => {
            let l = eval_node(l, values)?;
            let r = eval_node(r, values)?;
            if op.is_truth() && (l.is_nan() || r.is_nan()) {
                return Ok(f64::NAN);
            }
            match op {
                BinOp::Add => l + r,
                BinOp::Sub => l - r,
                BinOp::Mul => l * r,
                BinOp::Div => l / r,
                BinOp::Pow => js_pow(l, r),
                BinOp::Lt => truth(l < r),
                BinOp::Le => truth(l <= r || nearly_equal(l, r)),
                BinOp::Gt => truth(l > r),
                BinOp::Ge => truth(l >= r || nearly_equal(l, r)),
                BinOp::Eq => truth(nearly_equal(l, r)),
                BinOp::Ne => truth(!nearly_equal(l, r)),
                BinOp::And => truth(l != 0.0 && r != 0.0),
                BinOp::Or => truth(l != 0.0 || r != 0.0),
            }
        }
        Expr::Neg(e) => -eval_node(e, values)?,
        Expr::Not(e) => {
            let v = eval_node(e, values)?;
            if v.is_nan() {
                f64::NAN
            } else {
                truth(v == 0.0)
            }
        }
    })
}

/// Parse and evaluate. Structural problems are errors; a non-finite result is
/// returned for the caller to judge.
pub fn eval_expr(src: &str, values: &(impl Scope + ?Sized)) -> Result<f64, ExprError> {
    eval_node(&parse_expr(src)?, values)
}
