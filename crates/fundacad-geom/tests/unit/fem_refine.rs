use std::collections::HashMap;

use fundacad_geom::fem::refine::*;
use fundacad_geom::fem::solve::{solve, Load, LoadKind, Material, Problem};
use fundacad_geom::fem::tetmesh::{tetrahedralize, MeshError};
use fundacad_geom::fem::{MeshOptions, SurfaceMesh, TetMesh};

use crate::fem_solve::box_mesh;
use crate::fem_tetmesh::{cuboid, holed_plate, rotate};

type V3 = [f64; 3];

const AT: V3 = [17.0, -9.0, 31.0];
const TURN: V3 = [0.35, 0.0, 0.52];

fn place(p: V3) -> V3 {
    let r = rotate(p, TURN[0], TURN[1], TURN[2]);
    [r[0] + AT[0], r[1] + AT[1], r[2] + AT[2]]
}

fn unplace(p: V3) -> V3 {
    let q = [p[0] - AT[0], p[1] - AT[1], p[2] - AT[2]];
    let q = rotate(q, 0.0, 0.0, -TURN[2]);
    rotate(q, -TURN[0], 0.0, 0.0)
}

const SIZE: V3 = [40.0, 13.0, 9.0];

/// A jittered box of SIZE, slanted and off the origin, with its own boundary as the input surface.
fn slanted_box(n: [usize; 3], jitter: f64) -> (TetMesh, SurfaceMesh) {
    let mut m = box_mesh(SIZE, n, jitter);
    for p in &mut m.nodes {
        *p = place(*p);
    }
    let surface = cuboid(SIZE, &place);
    (m, surface)
}

/// The box side a local point lies on, as cuboid numbers them.
fn side(p: V3) -> Vec<u32> {
    let q = unplace(p);
    (0..6u32)
        .filter(|&f| {
            let a = (f / 2) as usize;
            let target = if f % 2 == 1 { SIZE[a] } else { 0.0 };
            (q[a] - target).abs() < 1e-7
        })
        .collect()
}

fn go() -> bool {
    true
}

fn opts(max_tets: usize, min_edge: f64) -> RefineOptions {
    RefineOptions { max_tets, min_edge, size: 3.0 }
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn det(m: &TetMesh, t: [u32; 4]) -> f64 {
    let x = t.map(|n| m.nodes[n as usize]);
    dot(sub(x[1], x[0]), cross(sub(x[2], x[0]), sub(x[3], x[0])))
}

fn volume(m: &TetMesh) -> f64 {
    m.tets.iter().map(|&t| det(m, t) / 6.0).sum()
}

fn key(a: u32, b: u32) -> (u32, u32) {
    (a.min(b), a.max(b))
}

const EDGES: [[usize; 2]; 6] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/// The refiner's edge order: length, then the sorted node pair.
fn longest(m: &TetMesh, t: usize) -> (u32, u32) {
    let tet = m.tets[t];
    let rank = |[i, j]: [usize; 2]| {
        let d = sub(m.nodes[tet[i] as usize], m.nodes[tet[j] as usize]);
        (dot(d, d), key(tet[i], tet[j]))
    };
    let best = EDGES.iter().map(|&e| rank(e)).max_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1))).unwrap();
    best.1
}

fn ring(m: &TetMesh, e: (u32, u32)) -> Vec<usize> {
    (0..m.tets.len()).filter(|&t| m.tets[t].contains(&e.0) && m.tets[t].contains(&e.1)).collect()
}

