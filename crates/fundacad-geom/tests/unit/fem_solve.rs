use fundacad_geom::fem::solve::*;
use fundacad_geom::fem::TetMesh;

/// A box [0, size] of n cells per axis, six tetrahedra per cell, boundary triangles tagged 0 to 5 for -x, +x, -y,
/// +y, -z, +z. `jitter` moves interior nodes by up to that fraction of a cell, deterministically.
pub(crate) fn box_mesh(size: V3, n: [usize; 3], jitter: f64) -> TetMesh {
    let id = |i: usize, j: usize, k: usize| (i + (n[0] + 1) * (j + (n[1] + 1) * k)) as u32;
    let h = [0, 1, 2].map(|a| size[a] / n[a] as f64);
    let mut nodes = Vec::new();
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut rand = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
    };
    for k in 0..=n[2] {
        for j in 0..=n[1] {
            for i in 0..=n[0] {
                let ijk = [i, j, k];
                let inside = (0..3).all(|a| ijk[a] > 0 && ijk[a] < n[a]);
                nodes.push([0, 1, 2].map(|a| {
                    let d = if inside { jitter * h[a] * rand() } else { 0.0 };
                    ijk[a] as f64 * h[a] + d
                }));
            }
        }
    }
    let perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let mut tets = Vec::new();
    for k in 0..n[2] {
        for j in 0..n[1] {
            for i in 0..n[0] {
                for p in perms {
                    let mut c = [i, j, k];
                    let mut t = [id(c[0], c[1], c[2]); 4];
                    for s in 0..3 {
                        c[p[s]] += 1;
                        t[s + 1] = id(c[0], c[1], c[2]);
                    }
                    let x = t.map(|v| nodes[v as usize]);
                    if dot(sub(x[1], x[0]), cross(sub(x[2], x[0]), sub(x[3], x[0]))) < 0.0 {
                        t.swap(2, 3);
                    }
                    tets.push(t);
                }
            }
        }
    }
    let (boundary, boundary_face) = boundary_of(&nodes, &tets, |c| {
        (0..6)
            .find(|&f| {
                let (a, hi) = (f / 2, f % 2 == 1);
                let target = if hi { size[a] } else { 0.0 };
                (c[a] - target).abs() < 1e-9 * size[a]
            })
            .expect("boundary triangle on a box side") as u32
    });
    TetMesh { nodes, tets, boundary, boundary_face, node_faces: Vec::new() }
}

/// The faces used by one element only, wound outward, and the face id `tag` gives the
/// centroid of each.
fn boundary_of(nodes: &[V3], tets: &[[u32; 4]], tag: impl Fn(V3) -> u32) -> (Vec<[u32; 3]>, Vec<u32>) {
    let mut faces: Vec<([u32; 3], [u32; 3], u32)> = Vec::new();
    for t in tets {
        for skip in 0..4 {
            let f: Vec<u32> = (0..4).filter(|&i| i != skip).map(|i| t[i]).collect();
            let mut key = [f[0], f[1], f[2]];
            key.sort_unstable();
            faces.push((key, [f[0], f[1], f[2]], t[skip]));
        }
    }
    faces.sort_unstable();
    let mut out = Vec::new();
    let mut ids = Vec::new();
    let mut i = 0;
    while i < faces.len() {
        let mut j = i + 1;
        while j < faces.len() && faces[j].0 == faces[i].0 {
            j += 1;
        }
        if j - i == 1 {
            let (_, mut f, opp) = faces[i];
            let [a, b, c] = f.map(|v| nodes[v as usize]);
            if dot(cross(sub(b, a), sub(c, a)), sub(nodes[opp as usize], a)) > 0.0 {
                f.swap(1, 2);
            }
            let centroid = [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0);
            out.push(f);
            ids.push(tag(centroid));
        }
        i = j;
    }
    (out, ids)
}

fn go() -> bool {
    true
}

const STEEL: Material = Material { e: 210_000.0, nu: 0.3 };

fn balance(s: &Solution) -> f64 {
    let r = norm([0, 1, 2].map(|k| s.applied[k] + s.reaction[k]));
    r / norm(s.applied).max(1e-300)
}

