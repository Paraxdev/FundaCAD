use fundacad_geom::fem::tetmesh::*;
use fundacad_geom::fem::{MeshOptions, MeshStats, SurfaceMesh, TetMesh};
use std::time::Instant;

/// Builds closed test surfaces; each triangle is wound so its normal agrees with the
/// outward hint it is given.
#[derive(Default)]
struct Shape {
    pos: Vec<V3>,
    tris: Vec<[u32; 3]>,
    ids: Vec<u32>,
}

impl Shape {
    fn vertex(&mut self, p: V3) -> u32 {
        self.pos.push(p);
        (self.pos.len() - 1) as u32
    }

    fn tri(&mut self, t: [u32; 3], id: u32, outward: V3) {
        let p = t.map(|i| self.pos[i as usize]);
        let n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
        self.tris.push(if dot(n, outward) < 0.0 { [t[0], t[2], t[1]] } else { t });
        self.ids.push(id);
    }

    fn quad(&mut self, q: [u32; 4], id: u32, outward: V3) {
        self.tri([q[0], q[1], q[2]], id, outward);
        self.tri([q[0], q[2], q[3]], id, outward);
    }

    fn centroid(&self, q: &[u32]) -> V3 {
        let s = q.iter().fold([0.0; 3], |s, &i| add(s, self.pos[i as usize]));
        scale(s, 1.0 / q.len() as f64)
    }

    fn mesh(self) -> SurfaceMesh {
        SurfaceMesh { positions: self.pos, triangles: self.tris, face_ids: self.ids }
    }
}