/// Every invariant a refined mesh keeps, with `tag` naming the faces a boundary point may lie on.
fn audit(before: &TetMesh, r: &Refined, tag: &dyn Fn(V3) -> Vec<u32>) {
    let m = &r.mesh;
    assert!(m.tets.iter().all(|&t| det(m, t) > 0.0), "an inverted tet");
    let (v0, v1) = (volume(before), volume(m));
    assert!((v1 - v0).abs() <= 1e-12 * v0, "volume {v0} became {v1}");
    let mut faces: HashMap<[u32; 3], usize> = HashMap::new();
    for t in &m.tets {
        for skip in 0..4 {
            let mut f: Vec<u32> = (0..4).filter(|&i| i != skip).map(|i| t[i]).collect();
            f.sort_unstable();
            *faces.entry([f[0], f[1], f[2]]).or_default() += 1;
        }
    }
    assert!(faces.values().all(|&c| c <= 2), "a triangle shared by three tets");
    let mut once: Vec<[u32; 3]> = faces.iter().filter(|(_, &c)| c == 1).map(|(k, _)| *k).collect();
    let mut listed: Vec<[u32; 3]> = m
        .boundary
        .iter()
        .map(|t| {
            let mut k = *t;
            k.sort_unstable();
            k
        })
        .collect();
    once.sort_unstable();
    listed.sort_unstable();
    assert_eq!(listed, once, "the boundary is not the tets' open faces");
    let mut half: HashMap<(u32, u32), i32> = HashMap::new();
    for t in &m.boundary {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            *half.entry(key(a, b)).or_default() += if a < b { 1 } else { -1 };
        }
    }
    assert!(half.values().all(|&c| c == 0), "the boundary is not closed and consistently wound");
    let centre = {
        let s = m.nodes.iter().fold([0.0; 3], |s, p| [s[0] + p[0], s[1] + p[1], s[2] + p[2]]);
        s.map(|v| v / m.nodes.len() as f64)
    };
    let mut outward = 0.0;
    for (t, &f) in m.boundary.iter().zip(&m.boundary_face) {
        let [a, b, c] = t.map(|n| m.nodes[n as usize]);
        let mid = [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0);
        outward += dot(cross(sub(b, a), sub(c, a)), sub(mid, centre));
        assert!(tag(mid).contains(&f), "a boundary triangle tagged {f} at {mid:?}");
    }
    assert!(outward > 0.0);
    if r.split > 0 {
        assert!(m.node_faces.windows(2).all(|w| w[0] < w[1]), "node_faces not sorted");
        for &(n, f) in &m.node_faces {
            assert!(tag(m.nodes[n as usize]).contains(&f), "node {n} listed on face {f}");
        }
        for (t, &f) in m.boundary.iter().zip(&m.boundary_face) {
            for &n in t {
                assert!(m.node_faces.binary_search(&(n, f)).is_ok(), "node {n} of a face {f} triangle not on it");
            }
        }
    }
}

#[test]
fn nothing_marked_gives_the_mesh_back() {
    let (m, s) = slanted_box([6, 2, 2], 0.2);
    let r = refine(&s, &m, &[], &opts(0, 0.0), &mut go).unwrap();
    assert_eq!(r.mesh, m);
    assert_eq!(r.split, 0);
    assert!((r.stats.volume - 40.0 * 13.0 * 9.0).abs() < 1e-9);
    assert_eq!(r.stats.size, 3.0);
}

#[test]
fn one_marked_tet_splits_its_longest_edge_and_propagates_only_when_a_neighbour_is_longer() {
    let (m, s) = slanted_box([6, 2, 2], 0.2);
    let terminal = |t: usize| ring(&m, longest(&m, t)).iter().all(|&o| longest(&m, o) == longest(&m, t));
    let quiet = (0..m.tets.len()).find(|&t| terminal(t)).expect("a tet on its own terminal edge");
    let r = refine(&s, &m, &[quiet as u32], &opts(0, 0.0), &mut go).unwrap();
    assert_eq!(r.split, 1);
    assert_eq!(r.mesh.tets.len(), m.tets.len() + ring(&m, longest(&m, quiet)).len());
    assert_eq!(r.mesh.nodes.len(), m.nodes.len() + 1);
    audit(&m, &r, &side);

    let chained = (0..m.tets.len()).find(|&t| !terminal(t)).expect("a tet whose neighbour has a longer edge");
    let r = refine(&s, &m, &[chained as u32], &opts(0, 0.0), &mut go).unwrap();
    assert!(r.split >= 2, "split {}", r.split);
    assert!(r.mesh.tets.len() > m.tets.len() + ring(&m, longest(&m, chained)).len());
    assert!(!r.mesh.tets.contains(&m.tets[chained]), "the marked tet was not split");
    audit(&m, &r, &side);
}

#[test]
fn many_marked_keep_every_invariant_and_run_bit_equal() {
    let (m, s) = slanted_box([8, 3, 2], 0.25);
    let marked: Vec<u32> = (0..m.tets.len() as u32).filter(|t| t % 3 == 1).collect();
    let r = refine(&s, &m, &marked, &opts(0, 0.0), &mut go).unwrap();
    assert!(r.mesh.tets.len() > m.tets.len() + marked.len());
    for &t in &marked {
        assert!(!r.mesh.tets.contains(&m.tets[t as usize]), "marked tet {t} left whole");
    }
    audit(&m, &r, &side);
    assert!(r.finest > 0.0 && r.finest < 40.0 / 8.0);
    assert!(r.stats.min_dihedral_deg > 0.0 && r.stats.max_dihedral_deg < 180.0);
    let again = refine(&s, &m, &marked, &opts(0, 0.0), &mut go).unwrap();
    assert!(r == again, "a second run gave different bits");
}

