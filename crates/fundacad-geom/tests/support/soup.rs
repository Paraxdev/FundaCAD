//! What every mesh the engine hands out must hold: no triangle without area, and for a closed solid every side met
//! by two triangles running opposite ways.
#![allow(dead_code)]

use std::collections::HashMap;

fn corner(positions: &[f32], i: u32) -> [f64; 3] {
    let i = i as usize * 3;
    [positions[i] as f64, positions[i + 1] as f64, positions[i + 2] as f64]
}

/// Triangles with two corners at one point, or lower over their longest side than two steps of single precision at
/// the mesh's largest coordinate, each as its three corners.
pub fn flat_triangles(positions: &[f32], indices: &[u32]) -> Vec<[[f64; 3]; 3]> {
    let reach = positions.iter().fold(0.0f64, |m, v| m.max(v.abs() as f64));
    let limit = 2.0 * f32::EPSILON as f64 * reach;
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let len = |a: [f64; 3]| (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    indices
        .chunks_exact(3)
        .map(|t| [corner(positions, t[0]), corner(positions, t[1]), corner(positions, t[2])])
        .filter(|[a, b, c]| {
            let (u, v) = (sub(*b, *a), sub(*c, *a));
            let twice_area = len([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
            let longest = len(u).max(len(v)).max(len(sub(*c, *b)));
            a == b || b == c || c == a || twice_area < limit * longest
        })
        .collect()
}

/// Sides not met by exactly two triangles running opposite ways, corners
/// joined by exact position.
pub fn open_sides(positions: &[f32], indices: &[u32]) -> usize {
    let mut ids: HashMap<[u32; 3], u32> = HashMap::new();
    let node: Vec<u32> = positions
        .chunks_exact(3)
        .map(|c| {
            let next = ids.len() as u32;
            *ids.entry([0, 1, 2].map(|k| (c[k] + 0.0).to_bits())).or_insert(next)
        })
        .collect();
    let mut sides: HashMap<(u32, u32), [u32; 2]> = HashMap::new();
    for t in indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (node[t[k] as usize], node[t[(k + 1) % 3] as usize]);
            sides.entry((a.min(b), a.max(b))).or_insert([0; 2])[usize::from(a > b)] += 1;
        }
    }
    sides.values().filter(|n| **n != [1, 1]).count()
}

/// The triangles an ASCII STL of the mesh holds with two corners at one point
/// or no area at all, its coordinates being written in seven digits.
pub fn lost_in_seven_digits(positions: &[f64], indices: &[u32]) -> usize {
    let written: Vec<f64> = positions.iter().map(|v| format!("{v:.6e}").parse().unwrap()).collect();
    let at = |i: u32| [0, 1, 2].map(|k| written[i as usize * 3 + k]);
    indices
        .chunks_exact(3)
        .filter(|t| {
            let (a, b, c) = (at(t[0]), at(t[1]), at(t[2]));
            let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            a == b || b == c || c == a || n == [0.0; 3]
        })
        .count()
}