/// The corner and mid-edge nodes of the boundary triangles tagged `face`.
fn face_nodes(m: &TetMesh, s: &Solution, face: u32) -> Vec<u32> {
    let mut v = Vec::new();
    for (t, &f) in m.boundary.iter().zip(&m.boundary_face) {
        if f == face {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                v.push(a);
                let e = [a.min(b), a.max(b)];
                v.push((s.corners + s.edges.binary_search(&e).unwrap()) as u32);
            }
        }
    }
    v.sort_unstable();
    v.dedup();
    v
}

fn bar(nu: f64, len: f64, n: [usize; 3]) -> (TetMesh, Solution, f64) {
    let m = box_mesh([len, 10.0, 10.0], n, 0.0);
    let force = 1000.0;
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: None,
        material: Material { e: 210_000.0, nu },
        fixed: vec![0],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force([force, 0.0, 0.0]) }],
    };
    let s = solve(&p, &mut go).unwrap();
    (m, s, force)
}

#[test]
fn bar_without_poisson_is_exact() {
    // With nu = 0 the clamp does not disturb uniaxial tension, so the field is linear.
    let (m, s, force) = bar(0.0, 100.0, [10, 2, 2]);
    let area = 100.0;
    let tip = force * 100.0 / (210_000.0 * area);
    let mut err: f64 = 0.0;
    for (n, x) in s.nodes.iter().enumerate() {
        err = err.max((s.displacement[n][0] - tip * x[0] / 100.0).abs() / tip);
        err = err.max(s.displacement[n][1].abs().max(s.displacement[n][2].abs()) / tip);
        err = err.max((s.stress[n][0] - force / area).abs() / (force / area));
    }
    eprintln!("bar nu=0: max relative error {err:.3e}, balance {:.3e}", balance(&s));
    assert!(err < 1e-9, "{err}");
    assert!(balance(&s) < 1e-9);
    assert_eq!(s.elements, m.tets.len());
}

#[test]
fn bar_in_tension() {
    let (len, area, e) = (100.0, 100.0, 210_000.0);
    let (m, s, force) = bar(0.3, len, [20, 4, 4]);
    let end = face_nodes(&m, &s, 1);
    let ux = end.iter().map(|&n| s.displacement[n as usize][0]).sum::<f64>() / end.len() as f64;
    let want_u = force * len / (e * area);
    let mid: Vec<usize> = (0..s.nodes.len()).filter(|&n| (s.nodes[n][0] - len / 2.0).abs() < 1e-9).collect();
    let sxx = mid.iter().map(|&n| s.stress[n][0]).sum::<f64>() / mid.len() as f64;
    let want_s = force / area;
    let (eu, es) = ((ux - want_u) / want_u, (sxx - want_s) / want_s);
    eprintln!(
        "bar: end ux {ux:.6e} vs FL/EA {want_u:.6e} ({:+.3}%), mid sigma {sxx:.5} vs F/A {want_s} ({:+.3}%), balance {:.2e}",
        eu * 100.0,
        es * 100.0,
        balance(&s)
    );
    assert!(eu.abs() < 0.005);
    assert!(es.abs() < 0.005);
    assert!(balance(&s) < 1e-6);
}

struct Cantilever {
    tip: f64,
    sigma_top: f64,
    s: Solution,
}

fn cantilever(n: [usize; 3]) -> Cantilever {
    let m = box_mesh([100.0, 10.0, 10.0], n, 0.0);
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: None,
        material: STEEL,
        fixed: vec![0],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force([0.0, 0.0, -100.0]) }],
    };
    let s = solve(&p, &mut go).unwrap();
    let end = face_nodes(&m, &s, 1);
    let tip = -end.iter().map(|&n| s.displacement[n as usize][2]).sum::<f64>() / end.len() as f64;
    let top: Vec<usize> = (0..s.nodes.len())
        .filter(|&n| (s.nodes[n][0] - 50.0).abs() < 1e-9 && (s.nodes[n][2] - 10.0).abs() < 1e-9)
        .collect();
    assert!(!top.is_empty());
    let sigma_top = top.iter().map(|&n| s.stress[n][0]).sum::<f64>() / top.len() as f64;
    Cantilever { tip, sigma_top, s }
}

