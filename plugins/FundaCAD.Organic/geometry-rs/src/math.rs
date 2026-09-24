//! Plain vectors and 3x3 matrices, row major.

pub type V = [f64; 3];
pub type M = [[f64; 3]; 3];

pub fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn mul(a: V, s: f64) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}

pub fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: V, b: V) -> V {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn norm(a: V) -> f64 {
    dot(a, a).sqrt()
}

pub fn unit(a: V) -> V {
    mul(a, 1.0 / norm(a))
}

pub fn tuple(a: V) -> (f64, f64, f64) {
    (a[0], a[1], a[2])
}

pub fn mat_mul(a: &M, b: &M) -> M {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

pub fn apply(m: &M, v: V) -> V {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}

pub fn transpose(m: &M) -> M {
    [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
}

/// Rz(rz) * Ry(ry) * Rx(rx), degrees: turned about X first, then Y, then Z,
/// all about the fixed world axes.
pub fn rotation(rx: f64, ry: f64, rz: f64) -> M {
    let (sx, cx) = rx.to_radians().sin_cos();
    let (sy, cy) = ry.to_radians().sin_cos();
    let (sz, cz) = rz.to_radians().sin_cos();
    let x = [[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]];
    let y = [[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]];
    let z = [[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]];
    mat_mul(&z, &mat_mul(&y, &x))
}

/// Two unit vectors spanning the plane normal to the unit `n`, the first as
/// near `hint` as the plane allows.
pub fn perp_pair(n: V, hint: V) -> (V, V) {
    let mut x = sub(hint, mul(n, dot(hint, n)));
    if norm(x) < 1e-6 {
        let other = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        x = sub(other, mul(n, dot(other, n)));
    }
    let x = unit(x);
    (x, cross(n, x))
}
