//! Drops triangles without area, which the mesher leaves at surface poles and split edge joins,
//! never opening the mesh. One that cannot go stays for the printability check to report.

use std::collections::HashMap;

use super::tessellate::{position_key, SplitJoin, Tessellation};

fn single(v: f64) -> f64 {
    f64::from(v as f32)
}

/// Two single precision steps at the largest coordinate. A f32 corner is up to 0.87 step off, so a
/// triangle and its f32 copy surely agree only above 1.74 steps, and both precisions get one answer.
pub fn limit(coordinates: impl IntoIterator<Item = f64>) -> f64 {
    2.0 * f64::from(f32::EPSILON) * coordinates.into_iter().fold(0.0f64, |m, v| m.max(single(v).abs()))
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The squared lengths of the sides opposite each corner.
fn sides(p: &[[f64; 3]; 3]) -> [f64; 3] {
    [1, 2, 0].map(|k| {
        let d = sub(p[(k + 1) % 3], p[k]);
        dot(d, d)
    })
}

/// Whether the triangle has two corners at one point or stands lower than
/// `limit` over its longest side.
pub fn is_flat(p: &[[f64; 3]; 3], limit: f64) -> bool {
    let p = p.map(|c| c.map(single));
    let (u, v) = (sub(p[1], p[0]), sub(p[2], p[0]));
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let longest = sides(&p).into_iter().fold(0.0, f64::max);
    p[0] == p[1] || p[1] == p[2] || p[2] == p[0] || !(dot(n, n) >= limit * limit * longest)
}

fn point(positions: &[f64], i: u32) -> [f64; 3] {
    let i = i as usize * 3;
    [positions[i], positions[i + 1], positions[i + 2]]
}

fn corners(positions: &[f64], t: &[u32]) -> [[f64; 3]; 3] {
    [0, 1, 2].map(|k| point(positions, t[k]))
}

type Side = [[u64; 3]; 2];

fn side(positions: &[f64], a: u32, b: u32) -> Side {
    let (a, b) = (position_key(&positions[3 * a as usize..]), position_key(&positions[3 * b as usize..]));
    if a <= b {
        [a, b]
    } else {
        [b, a]
    }
}

/// A flat triangle that only joins two of its corners needs a few rounds at
/// most, a fan of them along one straight side one round a level.
const ROUNDS: usize = 32;

pub(super) fn remove(out: &mut Tessellation) {
    let limit = limit(out.positions.iter().copied());
    let count = out.indices.len() / 3;
    if !limit.is_finite() || out.face_ids.len() != count {
        return;
    }
    let flat_ones = |out: &Tessellation, dead: &[bool]| -> Vec<usize> {
        out.indices
            .chunks_exact(3)
            .enumerate()
            .filter(|(t, c)| !dead[*t] && is_flat(&corners(&out.positions, c), limit))
            .map(|(t, _)| t)
            .collect()
    };
    let mut dead = vec![false; count];
    let mut flat = flat_ones(out, &dead);
    if flat.is_empty() {
        return;
    }
    // The triangle each one was when the mesh came in, so that what a
    // division adds ends up beside it, among its own face's triangles.
    let mut origin: Vec<usize> = (0..count).collect();
    for _ in 0..ROUNDS {
        crate::heartbeat::beat();
        let mut changed = join_close_corners(out, &flat, limit);
        for &t in &flat {
            let p = corners(&out.positions, &out.indices[3 * t..3 * t + 3]);
            if p[0] == p[1] || p[1] == p[2] || p[2] == p[0] {
                dead[t] = true;
                changed = true;
            }
        }
        changed |= divide_across_long_sides(out, &mut dead, &mut origin, &flat, limit);
        if !changed {
            break;
        }
        flat = flat_ones(out, &dead);
        if flat.is_empty() {
            break;
        }
    }
    let mut live: Vec<usize> = (0..dead.len()).filter(|t| !dead[*t]).collect();
    if dead.len() > count {
        live.sort_by_key(|&t| origin[t]);
    }
    out.indices = live.iter().flat_map(|&t| [0, 1, 2].map(|k| out.indices[3 * t + k])).collect();
    out.face_ids = live.iter().map(|&t| out.face_ids[t]).collect();
}

/// Two corners of a flat triangle closer than `limit` become one point, on
/// every triangle of the body.
fn join_close_corners(out: &mut Tessellation, flat: &[usize], limit: f64) -> bool {
    let mut pairs = Vec::new();
    for &t in flat {
        let p = corners(&out.positions, &out.indices[3 * t..3 * t + 3]);
        for k in 0..3 {
            let (a, b) = (p[k], p[(k + 1) % 3]);
            let d = sub(a, b);
            if a != b && dot(d, d) < limit * limit {
                pairs.push([a, b]);
            }
        }
    }
    if pairs.is_empty() {
        return false;
    }
    SplitJoin::new(pairs, limit).settle(&mut out.positions);
    true
}

/// The corner lying on the long side divides the triangle across it into two that run the short sides.
/// With nothing across (an open sheet's rim) the flat one just goes.
fn divide_across_long_sides(
    out: &mut Tessellation,
    dead: &mut Vec<bool>,
    origin: &mut Vec<usize>,
    flat: &[usize],
    limit: f64,
) -> bool {
    // Each one as [the corner in the middle, the long side's two ends], in
    // the triangle's own order.
    let apart: Vec<(usize, [u32; 3])> = flat
        .iter()
        .filter(|&&t| !dead[t])
        .filter_map(|&t| {
            let lengths = sides(&corners(&out.positions, &out.indices[3 * t..3 * t + 3]));
            let k = (0..3).max_by(|a, b| lengths[*a].total_cmp(&lengths[*b]))?;
            lengths
                .iter()
                .all(|s| *s >= limit * limit)
                .then(|| (t, [0, 1, 2].map(|j| out.indices[3 * t + (k + j) % 3])))
        })
        .collect();
    if apart.is_empty() {
        return false;
    }
    let mut users: HashMap<Side, Vec<usize>> =
        apart.iter().map(|(_, [_, from, to])| (side(&out.positions, *from, *to), Vec::new())).collect();
    for (t, c) in out.indices.chunks_exact(3).enumerate().filter(|(t, _)| !dead[*t]) {
        for k in 0..3 {
            if let Some(u) = users.get_mut(&side(&out.positions, c[k], c[(k + 1) % 3])) {
                u.push(t);
            }
        }
    }
    let mut touched = vec![false; dead.len()];
    let mut changed = false;
    for (t, [mid, from, to]) in apart {
        let across = match users.get(&side(&out.positions, from, to)).map(Vec::as_slice) {
            Some(&[x]) if x == t && !touched[t] => {
                dead[t] = true;
                changed = true;
                continue;
            }
            Some(&[x, y]) if x != y && (x == t || y == t) => x + y - t,
            _ => continue,
        };
        if touched[t] || touched[across] {
            continue;
        }
        let n: [u32; 3] = [0, 1, 2].map(|j| out.indices[3 * across + j]);
        let at = |i: u32| position_key(&out.positions[3 * i as usize..]);
        // Either way round: a flat triangle's winding says nothing, a mesh pass may hand it over either way,
        // and the halves keep the neighbour's winding.
        let ends = [at(from), at(to)];
        let Some(j) = (0..3).find(|&j| {
            let run = [at(n[j]), at(n[(j + 1) % 3])];
            run == ends || run == [ends[1], ends[0]]
        }) else {
            continue;
        };
        let (start, end, far) = (n[j], n[(j + 1) % 3], n[(j + 2) % 3]);
        let [s, e, f] = [start, end, far].map(|i| point(&out.positions, i));
        if is_flat(&[s, e, f], limit) {
            // Two flat triangles back to back over one long side: the side turns to run between their middle
            // corners, leaving each a long side with a real triangle across.
            let lengths = sides(&[s, e, f]);
            if lengths[2] >= lengths[0].max(lengths[1]) && lengths.iter().all(|l| *l >= limit * limit) {
                out.indices[3 * t..3 * t + 3].copy_from_slice(&[mid, from, far]);
                out.indices[3 * across..3 * across + 3].copy_from_slice(&[far, to, mid]);
                touched[t] = true;
                touched[across] = true;
                changed = true;
            }
            continue;
        }
        let added = (out.positions.len() / 3) as u32;
        let p = point(&out.positions, mid);
        // Halves that are flat themselves would only pass the fault along.
        if is_flat(&[s, p, f], limit) || is_flat(&[p, e, f], limit) {
            continue;
        }
        if let Some(normals) = &mut out.normals {
            // The neighbour's own shading at its new corner, not the flat
            // triangle's, which may be another face's.
            let reach = |i: u32| {
                let d = sub(point(&out.positions, i), p);
                dot(d, d).sqrt()
            };
            let (to_start, to_end) = (reach(start), reach(end));
            let share = if to_start + to_end > 0.0 { to_start / (to_start + to_end) } else { 0.5 };
            let (s, e) = (start as usize * 3, end as usize * 3);
            let mut mix = [0, 1, 2].map(|c| normals[s + c] * (1.0 - share) + normals[e + c] * share);
            let len = dot(mix, mix).sqrt();
            if len > 1e-12 {
                mix = mix.map(|v| v / len);
            } else {
                mix = [normals[s], normals[s + 1], normals[s + 2]];
            }
            normals.extend_from_slice(&mix);
        }
        out.positions.extend_from_slice(&p);
        out.indices[3 * across..3 * across + 3].copy_from_slice(&[start, added, far]);
        out.indices.extend_from_slice(&[added, end, far]);
        out.face_ids.push(out.face_ids[across]);
        origin.push(origin[across]);
        dead[t] = true;
        dead.push(false);
        touched.push(true);
        touched[t] = true;
        touched[across] = true;
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: [f64; 3] = [0.0, 0.0, 0.0];
    const B: [f64; 3] = [1.0, 0.0, 0.0];
    const C: [f64; 3] = [0.0, 1.0, 0.0];
    const D: [f64; 3] = [0.0, 0.0, 1.0];

    fn mesh(points: &[[f64; 3]], indices: &[u32]) -> Tessellation {
        Tessellation {
            positions: points.iter().flatten().copied().collect(),
            indices: indices.to_vec(),
            face_ids: (0..indices.len() as u32 / 3).collect(),
            normals: None,
        }
    }

    /// Sides not met by exactly two triangles running opposite ways, and the
    /// triangles still flat.
    fn faults(t: &Tessellation) -> (usize, usize) {
        let mut met: HashMap<Side, [u32; 2]> = HashMap::new();
        for c in t.indices.chunks_exact(3) {
            for k in 0..3 {
                let at = |i: u32| position_key(&t.positions[3 * i as usize..]);
                met.entry(side(&t.positions, c[k], c[(k + 1) % 3])).or_insert([0; 2])
                    [usize::from(at(c[k]) > at(c[(k + 1) % 3]))] += 1;
            }
        }
        let limit = limit(t.positions.iter().copied());
        let flat = t.indices.chunks_exact(3).filter(|c| is_flat(&corners(&t.positions, c), limit)).count();
        (met.values().filter(|n| **n != [1, 1]).count(), flat)
    }

    #[test]
    fn a_triangle_between_the_two_nodes_of_a_pole_goes_and_the_mesh_stays_closed() {
        // Node 4 is the pole A again, as the mesher holds it for the other
        // end of the pole's side.
        let mut t = mesh(&[A, B, C, D, A], &[0, 2, 1, 0, 1, 3, 4, 3, 2, 1, 2, 3, 0, 4, 2, 4, 0, 3]);
        assert_eq!(faults(&t).1, 2);
        remove(&mut t);
        assert_eq!(t.indices, vec![0, 2, 1, 0, 1, 3, 4, 3, 2, 1, 2, 3]);
        assert_eq!(t.face_ids, vec![0, 1, 2, 3]);
        assert_eq!(faults(&t), (0, 0));
    }

    #[test]
    fn two_corners_closer_than_the_limit_become_one_point() {
        let near = [1e-9, 0.0, 0.0];
        let mut t = mesh(&[A, B, C, D, near], &[0, 2, 1, 0, 1, 3, 4, 3, 2, 1, 2, 3, 4, 2, 0, 0, 3, 4]);
        assert_eq!(faults(&t), (0, 2));
        remove(&mut t);
        assert_eq!(t.indices.len(), 12);
        assert_eq!(t.positions[12..15], A);
        assert_eq!(faults(&t), (0, 0));
    }

    #[test]
    fn a_corner_on_the_side_between_the_other_two_divides_the_triangle_across() {
        // M lies a quarter of the way from B to C. One face runs that side whole, the other in two steps,
        // and a triangle of no area lies between.
        let m = [0.75, 0.25, 0.0];
        let mut t = mesh(&[A, B, C, D, m], &[0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 4, 3, 4, 2, 3, 1, 2, 4]);
        t.normals =
            Some([[0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]].concat());
        assert_eq!(faults(&t), (0, 1));
        remove(&mut t);
        // The half of the divided triangle that was added sits beside it.
        assert_eq!(t.indices, vec![2, 5, 0, 5, 1, 0, 0, 1, 3, 0, 3, 2, 1, 4, 3, 4, 2, 3]);
        assert_eq!(t.face_ids, vec![0, 0, 1, 2, 3, 4]);
        assert_eq!(t.positions[15..18], m);
        // Shaded as the divided triangle is there, three parts B to one C.
        let n = &t.normals.as_ref().unwrap()[15..18];
        let len = (0.75f64 * 0.75 + 0.25 * 0.25).sqrt();
        assert!((n[0] - 0.75 / len).abs() < 1e-12 && (n[1] - 0.25 / len).abs() < 1e-12 && n[2] == 0.0, "{n:?}");
        assert_eq!(faults(&t), (0, 0));
    }

    #[test]
    fn a_flat_triangle_wound_the_other_way_round_goes_all_the_same() {
        let m = [0.75, 0.25, 0.0];
        let mut t = mesh(&[A, B, C, D, m], &[0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 4, 3, 4, 2, 3, 1, 4, 2]);
        assert_eq!(faults(&t), (3, 1));
        remove(&mut t);
        assert_eq!(t.indices, vec![2, 5, 0, 5, 1, 0, 0, 1, 3, 0, 3, 2, 1, 4, 3, 4, 2, 3]);
        assert_eq!(faults(&t), (0, 0));
    }

    #[test]
    fn a_fan_of_flat_triangles_along_one_side_goes_level_by_level() {
        // B, M1, M2, C on one line. The fan from C runs it in three steps on
        // one face, the triangle A B C runs it whole on the other.
        let (m1, m2) = ([0.75, 0.25, 0.0], [0.5, 0.5, 0.0]);
        let mut t =
            mesh(&[A, B, C, D, m1, m2], &[0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 4, 3, 4, 5, 3, 5, 2, 3, 1, 2, 5, 1, 5, 4]);
        assert_eq!(faults(&t), (0, 2));
        remove(&mut t);
        assert_eq!(t.face_ids, vec![0, 0, 0, 1, 2, 3, 4, 5]);
        assert_eq!(faults(&t), (0, 0));
    }

    #[test]
    fn a_triangle_whose_halves_would_be_flat_is_not_divided() {
        // M lies on A to B. The triangle across runs to F, one and a half limits off the side at B, so its
        // half from A to M is half as high and dividing it would only pass the fault along.
        let l = limit([5.0]);
        let (m, f) = ([0.5, 0.0, 0.0], [5.0, 7.5 * l, 0.0]);
        let mut t = mesh(&[A, B, m, f], &[0, 2, 1, 0, 1, 3]);
        assert!(!is_flat(&[A, B, f], l) && is_flat(&[A, m, f], l));
        let before = t.clone();
        remove(&mut t);
        assert_eq!(t, before);
    }

    #[test]
    fn a_flat_triangle_on_the_rim_of_an_open_sheet_goes() {
        let m = [0.5, 0.5, 0.0];
        let mut t = mesh(&[A, B, C, m], &[0, 1, 3, 0, 3, 2, 1, 2, 3]);
        remove(&mut t);
        assert_eq!(t.indices, vec![0, 1, 3, 0, 3, 2]);
    }

    #[test]
    fn two_flat_triangles_back_to_back_turn_the_side_between_them_and_go() {
        // One face runs the side from B to C by way of M1, the other by way
        // of M2, and the two flat triangles between them share that side.
        let (m1, m2) = ([0.75, 0.25, 0.0], [0.25, 0.75, 0.0]);
        let mut t =
            mesh(&[A, B, C, D, m1, m2], &[0, 2, 4, 0, 4, 1, 0, 1, 3, 0, 3, 2, 1, 5, 3, 5, 2, 3, 1, 4, 2, 2, 5, 1]);
        assert_eq!(faults(&t), (0, 2));
        remove(&mut t);
        assert_eq!(t.face_ids, vec![0, 0, 1, 2, 3, 4, 4, 5]);
        assert_eq!(faults(&t), (0, 0));
    }

    #[test]
    fn the_limit_is_two_single_precision_steps_at_the_size_of_the_mesh() {
        let l = limit([-64.0, 3.0, 5.0]);
        assert_eq!(l, 2.0 * f64::from(f32::from_bits(64.0f32.to_bits() + 1) - 64.0));
        assert_eq!(limit([0.1]), 2.0 * f64::from(f32::EPSILON) * f64::from(0.1f32));
        let low = |h: f64| [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [5.0, h, 0.0]];
        assert!(is_flat(&low(0.9 * l), l));
        assert!(!is_flat(&low(1.1 * l), l));
        assert!(is_flat(&[A, A, B], l));
        assert!(is_flat(&[A, A, A], l));
        // Two corners that single precision cannot tell apart are one point.
        assert!(is_flat(&[[64.0, 0.0, 0.0], [64.0 + 1e-9, 0.0, 0.0], [0.0, 64.0, 0.0]], 0.0));
    }
}