pub(crate) fn rotate(p: V3, ax: f64, ay: f64, az: f64) -> V3 {
    let (s, c) = ax.sin_cos();
    let p = [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
    let (s, c) = ay.sin_cos();
    let p = [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
    let (s, c) = az.sin_cos();
    [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]
}

/// A box `size` with corner at the origin, then `place`d; face ids 2a + side (0 for
/// minus x, 1 for plus x, ...), two triangles per face.
pub(crate) fn cuboid(size: V3, place: &dyn Fn(V3) -> V3) -> SurfaceMesh {
    let mut s = Shape::default();
    for i in 0..8 {
        let p = [0, 1, 2].map(|a| if (i >> a) & 1 == 1 { size[a] } else { 0.0 });
        s.vertex(place(p));
    }
    let centre = s.centroid(&[0, 1, 2, 3, 4, 5, 6, 7]);
    for a in 0..3 {
        let (b, c) = ((a + 1) % 3, (a + 2) % 3);
        for side in 0..2u32 {
            let q = [[0, 0], [1, 0], [1, 1], [0, 1]].map(|[x, y]| ((side as usize) << a | x << b | y << c) as u32);
            let out = sub(s.centroid(&q), centre);
            s.quad(q, 2 * a as u32 + side, out);
        }
    }
    s.mesh()
}

/// Latitude and longitude sphere; face id 0 above the equator, 1 below.
fn sphere(centre: V3, r: f64, nu: usize, nv: usize) -> SurfaceMesh {
    let mut s = Shape::default();
    let north = s.vertex(add(centre, [0.0, 0.0, r]));
    let mut rings = Vec::new();
    for j in 1..nv {
        let th = std::f64::consts::PI * j as f64 / nv as f64;
        let ring: Vec<u32> = (0..nu)
            .map(|i| {
                let ph = 2.0 * std::f64::consts::PI * i as f64 / nu as f64;
                s.vertex(add(centre, [r * th.sin() * ph.cos(), r * th.sin() * ph.sin(), r * th.cos()]))
            })
            .collect();
        rings.push(ring);
    }
    let south = s.vertex(add(centre, [0.0, 0.0, -r]));
    for i in 0..nu {
        let i1 = (i + 1) % nu;
        let t = [north, rings[0][i], rings[0][i1]];
        let out = sub(s.centroid(&t), centre);
        s.tri(t, 0, out);
        let last = &rings[nv - 2];
        let t = [south, last[i], last[i1]];
        let out = sub(s.centroid(&t), centre);
        s.tri(t, 1, out);
        for j in 0..nv - 2 {
            let q = [rings[j][i], rings[j][i1], rings[j + 1][i1], rings[j + 1][i]];
            let out = sub(s.centroid(&q), centre);
            s.quad(q, if 2 * (j + 1) < nv { 0 } else { 1 }, out);
        }
    }
    s.mesh()
}

/// Torus around z with major radius `big` and tube radius `small`, face id 0.
fn torus(big: f64, small: f64, nu: usize, nv: usize) -> SurfaceMesh {
    let mut s = Shape::default();
    let tau = 2.0 * std::f64::consts::PI;
    let mut grid = vec![vec![0u32; nv]; nu];
    for (i, row) in grid.iter_mut().enumerate() {
        let u = tau * i as f64 / nu as f64;
        for (j, g) in row.iter_mut().enumerate() {
            let v = tau * j as f64 / nv as f64;
            let w = big + small * v.cos();
            *g = s.vertex([w * u.cos(), w * u.sin(), small * v.sin()]);
        }
    }
    for i in 0..nu {
        for j in 0..nv {
            let (i1, j1) = ((i + 1) % nu, (j + 1) % nv);
            let q = [grid[i][j], grid[i1][j], grid[i1][j1], grid[i][j1]];
            let c = s.centroid(&q);
            let r = (c[0] * c[0] + c[1] * c[1]).sqrt();
            let core = [big * c[0] / r, big * c[1] / r, 0.0];
            s.quad(q, 0, sub(c, core));
        }
    }
    s.mesh()
}

/// Square plate `2 half` wide and `thick` high with a round hole of radius `r` through it
/// along z. Face ids: 0 top, 1 bottom, 2 to 5 the sides, 6 the hole.
pub(crate) fn holed_plate(half: f64, thick: f64, r: f64, segments: usize) -> SurfaceMesh {
    assert_eq!(segments % 8, 0, "the square corners must be on the sampled angles");
    let mut s = Shape::default();
    let tau = 2.0 * std::f64::consts::PI;
    let ring = |s: &mut Shape, z: f64| {
        let mut hole = Vec::new();
        let mut outer = Vec::new();
        for k in 0..segments {
            let a = tau * k as f64 / segments as f64;
            let (sn, cs) = a.sin_cos();
            hole.push(s.vertex([r * cs, r * sn, z]));
            let m = cs.abs().max(sn.abs());
            outer.push(s.vertex([half * cs / m, half * sn / m, z]));
        }
        (hole, outer)
    };
    let (hb, ob) = ring(&mut s, 0.0);
    let (ht, ot) = ring(&mut s, thick);
    for k in 0..segments {
        let k1 = (k + 1) % segments;
        s.quad([ht[k], ot[k], ot[k1], ht[k1]], 0, [0.0, 0.0, 1.0]);
        s.quad([hb[k], ob[k], ob[k1], hb[k1]], 1, [0.0, 0.0, -1.0]);
        let q = [ob[k], ob[k1], ot[k1], ot[k]];
        let c = s.centroid(&q);
        let side = if c[0].abs() > c[1].abs() {
            if c[0] < 0.0 {
                2
            } else {
                3
            }
        } else if c[1] < 0.0 {
            4
        } else {
            5
        };
        s.quad(q, side, [c[0], c[1], 0.0]);
        let q = [hb[k], hb[k1], ht[k1], ht[k]];
        let c = s.centroid(&q);
        s.quad(q, 6, [-c[0], -c[1], 0.0]);
    }
    s.mesh()
}

/// Both surfaces as one mesh.
fn join(a: &SurfaceMesh, b: &SurfaceMesh) -> SurfaceMesh {
    let mut m = a.clone();
    let off = m.positions.len() as u32;
    m.positions.extend_from_slice(&b.positions);
    m.triangles.extend(b.triangles.iter().map(|t| t.map(|i| i + off)));
    m.face_ids.extend_from_slice(&b.face_ids);
    m
}

fn surface_volume(m: &SurfaceMesh) -> f64 {
    m.triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|i| m.positions[i as usize]);
            dot(a, cross(b, c)) / 6.0
        })
        .sum()
}

fn mesh(surface: &SurfaceMesh, size: f64) -> (TetMesh, MeshStats) {
    tetrahedralize(surface, &MeshOptions { size, max_tets: 0 }, &mut || true).expect("meshes")
}