#[test]
fn cantilever_matches_timoshenko_and_is_deterministic() {
    let (p, l, b, h) = (100.0, 100.0, 10.0, 10.0);
    let i = b * h * h * h / 12.0;
    let g = STEEL.e / (2.0 * (1.0 + STEEL.nu));
    let want = p * l * l * l / (3.0 * STEEL.e * i) + p * l / (5.0 / 6.0 * g * b * h);
    let want_s = p * (l / 2.0) * (h / 2.0) / i;
    let t0 = std::time::Instant::now();
    let c = cantilever([40, 4, 4]);
    let took = t0.elapsed();
    let (ed, es) = ((c.tip - want) / want, (c.sigma_top - want_s) / want_s);
    eprintln!(
        "cantilever ({} tets, {} dofs, {:.2?}): tip {:.6} vs Timoshenko {want:.6} mm ({:+.3}%), mid-span top sigma_xx {:.4} vs Mc/I {want_s} MPa ({:+.3}%), peak vm {:.3} MPa, balance {:.2e}, energy {:.6} vs P delta / 2 {:.6}",
        c.s.elements,
        c.s.dofs,
        took,
        c.tip,
        ed * 100.0,
        c.sigma_top,
        es * 100.0,
        c.s.max_von_mises,
        balance(&c.s),
        c.s.strain_energy,
        0.5 * p * c.tip
    );
    assert!(ed.abs() < 0.03);
    assert!(es.abs() < 0.03);
    assert!(balance(&c.s) < 1e-6);
    let again = cantilever([40, 4, 4]);
    assert!(c.s == again.s, "a second run gave different bits");
}

#[test]
fn pressure_equals_force() {
    let m = box_mesh([30.0, 10.0, 10.0], [6, 2, 2], 0.1);
    let solve_with_load = |kind| {
        let p = Problem {
            mesh: &m,
            supports: vec![],
            body_force: None,
            material: STEEL,
            fixed: vec![0],
            loads: vec![Load { faces: vec![1], kind }],
        };
        solve(&p, &mut go).unwrap()
    };
    // 2 MPa into the +x face of 100 mm^2 is 200 N along -x.
    let a = solve_with_load(LoadKind::Pressure(2.0));
    let b = solve_with_load(LoadKind::Force([-200.0, 0.0, 0.0]));
    let scale = a.max_displacement;
    let err = a.displacement.iter().zip(&b.displacement).map(|(u, v)| norm(sub(*u, *v))).fold(0.0, f64::max) / scale;
    eprintln!("pressure vs force: max difference {err:.3e} relative, applied {:?}", a.applied);
    assert!(err < 1e-10);
    assert!(norm(sub(a.applied, [-200.0, 0.0, 0.0])) < 1e-9);
    assert!(balance(&a) < 1e-6 && balance(&b) < 1e-6);
}

#[test]
fn reactions_balance_combined_loads() {
    let m = box_mesh([40.0, 10.0, 6.0], [8, 2, 2], 0.15);
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: None,
        material: Material { e: 2200.0, nu: 0.35 },
        fixed: vec![0, 4],
        loads: vec![
            Load { faces: vec![1], kind: LoadKind::Force([3.0, -20.0, 7.0]) },
            Load { faces: vec![5, 3], kind: LoadKind::Pressure(0.4) },
            Load { faces: vec![2], kind: LoadKind::Force([0.0, 0.0, -5.0]) },
        ],
    };
    let s = solve(&p, &mut go).unwrap();
    // The pressure pushes along -z over the 400 mm^2 of +z and along -y over the 240 of +y.
    let want = [3.0, -20.0 - 0.4 * 240.0, 7.0 - 0.4 * 400.0 - 5.0];
    eprintln!("combined: applied {:?} reaction {:?} balance {:.2e}", s.applied, s.reaction, balance(&s));
    assert!(norm(sub(s.applied, want)) < 1e-9 * norm(want));
    assert!(balance(&s) < 1e-6);
    assert!(s.strain_energy > 0.0);
    assert!(s.missing_fixed.is_empty());
}

