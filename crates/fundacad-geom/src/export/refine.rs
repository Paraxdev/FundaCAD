//! Longest facet edge cap, replaces `sidecar/mesh_refine.py`. Every long edge
//! is split at its midpoint on both of its triangles, so the mesh stays
//! conforming.

use std::collections::HashMap;

const MAX_PASSES: usize = 10;

/// `cap_edge_length`. A pass that would pass `budget` triangles is dropped,
/// but its midpoints stay in `positions`, unreferenced, as in Python.
pub fn cap_edge_length(
    positions: &[f64],
    indices: &[u32],
    max_edge: f64,
    budget: usize,
) -> (Vec<f64>, Vec<u32>) {
    let mut pos = positions[..positions.len() / 3 * 3].to_vec();
    let mut tri = indices[..indices.len() / 3 * 3].to_vec();
    if max_edge <= 0.0 || tri.is_empty() {
        return (pos, tri);
    }
    let limit2 = max_edge * max_edge;
    for _ in 0..MAX_PASSES {
        let d2 = |pos: &[f64], u: u32, v: u32| {
            let (u, v) = (u as usize * 3, v as usize * 3);
            let dx = pos[u] - pos[v];
            let dy = pos[u + 1] - pos[v + 1];
            let dz = pos[u + 2] - pos[v + 2];
            dx * dx + dy * dy + dz * dz
        };
        let mut edges: Vec<(u32, u32)> = Vec::new();
        for t in tri.chunks_exact(3) {
            for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                if d2(&pos, u, v) > limit2 {
                    edges.push(if u <= v { (u, v) } else { (v, u) });
                }
            }
        }
        if edges.is_empty() {
            break;
        }
        edges.sort_unstable();
        edges.dedup();
        let base = (pos.len() / 3) as u32;
        let mut mid = HashMap::with_capacity(edges.len());
        for (i, &(u, v)) in edges.iter().enumerate() {
            let (a, b) = (u as usize * 3, v as usize * 3);
            let m = [
                (pos[a] + pos[b]) * 0.5,
                (pos[a + 1] + pos[b + 1]) * 0.5,
                (pos[a + 2] + pos[b + 2]) * 0.5,
            ];
            mid.insert((u, v), base + i as u32);
            pos.extend_from_slice(&m);
        }
        let m = |u: u32, v: u32| mid.get(&if u < v { (u, v) } else { (v, u) }).copied();
        let mut out: Vec<u32> = Vec::with_capacity(tri.len() * 2);
        for t in tri.chunks_exact(3) {
            let (mut p, mut q, mut r) = (t[0], t[1], t[2]);
            let (mpq, mqr, mrp) = (m(p, q), m(q, r), m(r, p));
            let n = usize::from(mpq.is_some()) + usize::from(mqr.is_some()) + usize::from(mrp.is_some());
            match n {
                0 => out.extend([p, q, r]),
                3 => {
                    let (a, b, c) = (mpq.unwrap_or(0), mqr.unwrap_or(0), mrp.unwrap_or(0));
                    out.extend([p, a, c, a, q, b, c, b, r, a, b, c]);
                }
                1 => {
                    if mqr.is_some() {
                        (p, q, r) = (q, r, p);
                    } else if mrp.is_some() {
                        (p, q, r) = (r, p, q);
                    }
                    let mm = m(p, q).unwrap_or(0);
                    out.extend([p, mm, r, mm, q, r]);
                }
                _ => {
                    if mpq.is_none() {
                        (p, q, r) = (q, r, p);
                    } else if mqr.is_none() {
                        (p, q, r) = (r, p, q);
                    }
                    let (m1, m2) = (m(p, q).unwrap_or(0), m(q, r).unwrap_or(0));
                    out.extend([p, m1, m2, m1, q, m2, p, m2, r]);
                }
            }
        }
        if out.len() / 3 > budget {
            break;
        }
        tri = out;
    }
    (pos, tri)
}