/// Checks the mesh invariants: positive tetrahedra, every node used, conforming, `pieces`
/// face-connected pieces, a closed and consistently wound boundary enclosing the elements.
fn audit(m: &TetMesh, stats: &MeshStats, pieces: usize) -> Result<(), String> {
    let mut used = vec![false; m.nodes.len()];
    for t in &m.tets {
        let p = t.map(|i| m.nodes[i as usize]);
        if orient(&p) <= 0.0 {
            return Err(format!("tetrahedron {t:?} is not positively oriented"));
        }
        for &i in t {
            used[i as usize] = true;
        }
    }
    if !used.iter().all(|&u| u) {
        return Err("unused nodes".into());
    }

    // Conforming: no face is shared by more than two tetrahedra. Tetrahedra sharing a
    // face are one piece.
    let mut faces: Vec<([u32; 3], usize)> = Vec::new();
    for (k, &[a, b, c, d]) in m.tets.iter().enumerate() {
        for mut f in [[a, b, c], [a, b, d], [a, c, d], [b, c, d]] {
            f.sort_unstable();
            faces.push((f, k));
        }
    }
    faces.sort_unstable();
    let mut root: Vec<usize> = (0..m.tets.len()).collect();
    fn find(root: &mut [usize], mut x: usize) -> usize {
        while root[x] != x {
            x = root[x];
        }
        x
    }
    for w in faces.windows(3) {
        if w[0].0 == w[2].0 {
            return Err(format!("face {:?} shared by more than two tetrahedra", w[0].0));
        }
    }
    for w in faces.windows(2) {
        if w[0].0 == w[1].0 {
            let (x, y) = (find(&mut root, w[0].1), find(&mut root, w[1].1));
            root[x.max(y)] = x.min(y);
        }
    }
    let found = (0..m.tets.len()).filter(|&k| find(&mut root, k) == k).count();
    if found != pieces {
        return Err(format!("{found} pieces, expected {pieces}"));
    }

    // The boundary is closed and consistently wound: each directed edge appears once and
    // its reverse once.
    if m.boundary.len() != m.boundary_face.len() {
        return Err("boundary faces and their ids differ in number".into());
    }
    let mut directed: Vec<(u32, u32)> = Vec::new();
    for f in &m.boundary {
        for e in 0..3 {
            directed.push((f[e], f[(e + 1) % 3]));
        }
    }
    directed.sort_unstable();
    for w in directed.windows(2) {
        if w[0] == w[1] {
            return Err(format!("boundary edge {:?} used twice in one direction", w[0]));
        }
    }
    for &(a, b) in &directed {
        if directed.binary_search(&(b, a)).is_err() {
            return Err(format!("boundary edge ({a}, {b}) is open"));
        }
    }
    let enclosed: f64 = m
        .boundary
        .iter()
        .map(|f| {
            let [a, b, c] = f.map(|i| m.nodes[i as usize]);
            dot(a, cross(b, c)) / 6.0
        })
        .sum();
    if (enclosed - stats.volume).abs() > 1e-9 * stats.volume {
        return Err(format!("boundary encloses {enclosed}, tetrahedra fill {}", stats.volume));
    }
    Ok(())
}

/// Meshes one solid, checks the mesh invariants and quality, and returns the relative
/// volume error against the surface.
fn check(name: &str, surface: &SurfaceMesh, size: f64) -> (TetMesh, MeshStats, f64) {
    let start = Instant::now();
    let (m, stats) = mesh(surface, size);
    let took = start.elapsed();
    if let Err(e) = audit(&m, &stats, 1) {
        panic!("{name}: {e}");
    }

    let reference = surface_volume(surface);
    let err = (stats.volume - reference) / reference;
    eprintln!(
        "{name:>22}: {:>7} tets {:>6} nodes, size {:.3}, dihedral {:6.2} to {:6.2} deg, volume error {:+.3}%, {:.0} ms",
        m.tets.len(),
        m.nodes.len(),
        stats.size,
        stats.min_dihedral_deg,
        stats.max_dihedral_deg,
        100.0 * err,
        took.as_secs_f64() * 1e3
    );
    assert!(stats.min_dihedral_deg > 9.0, "{name}: min dihedral {}", stats.min_dihedral_deg);
    assert!(stats.max_dihedral_deg < 166.0, "{name}: max dihedral {}", stats.max_dihedral_deg);
    (m, stats, err)
}