/// Two meshes side by side, the second's face ids moved up by 6.
fn join(a: &TetMesh, b: &TetMesh, shift: V3) -> TetMesh {
    let mut m = a.clone();
    let base = a.nodes.len() as u32;
    m.nodes.extend(b.nodes.iter().map(|p| [0, 1, 2].map(|k| p[k] + shift[k])));
    m.tets.extend(b.tets.iter().map(|t| t.map(|v| v + base)));
    m.boundary.extend(b.boundary.iter().map(|t| t.map(|v| v + base)));
    m.boundary_face.extend(b.boundary_face.iter().map(|f| f + 6));
    m
}

#[test]
fn an_unheld_piece_is_an_error() {
    let one = box_mesh([10.0, 10.0, 10.0], [2, 2, 2], 0.0);
    let m = join(&one, &one, [20.0, 0.0, 0.0]);
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: None,
        material: STEEL,
        fixed: vec![0],
        loads: vec![Load { faces: vec![7], kind: LoadKind::Force([1.0, 0.0, 0.0]) }],
    };
    let e = solve(&p, &mut go).unwrap_err();
    eprintln!("unheld: {e}");
    match e {
        SolveError::NotHeld { loose, near, hinged } => {
            assert_eq!(loose, 1);
            assert!(!hinged);
            assert!((near[0] - 25.0).abs() < 1e-9);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        e.to_string(),
        "the body is not held and can still move, the piece near (25.000, 5.000, 5.000) mm is not connected to a fixed face"
    );
    // Holding both pieces solves.
    let p = Problem { fixed: vec![0, 6], ..p };
    let s = solve(&p, &mut go).unwrap();
    assert!(balance(&s) < 1e-6);
}

#[test]
fn a_piece_hinged_on_an_edge_is_an_error() {
    // Two cubes sharing only the edge x = 10, z = 10 of the first.
    let one = box_mesh([10.0, 10.0, 10.0], [1, 1, 1], 0.0);
    let mut m = join(&one, &one, [10.0, 0.0, 10.0]);
    // Weld the shared edge's nodes.
    let n = one.nodes.len() as u32;
    let mut remap: Vec<u32> = (0..m.nodes.len() as u32).collect();
    for j in n..m.nodes.len() as u32 {
        if let Some(i) = (0..n).find(|&i| norm(sub(m.nodes[i as usize], m.nodes[j as usize])) < 1e-9) {
            remap[j as usize] = i;
        }
    }
    for t in &mut m.tets {
        *t = t.map(|v| remap[v as usize]);
    }
    for t in &mut m.boundary {
        *t = t.map(|v| remap[v as usize]);
    }
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: None,
        material: STEEL,
        fixed: vec![0],
        loads: vec![Load { faces: vec![7], kind: LoadKind::Force([1.0, 0.0, 0.0]) }],
    };
    let e = solve(&p, &mut go).unwrap_err();
    eprintln!("hinged: {e}");
    assert!(matches!(e, SolveError::NotHeld { loose: 1, hinged: true, .. }), "{e:?}");
}

fn slider(faces: Vec<u32>) -> Support {
    Support { hold: Hold::Slider(vec![SlideFace::Mesh; faces.len()]), faces }
}

fn sum_of(v: &[V3]) -> V3 {
    v.iter().fold([0.0; 3], |s, r| [0, 1, 2].map(|k| s[k] + r[k]))
}

