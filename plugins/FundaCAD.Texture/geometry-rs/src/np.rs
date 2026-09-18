//! The numpy semantics the Python half's numbers depend on, one scalar at a
//! time: floor-mod, `round(x, n)`, `arange`, `unique`, `median`, `searchsorted`
//! and a least squares fit.

/// numpy's float `%`: the sign of the divisor, `npy_divmod`.
pub fn fmod(a: f64, b: f64) -> f64 {
    if b == 0.0 {
        return f64::NAN;
    }
    let m = a % b;
    if m != 0.0 {
        if (b < 0.0) != (m < 0.0) {
            m + b
        } else {
            m
        }
    } else {
        0.0f64.copysign(b)
    }
}

/// `np.round(x, decimals)`: scale, round half to even, unscale.
pub fn round(x: f64, decimals: i32) -> f64 {
    let p = 10f64.powi(decimals);
    (x * p).round_ties_even() / p
}

/// `np.arange(start, stop, step)` for floats: the length from the span, then
/// `start + i * delta` with delta measured off the first two values.
pub fn arange(start: f64, stop: f64, step: f64) -> Vec<f64> {
    let n = ((stop - start) / step).ceil();
    if !(n > 0.0) {
        return Vec::new();
    }
    let n = n as usize;
    let mut out = Vec::with_capacity(n);
    out.push(start);
    if n > 1 {
        let delta = (start + step) - start;
        for i in 1..n {
            out.push(start + i as f64 * delta);
        }
    }
    out
}

fn total(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

/// `np.unique` of floats: sorted, equal values merged.
pub fn unique(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| total(*a, *b));
    v.dedup_by(|a, b| a == b);
    v
}

/// `np.unique(rows, axis=0)` of 2D points: lexicographic, equal rows merged.
pub fn unique_rows(mut v: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    v.sort_by(|a, b| total(a[0], b[0]).then(total(a[1], b[1])));
    v.dedup_by(|a, b| a[0] == b[0] && a[1] == b[1]);
    v
}

pub fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| total(*a, *b));
    let n = s.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    }
}

/// `np.searchsorted(a, x)`, side left: the first index whose value is not
/// below `x`.
pub fn searchsorted(a: &[f64], x: f64) -> usize {
    a.partition_point(|&v| v < x)
}

pub fn min_max(v: impl IntoIterator<Item = f64>) -> (f64, f64) {
    v.into_iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)))
}

/// Least squares `M a = y` for an (n, 3) design matrix, by Householder QR.
/// Returns the three coefficients for each of the `k` right hand sides.
pub fn lstsq3(m: &[[f64; 3]], y: &[Vec<f64>]) -> Option<Vec<[f64; 3]>> {
    let n = m.len();
    if n < 3 {
        return None;
    }
    let mut a: Vec<[f64; 3]> = m.to_vec();
    let mut rhs: Vec<Vec<f64>> = y.to_vec();
    for col in 0..3 {
        let norm = (col..n).map(|r| a[r][col] * a[r][col]).sum::<f64>().sqrt();
        if norm == 0.0 {
            return None;
        }
        let alpha = if a[col][col] > 0.0 { -norm } else { norm };
        let mut v: Vec<f64> = (col..n).map(|r| a[r][col]).collect();
        v[0] -= alpha;
        let vv: f64 = v.iter().map(|x| x * x).sum();
        if vv == 0.0 {
            continue;
        }
        for c in col..3 {
            let d: f64 = (col..n).map(|r| v[r - col] * a[r][c]).sum();
            let f = 2.0 * d / vv;
            for r in col..n {
                a[r][c] -= f * v[r - col];
            }
        }
        for y in rhs.iter_mut() {
            let d: f64 = (col..n).map(|r| v[r - col] * y[r]).sum();
            let f = 2.0 * d / vv;
            for r in col..n {
                y[r] -= f * v[r - col];
            }
        }
    }
    let mut out = Vec::with_capacity(rhs.len());
    for y in &rhs {
        let mut x = [0.0; 3];
        for i in (0..3).rev() {
            let mut s = y[i];
            for j in i + 1..3 {
                s -= a[i][j] * x[j];
            }
            if a[i][i] == 0.0 {
                return None;
            }
            x[i] = s / a[i][i];
        }
        out.push(x);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_numpy() {
        assert_eq!(fmod(-1.0, 3.0), 2.0);
        assert_eq!(fmod(1.0, -3.0), -2.0);
        assert_eq!(fmod(-3.0, 3.0), 0.0);
        assert_eq!(round(0.125, 2), 0.12);
        assert_eq!(round(2.5, 0), 2.0);
        assert_eq!(arange(0.0, 1.0, 0.25), vec![0.0, 0.25, 0.5, 0.75]);
        assert_eq!(arange(0.0, 1.0, 0.3).len(), 4);
        assert_eq!(unique(vec![3.0, 1.0, 3.0, 2.0]), vec![1.0, 2.0, 3.0]);
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), 2.5);
        assert_eq!(searchsorted(&[1.0, 2.0, 3.0], 2.0), 1);
        let m = vec![[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 1.0]];
        let y = vec![vec![1.0, 3.0, 4.0, 6.0]];
        let a = lstsq3(&m, &y).unwrap();
        assert!((a[0][0] - 2.0).abs() < 1e-12 && (a[0][1] - 3.0).abs() < 1e-12 && (a[0][2] - 1.0).abs() < 1e-12);
    }
}
