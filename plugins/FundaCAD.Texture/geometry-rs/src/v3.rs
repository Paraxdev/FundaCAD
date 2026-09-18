//! Plain 3-vectors, summed left to right as numpy sums three components.

pub type V = [f64; 3];

pub fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn scale(a: V, s: f64) -> V {
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