#[test]
fn a_slider_beside_a_fixed_face_holds_only_along_its_normal() {
    // A bar glued to a wall at x = 0 and resting on a frictionless floor at z = 0, pulled
    // at its far end. The nodes on the edge both share are simply fixed.
    let m = box_mesh([60.0, 10.0, 10.0], [12, 2, 2], 0.0);
    let force = [5.0, 3.0, -40.0];
    let p = Problem {
        mesh: &m,
        supports: vec![slider(vec![4])],
        body_force: None,
        material: STEEL,
        fixed: vec![0],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force(force) }],
    };
    let s = solve(&p, &mut go).unwrap();
    let total = sum_of(&s.reactions);
    eprintln!(
        "slider and fixed: reactions {:?}, sum {total:?}, reaction {:?}, balance {:.2e}",
        s.reactions,
        s.reaction,
        balance(&s)
    );
    assert!(balance(&s) < 1e-6);
    assert_eq!(s.reactions.len(), 2);
    assert!(norm(sub(total, s.reaction)) < 1e-9 * norm(force));
    // The floor only pushes up.
    let floor = s.reactions[1];
    assert!(floor[0].abs() < 1e-6 * norm(force) && floor[1].abs() < 1e-6 * norm(force));
    assert!(floor[2] > 0.0, "{floor:?}");
    // Its nodes away from the wall slide along it but never through it.
    let bottom = face_nodes(&m, &s, 4);
    let wall = face_nodes(&m, &s, 0);
    let mut slid: f64 = 0.0;
    for n in bottom.iter().filter(|n| wall.binary_search(n).is_err()) {
        let u = s.displacement[*n as usize];
        assert_eq!(u[2], 0.0, "{u:?}");
        slid = slid.max(u[0].abs());
    }
    assert!(slid > 1e-6, "{slid}");
    for n in &wall {
        assert_eq!(s.displacement[*n as usize], [0.0; 3]);
    }
}

#[test]
fn sliders_alone_hold_a_plate_only_when_they_stop_every_slide_and_turn() {
    let m = box_mesh([40.0, 40.0, 4.0], [8, 8, 1], 0.0);
    let p = |supports: Vec<Support>| Problem {
        mesh: &m,
        supports,
        body_force: None,
        material: STEEL,
        fixed: vec![],
        loads: vec![Load { faces: vec![5], kind: LoadKind::Pressure(0.01) }],
    };
    // On the floor alone it can still slide about.
    let e = solve(&p(vec![slider(vec![4])]), &mut go).unwrap_err();
    assert_eq!(e.to_string(), "the body can still slide along X, add a support that holds it that way");
    // Against a wall too, it can slide along the wall.
    let e = solve(&p(vec![slider(vec![4]), slider(vec![0])]), &mut go).unwrap_err();
    assert_eq!(e, SolveError::Free { motion: Motion::Slide { along: [0.0, 1.0, 0.0] } }, "{e}");
    // In a corner it is held, by three sliders or by one slider on three faces.
    for supports in [vec![slider(vec![4]), slider(vec![0]), slider(vec![2])], vec![slider(vec![0, 2, 4])]] {
        let n = supports.len();
        let s = solve(&p(supports), &mut go).unwrap();
        assert!(balance(&s) < 1e-6, "{}", balance(&s));
        assert_eq!(s.reactions.len(), n);
        assert!(norm(sub(sum_of(&s.reactions), s.reaction)) < 1e-9 * norm(s.applied));
    }
    let none = solve(&p(vec![]), &mut go).unwrap_err();
    assert_eq!(none, SolveError::NoFixedFaces);
}

#[test]
fn one_slider_on_three_faces_holds_a_corner_as_three_sliders_do() {
    // A cube in a corner under its weight and a push into the x = 0 wall. One slider over three faces must hold each
    // node along every face normal, as three sliders do, or the corner node sinks into one wall.
    let m = box_mesh([20.0, 20.0, 20.0], [4, 4, 4], 0.0);
    let p = |supports: Vec<Support>| Problem {
        mesh: &m,
        supports,
        body_force: Some([0.0, 0.0, -7.85 * 9.81e-6]),
        material: STEEL,
        fixed: vec![],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force([-3.0, 0.0, 0.0]) }],
    };
    let three = solve(&p(vec![slider(vec![4]), slider(vec![0]), slider(vec![2])]), &mut go).unwrap();
    let one = solve(&p(vec![slider(vec![4, 0, 2])]), &mut go).unwrap();
    let top = three.max_displacement;
    assert!(top > 0.0);
    for (a, b) in three.displacement.iter().zip(&one.displacement) {
        assert!(norm(sub(*a, *b)) < 1e-9 * top, "{a:?} vs {b:?}");
    }
    assert_eq!(one.displacement[0], [0.0; 3], "the corner at the origin");
    for (face, axis) in [(4, 2), (0, 0), (2, 1)] {
        for n in face_nodes(&m, &one, face) {
            assert_eq!(one.displacement[n as usize][axis], 0.0);
        }
    }
    assert!(norm(sub(sum_of(&three.reactions), one.reactions[0])) < 1e-9 * 3.0);
}