#[test]
fn boundary_nodes_know_every_face_they_lie_on() {
    // A box off the lattice, so its edges are rounded over by triangles that span two
    // faces. Face 2a + side lies in the plane where coordinate a is `plane(f)`.
    let (size, off) = ([10.0, 6.0, 4.0], [0.37, 0.21, 0.13]);
    let (m, _) = mesh(&cuboid(size, &|p| add(p, off)), 1.3);
    let plane = |f: u32| {
        let a = (f / 2) as usize;
        (a, off[a] + if f % 2 == 1 { size[a] } else { 0.0 })
    };
    let on = |n: u32, f: u32| {
        let (a, c) = plane(f);
        (m.nodes[n as usize][a] - c).abs() < 1e-9
    };
    let mut boundary: Vec<u32> = m.boundary.iter().flatten().copied().collect();
    boundary.sort_unstable();
    boundary.dedup();
    let mut listed: Vec<u32> = m.node_faces.iter().map(|e| e.0).collect();
    listed.dedup();
    assert_eq!(listed, boundary);
    assert!(m.node_faces.windows(2).all(|w| w[0] < w[1]));
    for &(n, f) in &m.node_faces {
        assert!(on(n, f), "node {n} at {:?} is off face {f}", m.nodes[n as usize]);
    }
    let mut edges = 0;
    for &n in &boundary {
        let faces: Vec<u32> = (0..6).filter(|&f| on(n, f)).collect();
        for &f in &faces {
            assert!(m.node_faces.binary_search(&(n, f)).is_ok(), "node {n} on {f}");
        }
        edges += usize::from(faces.len() > 1);
    }
    // Tags alone would put nodes on faces they are off, the corners of the triangles
    // that round the edges over.
    let off_tag = m.boundary.iter().zip(&m.boundary_face).filter(|(t, &f)| t.iter().any(|&n| !on(n, f))).count();
    eprintln!("{edges} nodes on an edge, {off_tag} triangles with a corner off their face");
    assert!(edges > 0 && off_tag > 0);
}

#[test]
fn aligned_cube_is_exact() {
    let cube = cuboid([10.0; 3], &|p| p);
    let (m, _, err) = check("aligned cube", &cube, 1.0);
    assert!(err.abs() < 1e-9, "volume error {err}");
    // Lattice-aligned faces cut the boundary tetrahedra exactly in half.
    assert_eq!(m.tets.len(), 13200);
}

#[test]
fn cube_volume_closed_boundary_and_quality() {
    let cube = cuboid([10.0; 3], &|p| add(rotate(p, 0.3, 0.5, 0.7), [0.37, -1.21, 2.05]));
    let (_, _, err) = check("rotated cube", &cube, 0.5);
    assert!(err.abs() < 0.01, "volume error {err}");
    let cube = cuboid([10.0; 3], &|p| add(p, [0.37, 0.0, 0.0]));
    let (_, _, err) = check("shifted cube", &cube, 0.7);
    assert!(err.abs() < 0.01, "volume error {err}");
}

#[test]
fn face_ids_follow_face_area() {
    let size = [10.0, 14.0, 18.0];
    let body = cuboid(size, &|p| rotate(p, 0.2, -0.4, 0.9));
    let (m, _, _) = check("tagged box", &body, 0.8);
    let mut area = [0.0; 6];
    for (f, &id) in m.boundary.iter().zip(&m.boundary_face) {
        let [a, b, c] = f.map(|i| m.nodes[i as usize]);
        area[id as usize] += 0.5 * norm(cross(sub(b, a), sub(c, a)));
    }
    let total: f64 = area.iter().sum();
    for id in 0..6 {
        let a = id / 2;
        let exact = size[(a + 1) % 3] * size[(a + 2) % 3];
        let exact_total = 2.0 * (size[0] * size[1] + size[1] * size[2] + size[2] * size[0]);
        let (got, want) = (area[id] / total, exact / exact_total);
        assert!(((got - want) / want).abs() < 0.04, "face {id}: fraction {got:.4}, area says {want:.4}");
    }
}