#[test]
fn the_tet_cap_is_exact() {
    let (m, s) = slanted_box([6, 2, 2], 0.2);
    let t = (0..m.tets.len())
        .find(|&t| ring(&m, longest(&m, t)).iter().all(|&o| longest(&m, o) == longest(&m, t)))
        .unwrap();
    let grown = m.tets.len() + ring(&m, longest(&m, t)).len();
    let r = refine(&s, &m, &[t as u32], &opts(grown, 0.0), &mut go).unwrap();
    assert_eq!((r.split, r.mesh.tets.len()), (1, grown));
    let r = refine(&s, &m, &[t as u32], &opts(grown - 1, 0.0), &mut go).unwrap();
    assert_eq!(r.split, 0);
    assert_eq!(r.mesh, m);
    let all: Vec<u32> = (0..m.tets.len() as u32).collect();
    let r = refine(&s, &m, &all, &opts(m.tets.len() + 40, 0.0), &mut go).unwrap();
    assert!(r.mesh.tets.len() <= m.tets.len() + 40 && r.split > 0);
}

#[test]
fn edges_under_the_shortest_split_are_kept() {
    let (m, s) = slanted_box([6, 2, 2], 0.2);
    let t = 5usize;
    let (a, b) = longest(&m, t);
    let len = dot(sub(m.nodes[a as usize], m.nodes[b as usize]), sub(m.nodes[a as usize], m.nodes[b as usize])).sqrt();
    let r = refine(&s, &m, &[t as u32], &opts(0, len * (1.0 + 1e-9)), &mut go).unwrap();
    assert_eq!(r.split, 0);
    let r = refine(&s, &m, &[t as u32], &opts(0, len * (1.0 - 1e-9)), &mut go).unwrap();
    assert!(r.split >= 1);
}

#[test]
fn a_refined_mesh_still_solves_a_patch_test_exactly() {
    let (m, s) = slanted_box([6, 2, 2], 0.2);
    let marked: Vec<u32> = (0..m.tets.len() as u32).filter(|t| t % 2 == 0).collect();
    let r = refine(&s, &m, &marked, &opts(0, 0.0), &mut go).unwrap();
    let axis = sub(place([1.0, 0.0, 0.0]), place([0.0; 3]));
    let force = 900.0;
    let p = Problem {
        mesh: &r.mesh,
        supports: vec![],
        body_force: None,
        material: Material { e: 3500.0, nu: 0.0 },
        fixed: vec![0],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force(axis.map(|v| v * force)) }],
    };
    let sol = solve(&p, &mut go).unwrap();
    let want = force / (13.0 * 9.0);
    let worst = sol
        .stress
        .iter()
        .map(|st| {
            let along = [0, 1, 2].map(|i| {
                let row = [[st[0], st[3], st[5]], [st[3], st[1], st[4]], [st[5], st[4], st[2]]][i];
                dot(row, axis)
            });
            (dot(along, axis) - want).abs() / want
        })
        .fold(0.0, f64::max);
    assert!(worst < 1e-8, "{worst}");
}

#[test]
fn a_cancel_stops_refinement() {
    let (m, s) = slanted_box([6, 2, 2], 0.2);
    assert_eq!(refine(&s, &m, &[3], &opts(0, 0.0), &mut || false), Err(MeshError::Cancelled));
}

/// The closest distance from `p` to the triangles of `face` in `s`.
fn distance_to_face(s: &SurfaceMesh, face: u32, p: V3) -> f64 {
    let mut best = f64::INFINITY;
    for (t, &f) in s.triangles.iter().zip(&s.face_ids) {
        if f != face {
            continue;
        }
        let [a, b, c] = t.map(|i| s.positions[i as usize]);
        let n = cross(sub(b, a), sub(c, a));
        let nn = dot(n, n).sqrt();
        let d = dot(sub(p, a), n) / nn;
        let q = sub(p, n.map(|v| v * d / nn));
        let inside = [(a, b), (b, c), (c, a)].iter().all(|&(u, v)| dot(cross(sub(v, u), sub(q, u)), n) >= -1e-9);
        if inside {
            best = best.min(d.abs());
        }
    }
    best
}