#[test]
fn a_pin_leaves_the_turn_about_its_axis_free() {
    // A pin through the bar's -x end along X, as a hole's walls would take it.
    let m = box_mesh([30.0, 10.0, 10.0], [6, 2, 2], 0.0);
    let pin =
        Support { faces: vec![0], hold: Hold::Pinned(vec![Axis { origin: [-3.0, 5.0, 5.0], dir: [2.0, 0.0, 0.0] }]) };
    let p = |supports: Vec<Support>| Problem {
        mesh: &m,
        supports,
        body_force: None,
        material: STEEL,
        fixed: vec![],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force([0.0, 0.0, -10.0]) }],
    };
    let e = solve(&p(vec![pin.clone()]), &mut go).unwrap_err();
    eprintln!("pin alone: {e}");
    let SolveError::Free { motion: Motion::Turn { about, through, pivot: Some(Pivot::Pin) } } = &e else {
        panic!("{e:?}");
    };
    assert!(norm(cross(*about, [1.0, 0.0, 0.0])) < 1e-9, "{about:?}");
    assert!(norm(sub(*through, [15.0, 5.0, 5.0])) < 1e-6, "{through:?}");
    assert_eq!(e.to_string(), "the body can still turn about the pin's axis through (15, 5, 5), add another support");
    // A slider on the side stops the turn.
    let s = solve(&p(vec![pin, slider(vec![2])]), &mut go).unwrap();
    assert!(balance(&s) < 1e-6, "{}", balance(&s));
    assert!(norm(sub(sum_of(&s.reactions), s.reaction)) < 1e-9 * 10.0);
    // The pin's face moves only by turning, so not along X or towards the axis.
    for n in face_nodes(&m, &s, 0) {
        let x = s.nodes[n as usize];
        let u = s.displacement[n as usize];
        let radial = [0.0, x[1] - 5.0, x[2] - 5.0];
        assert!(u[0].abs() < 1e-15 && dot(u, radial).abs() < 1e-12, "{u:?} at {x:?}");
    }
    // An axis of no length is refused.
    let bad = Support { faces: vec![0], hold: Hold::Pinned(vec![Axis { origin: [0.0; 3], dir: [0.0; 3] }]) };
    assert_eq!(solve(&p(vec![bad]), &mut go).unwrap_err(), SolveError::InvalidSupport { support: 0 });
}

#[test]
fn gravity_bends_a_cantilever_by_its_weight() {
    let (l, b, h) = (100.0, 10.0, 10.0);
    let m = box_mesh([l, b, h], [40, 4, 4], 0.0);
    // Steel, 7.85 g/cm3, under 9.81 m/s2 along -Z, in N per cubic mm.
    let rho_g = 7.85 * 9.81e-6;
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: Some([0.0, 0.0, -rho_g]),
        material: STEEL,
        fixed: vec![0],
        loads: vec![],
    };
    let s = solve(&p, &mut go).unwrap();
    let weight = s.weight.expect("a weight");
    let want = -rho_g * l * b * h;
    assert!((weight[2] - want).abs() < 1e-12 * want.abs(), "{weight:?}");
    assert!(norm(sub(s.applied, weight)) < 1e-12 * want.abs());
    assert!(balance(&s) < 1e-6);
    // q L^4 / 8 E I with the shear term q L^2 / 2 k G A.
    let q = rho_g * b * h;
    let i = b * h * h * h / 12.0;
    let g = STEEL.e / (2.0 * (1.0 + STEEL.nu));
    let tip_want = q * l.powi(4) / (8.0 * STEEL.e * i) + q * l * l / (2.0 * 5.0 / 6.0 * g * b * h);
    let end = face_nodes(&m, &s, 1);
    let tip = -end.iter().map(|&n| s.displacement[n as usize][2]).sum::<f64>() / end.len() as f64;
    eprintln!("gravity: weight {weight:?}, tip {tip:.6e} vs {tip_want:.6e}");
    assert!((tip - tip_want).abs() < 0.03 * tip_want, "{tip} vs {tip_want}");
    // The weight adds to the loads.
    let with_load =
        solve(&Problem { loads: vec![Load { faces: vec![1], kind: LoadKind::Force([0.0, 0.0, -1.0]) }], ..p }, &mut go)
            .unwrap();
    assert!((with_load.applied[2] - (want - 1.0)).abs() < 1e-9);
}