#[test]
fn sphere_volume() {
    let s = sphere([0.31, -0.17, 0.05], 10.0, 128, 64);
    let (_, _, err) = check("sphere", &s, 0.8);
    assert!(err.abs() < 0.02, "volume error {err}");
}

#[test]
fn torus_volume() {
    let t = torus(10.0, 4.0, 128, 48);
    let (_, _, err) = check("torus", &t, 0.6);
    assert!(err.abs() < 0.03, "volume error {err}");
}

#[test]
fn thin_plate_two_elements_thick() {
    let thick = 2.0;
    let plate = cuboid([30.0, 20.0, thick], &|p| rotate(p, 0.11, -0.07, 0.4));
    let (m, _, err) = check("plate 2 elements thick", &plate, thick / 2.0);
    assert!(err.abs() < 0.03, "volume error {err}");
    // Every element sits inside the plate's thickness.
    let normal = rotate([0.0, 0.0, 1.0], 0.11, -0.07, 0.4);
    for p in &m.nodes {
        let z = dot(*p, normal);
        assert!(z > -1e-6 && z < thick + 1e-6, "node at height {z}");
    }
}

#[test]
fn body_with_a_through_hole() {
    let body = holed_plate(10.0, 6.0, 4.0, 64);
    let (m, _, err) = check("plate with a hole", &body, 0.7);
    assert!(err.abs() < 0.03, "volume error {err}");
    // The boundary is one surface of genus 1: V - E + F = 0.
    let mut verts: Vec<u32> = m.boundary.iter().flatten().copied().collect();
    verts.sort_unstable();
    verts.dedup();
    let edges = m.boundary.len() * 3 / 2;
    assert_eq!(verts.len() as i64 - edges as i64 + m.boundary.len() as i64, 0);
    // Nothing fills the hole, and its wall is tagged.
    for t in &m.tets {
        let c = scale(t.iter().fold([0.0; 3], |s, &i| add(s, m.nodes[i as usize])), 0.25);
        assert!(c[0].hypot(c[1]) > 4.0 - 0.7, "element inside the hole at {c:?}");
    }
    let mut ids: Vec<u32> = m.boundary_face.clone();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids, vec![0, 1, 2, 3, 4, 5, 6]);
}

#[test]
fn deterministic() {
    let s = torus(6.0, 2.5, 64, 24);
    let a = mesh(&s, 0.5);
    let b = mesh(&s, 0.5);
    assert!(a == b);
}

#[test]
fn max_tets_coarsens_the_mesh() {
    let s = sphere([0.0; 3], 10.0, 64, 32);
    let (m, stats) = tetrahedralize(&s, &MeshOptions { size: 0.3, max_tets: 20_000 }, &mut || true).unwrap();
    assert!(m.tets.len() <= 20_000, "{} tets", m.tets.len());
    assert!(m.tets.len() > 10_000, "{} tets", m.tets.len());
    assert!(stats.size > 0.3);
}