#[test]
fn boundary_midpoints_on_a_curved_face_move_onto_it_and_planar_ones_stay_on_their_plane() {
    let mut s = holed_plate(20.0, 6.0, 7.0, 48);
    for p in &mut s.positions {
        *p = place(*p);
    }
    let (m, _) = tetrahedralize(&s, &MeshOptions { size: 2.0, max_tets: 0 }, &mut go).unwrap();
    let on_hole: std::collections::HashSet<u32> =
        m.node_faces.iter().filter(|&&(_, f)| f == 6).map(|&(n, _)| n).collect();
    let near = |t: u32| {
        let c = m.tets[t as usize].iter().fold([0.0; 3], |s, &n| {
            let q = unplace(m.nodes[n as usize]);
            [s[0] + q[0] / 4.0, s[1] + q[1] / 4.0, s[2] + q[2] / 4.0]
        });
        c[0] * c[0] + c[1] * c[1] < 13.0 * 13.0
    };
    let hole: Vec<u32> = (0..m.tets.len() as u32)
        .filter(|&t| near(t) || m.tets[t as usize].iter().any(|n| on_hole.contains(n)))
        .collect();
    let r = refine(&s, &m, &hole, &RefineOptions { max_tets: 0, min_edge: 0.0, size: 2.0 }, &mut go).unwrap();
    assert!(r.split > 0);
    let listed: std::collections::HashSet<(u32, u32)> = r.mesh.node_faces.iter().copied().collect();
    let boundary: std::collections::HashSet<u32> = r.mesh.boundary.iter().flatten().copied().collect();
    let (mut wall, mut flat) = (0, 0);
    for n in m.nodes.len() as u32..r.mesh.nodes.len() as u32 {
        if !boundary.contains(&n) {
            continue;
        }
        let p = r.mesh.nodes[n as usize];
        let q = unplace(p);
        let radius = (q[0] * q[0] + q[1] * q[1]).sqrt();
        if q[2] > 2.0 && q[2] < 4.0 && radius < 7.5 {
            wall += 1;
            assert!(listed.contains(&(n, 6)), "new wall node {n} not on the hole");
            let d = distance_to_face(&s, 6, p);
            assert!(d < 1e-9, "new wall node {n} is {d} off the hole");
        } else if radius > 9.0 {
            flat += 1;
            assert!(q[2].abs() < 1e-9 || (q[2] - 6.0).abs() < 1e-9, "new flat node {n} off its plane: {q:?}");
        }
    }
    assert!(wall > 10 && flat > 10, "{wall} on the hole, {flat} on the flat faces");
    assert!(r.mesh.tets.iter().all(|&t| det(&r.mesh, t) > 0.0));
}

/// One thin tet over a box whose underside lies `gap` above the chord midpoint of the tet's longest edge, all
/// tagged face 0, so splitting that edge tries to lift the midpoint onto the box.
fn lifted(height: f64, gap: f64) -> V3 {
    let nodes = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [5.0, 8.0, 0.0], [5.0, 3.0, height]].map(place);
    let mut t = [0u32, 1, 2, 3];
    let mut m = TetMesh { nodes: nodes.to_vec(), tets: vec![t], ..TetMesh::default() };
    if det(&m, t) < 0.0 {
        t.swap(2, 3);
        m.tets = vec![t];
    }
    let [a, b, c, d] = t;
    m.boundary = vec![[a, c, b], [a, b, d], [a, d, c], [b, c, d]];
    m.boundary_face = vec![0; 4];
    let mut s = cuboid([100.0, 100.0, 50.0], &|p| place([p[0] - 45.0, p[1] - 50.0, p[2] + gap]));
    s.face_ids = vec![0; s.face_ids.len()];
    let r = refine(&s, &m, &[0], &opts(0, 0.0), &mut go).unwrap();
    assert_eq!(r.split, 1);
    assert!(r.mesh.tets.iter().all(|&t| det(&r.mesh, t) > 0.0));
    unplace(r.mesh.nodes[4])
}

fn close(a: V3, b: V3) -> bool {
    (0..3).all(|k| (a[k] - b[k]).abs() < 1e-9)
}

#[test]
fn a_midpoint_moves_onto_the_surface_only_within_a_quarter_edge_and_without_flattening_a_tet() {
    assert!(close(lifted(6.0, 2.49), [5.0, 0.0, 2.49]));
    assert!(close(lifted(6.0, 2.5), [5.0, 0.0, 0.0]), "a quarter of the edge is too far");
    assert!(close(lifted(0.6, 1.5), [5.0, 0.0, 0.0]), "the lift would flatten the thin tet");
    assert!(close(lifted(6.0, 1.5), [5.0, 0.0, 1.5]));
}