/// Run with `cargo test --release -- --ignored --nocapture solve_time`.
#[test]
#[ignore]
fn solve_time_about_50k_tets() {
    let m = box_mesh([120.0, 24.0, 24.0], [60, 12, 12], 0.0);
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: None,
        material: STEEL,
        fixed: vec![0],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force([0.0, 0.0, -1000.0]) }],
    };
    let t0 = std::time::Instant::now();
    let mut factor = std::time::Duration::ZERO;
    let s = solve_with(&p, &mut go, &mut |f| {
        let t = std::time::Instant::now();
        f();
        factor = t.elapsed();
    })
    .unwrap();
    let total = t0.elapsed();
    let t1 = std::time::Instant::now();
    let again = solve(&p, &mut go).unwrap();
    eprintln!(
        "{} tets, {} TET10 nodes, {} dofs: total {:.2?} (factorise and solve {:.2?}), second run {:.2?}, identical {}, balance {:.2e}",
        s.elements,
        s.nodes.len(),
        s.dofs,
        total,
        factor,
        t1.elapsed(),
        s == again,
        balance(&s)
    );
}

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
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

fn placed(m: &mut TetMesh) {
    for p in &mut m.nodes {
        let (s, c) = 0.52f64.sin_cos();
        let q = [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
        let (s, c) = 0.35f64.sin_cos();
        *p = [q[0] + 17.0, c * q[1] - s * q[2] - 9.0, s * q[1] + c * q[2] + 31.0];
    }
}

#[test]
fn the_error_estimate_is_zero_where_the_solution_is_exact() {
    let mut m = box_mesh([60.0, 11.0, 7.0], [8, 2, 2], 0.25);
    placed(&mut m);
    let axis = {
        let d = sub(m.nodes[1], m.nodes[0]);
        d.map(|v| v / norm(d))
    };
    let p = Problem {
        mesh: &m,
        supports: vec![],
        body_force: None,
        material: Material { e: 3500.0, nu: 0.0 },
        fixed: vec![0],
        loads: vec![Load { faces: vec![1], kind: LoadKind::Force(axis.map(|v| v * 700.0)) }],
    };
    let s = solve(&p, &mut go).unwrap();
    assert_eq!(s.element_error.len(), m.tets.len());
    let total = s.element_error.iter().map(|e| e * e).sum::<f64>().sqrt();
    assert!(total < 1e-9 * (2.0 * s.strain_energy).sqrt(), "{total} against energy {}", s.strain_energy);
}

#[test]
fn the_error_estimate_peaks_beside_a_clamped_end() {
    let c = cantilever([20, 3, 3]);
    let m = box_mesh([100.0, 10.0, 10.0], [20, 3, 3], 0.0);
    assert_eq!(c.s.element_error.len(), m.tets.len());
    assert!(c.s.element_error.iter().all(|e| e.is_finite() && *e >= 0.0));
    let worst = (0..m.tets.len()).max_by(|&a, &b| c.s.element_error[a].total_cmp(&c.s.element_error[b])).unwrap();
    let x = m.tets[worst].iter().map(|&n| m.nodes[n as usize][0]).sum::<f64>() / 4.0;
    assert!(x < 10.0, "largest error at x = {x}");
    let mid = (0..m.tets.len())
        .filter(|&t| m.tets[t].iter().all(|&n| (m.nodes[n as usize][0] - 50.0).abs() < 6.0))
        .map(|t| c.s.element_error[t])
        .fold(0.0, f64::max);
    assert!(c.s.element_error[worst] > 3.0 * mid, "{} against {mid} at mid span", c.s.element_error[worst]);
    assert!(cantilever([20, 3, 3]).s.element_error == c.s.element_error);
}