#[test]
fn errors_read_well() {
    let cube = cuboid([10.0; 3], &|p| p);
    let opts = MeshOptions { size: 1.0, max_tets: 0 };

    let mut open = cube.clone();
    open.triangles.pop();
    open.face_ids.pop();
    let e = tetrahedralize(&open, &opts, &mut || true).unwrap_err();
    assert_eq!(e, MeshError::OpenSurface { open_edges: 3 });
    assert!(e.to_string().starts_with("the surface is open"));

    let mut flipped = cube.clone();
    for t in &mut flipped.triangles {
        t.swap(1, 2);
    }
    assert_eq!(tetrahedralize(&flipped, &opts, &mut || true).unwrap_err(), MeshError::InsideOut);

    let tiny = cuboid([0.2; 3], &|p| add(p, [0.3, 0.3, 0.3]));
    let e = tetrahedralize(&tiny, &MeshOptions { size: 2.0, max_tets: 0 }, &mut || true).unwrap_err();
    assert_eq!(e, MeshError::TooSmall { size: 2.0, coarsening: Coarsening::None });
    assert_eq!(
        e.to_string(),
        "the part is thinner than one element of 2.000 mm, so no element fits inside it, use a smaller element size"
    );

    assert_eq!(
        tetrahedralize(&cube, &MeshOptions { size: 0.0, max_tets: 0 }, &mut || true).unwrap_err(),
        MeshError::InvalidSize(0.0)
    );
    let mut short = cube.clone();
    short.face_ids.pop();
    assert!(matches!(tetrahedralize(&short, &opts, &mut || true), Err(MeshError::FaceIdCount { .. })));
    assert_eq!(tetrahedralize(&SurfaceMesh::default(), &opts, &mut || true).unwrap_err(), MeshError::EmptySurface);

    // Cancelling partway through, and the progress callback is called often.
    let mut calls = 0;
    let e = tetrahedralize(&cube, &MeshOptions { size: 0.25, max_tets: 0 }, &mut || {
        calls += 1;
        calls < 20
    })
    .unwrap_err();
    assert_eq!(e, MeshError::Cancelled);
    assert_eq!(e.to_string(), "meshing was cancelled");
    let mut calls = 0;
    tetrahedralize(&cube, &opts, &mut || {
        calls += 1;
        true
    })
    .unwrap();
    assert!(calls > 20, "{calls} progress calls");
}

#[test]
fn fifty_thousand_tets_timing() {
    // Debug builds are far slower; the timing target is for release.
    let (r, size, surface_res) = if cfg!(debug_assertions) { (10.0, 1.6, (128, 64)) } else { (10.0, 1.0, (384, 192)) };
    let s = sphere([0.0; 3], r, surface_res.0, surface_res.1);
    let start = Instant::now();
    let (m, stats) = mesh(&s, size);
    let took = start.elapsed();
    eprintln!(
        "timing: {} tets from {} surface triangles in {:.0} ms (min dihedral {:.2})",
        m.tets.len(),
        s.triangles.len(),
        took.as_secs_f64() * 1e3,
        stats.min_dihedral_deg
    );
    if !cfg!(debug_assertions) {
        assert!(m.tets.len() >= 50_000, "{} tets", m.tets.len());
    }
}

#[test]
fn hollow_body_is_one_piece() {
    let outer = sphere([0.1, 0.2, 0.3], 5.0, 64, 32);
    let mut inner = sphere([0.1, 0.2, 0.3], 3.0, 64, 32);
    for t in &mut inner.triangles {
        t.swap(1, 2);
    }
    let s = join(&outer, &inner);
    let (m, stats) = mesh(&s, 0.5);
    audit(&m, &stats, 1).unwrap();
    let reference = surface_volume(&s);
    assert!(((stats.volume - reference) / reference).abs() < 0.02);
}

#[test]
fn coarsening_errors_ask_for_more_elements() {
    // The element limit, not the size asked for, makes the elements too large.
    let cube = cuboid([10.0; 3], &|p| p);
    let e = tetrahedralize(&cube, &MeshOptions { size: 1.0, max_tets: 1 }, &mut || true).unwrap_err();
    assert!(matches!(e, MeshError::TooSmall { coarsening: Coarsening::ElementLimit { max_tets: 1 }, .. }), "{e:?}");
    let text = e.to_string();
    assert!(
        text.ends_with("the limit of 1 elements forces elements this large, allow more elements")
            && !text.contains("smaller"),
        "{text}"
    );

    // A large thin plate at the default limit grows the size past its thickness.
    let plate = cuboid([100.0, 100.0, 1.0], &|p| rotate(p, 0.01, 0.02, 0.3));
    let e = tetrahedralize(&plate, &MeshOptions { size: 0.5, max_tets: 60_000 }, &mut || true).unwrap_err();
    let MeshError::TooThin { size, coarsening } = e else {
        panic!("{e:?}");
    };
    assert!(size > 1.0, "{size}");
    assert_eq!(coarsening, Coarsening::ElementLimit { max_tets: 60_000 });
    assert!(e.to_string().ends_with("the limit of 60000 elements forces elements this large, allow more elements"));
}

type V3 = [f64; 3];

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

/// Six times the signed volume of tetrahedron `p`.
fn orient(p: &[V3; 4]) -> f64 {
    dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), sub(p[3], p[0]))
}
