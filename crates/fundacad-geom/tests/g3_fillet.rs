//! G3 fillets, and the gate G2 and G3 share: both ease into the faces with zero curvature, which only
//! matches a face that is flat across the edge. The volumes are the research probe's (tests/g3_probe).

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::blend::ops;
use fundacad_geom::kernel;
use fundacad_geom::mesh::edges::edge_polylines;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const G3_SETBACK: f64 = 1.4588;
const NOT_FLAT: &str = "needs both faces flat across the edge";

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

fn polygon(pts: &[[f64; 2]]) -> Vec<Value> {
    (0..pts.len()).map(|i| line(&format!("l{i}"), pts[i], pts[(i + 1) % pts.len()])).collect()
}

/// A triangle prism whose edge at `at` joins two planes at `angle` degrees, its legs 50 long and turned by `turn`.
fn wedge_at(angle: f64, at: [f64; 2], turn: f64) -> Vec<Value> {
    let (t, r) = (angle.to_radians(), turn.to_radians());
    let rot = |p: [f64; 2]| [at[0] + p[0] * r.cos() - p[1] * r.sin(), at[1] + p[0] * r.sin() + p[1] * r.cos()];
    polygon(&[rot([0.0, 0.0]), rot([-50.0, 0.0]), rot([-50.0 * t.cos(), -50.0 * t.sin()])])
}

fn wedge(angle: f64) -> Vec<Value> {
    wedge_at(angle, [0.0, 0.0], 0.0)
}

/// A circle segment prism: its vertical edge at the origin joins a plane and a cylinder along its axis.
fn segment() -> Vec<Value> {
    vec![
        line("l0", [-30.0, 0.0], [0.0, 0.0]),
        json!({"type": "arc", "id": "a0", "x1": 0.0, "y1": 0.0, "x2": -30.0, "y2": 0.0, "mx": -15.0, "my": -12.0}),
    ]
}

/// A 150 degree sector of radius 15 about Z.
fn sector() -> Vec<Value> {
    let at = |deg: f64| [15.0 * deg.to_radians().cos(), 15.0 * deg.to_radians().sin()];
    let (b, m) = (at(150.0), at(75.0));
    vec![
        line("l0", [0.0, 0.0], [15.0, 0.0]),
        json!({"type": "arc", "id": "a0", "x1": 15.0, "y1": 0.0, "x2": b[0], "y2": b[1], "mx": m[0], "my": m[1]}),
        line("l1", b, [0.0, 0.0]),
    ]
}

fn square() -> Vec<Value> {
    vec![json!({"type": "rectangle", "width": 50, "height": 50, "x": 0, "y": 0})]
}

fn fillet(edges: &[[f64; 3]], radius: f64, continuity: &str) -> Value {
    let picks: Vec<Value> = edges.iter().map(|p| json!({"kind": "edge", "by": "nearest", "point": p})).collect();
    json!({"id": "f", "type": "fillet", "radius": radius, "continuity": continuity, "edges": picks})
}

fn build_doc(features: Vec<Value>) -> Rebuild {
    let doc = json!({ "features": features });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn prism(entities: Vec<Value>, height: f64, extra: Value) -> Vec<Value> {
    let mut e = json!({"id": "e", "type": "extrude", "sketch": "s", "distance": height, "operation": "new"});
    if let (Some(e), Some(x)) = (e.as_object_mut(), extra.as_object()) {
        e.extend(x.clone());
    }
    vec![json!({"id": "s", "type": "sketch", "plane": "XY", "entities": entities}), e]
}

fn built(features: Vec<Value>) -> Shape {
    let r = build_doc(features);
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r.bodies[0].shape.clone()
}

fn refusal(features: Vec<Value>) -> String {
    let r = build_doc(features);
    r.errors.first().map(|e| e.message.clone()).unwrap_or_default()
}

fn g3(entities: Vec<Value>, height: f64, edges: &[[f64; 3]], radius: f64) -> Shape {
    let mut f = prism(entities, height, json!({}));
    f.push(fillet(edges, radius, "G3"));
    built(f)
}

/// Valid, no crease over 0.01 degrees, and G3 across every contact. Edges and faces keep 1e-7, but where a contact
/// line ends on an end face the boolean leaves its vertex up to about 1.75e-4 of the setback away from the end of
/// the intersection curve: the section meets the face to fourth order there, so the curve's end is ill conditioned
/// (G2 leaves 2.15e-5 on the same 90 degree wedge). `tolerance` bounds that; a corner patch takes more, as G2's does.
fn healthy_g3_within(s: &Shape, radius: f64, tolerance: f64) -> ops::ContactJumps {
    let j = ops::contact_jumps(s, radius, radius * G3_SETBACK).expect("measured");
    assert!(j.valid, "{j:?}");
    assert!(j.max_tolerance <= tolerance, "{j:?}");
    assert!(j.crease_deg < 0.01, "{j:?}");
    assert!(j.contacts >= 2, "{j:?}");
    assert!(j.curvature < 1e-4, "{j:?}");
    assert!(j.rate < 1e-2, "{j:?}");
    j
}

fn healthy_g3(s: &Shape, radius: f64) -> ops::ContactJumps {
    healthy_g3_within(s, radius, 2e-4 * radius * G3_SETBACK)
}

fn near(v: f64, want: f64, tol: f64) {
    assert!((v - want).abs() < tol, "{v:.4} vs {want:.4}");
}

#[test]
fn g3_wedges_build_the_research_volumes_and_are_g3() {
    for (angle, want) in [(90.0, 49088.1503), (120.0, 43038.0418), (60.0, 40932.2151)] {
        let s = g3(wedge(angle), 40.0, &[[0.0, 0.0, 20.0]], 10.0);
        near(kernel::volume(&s), want, 1e-3);
        healthy_g3(&s, 10.0);
    }
}

/// The measurement tells the three apart: G1 jumps in curvature, G2 in its rate, G3 in neither.
#[test]
fn the_measure_sees_g1_and_g2_jumps() {
    let mut f = prism(wedge(90.0), 40.0, json!({}));
    f.push(fillet(&[[0.0, 0.0, 20.0]], 10.0, "G1"));
    let j = ops::contact_jumps(&built(f), 10.0, 10.0).expect("measured");
    assert!(j.curvature > 0.5, "{j:?}");
    let mut f = prism(wedge(90.0), 40.0, json!({}));
    f.push(fillet(&[[0.0, 0.0, 20.0]], 10.0, "G2"));
    let j = ops::contact_jumps(&built(f), 10.0, 15.5).expect("measured");
    assert!(j.curvature < 1e-4 && j.rate > 0.1, "{j:?}");
}

#[test]
fn a_g3_inside_corner_fuses_the_research_volume() {
    let l = polygon(&[[-50.0, -50.0], [50.0, -50.0], [50.0, 0.0], [0.0, 0.0], [0.0, 50.0], [-50.0, 50.0]]);
    let s = g3(l, 40.0, &[[0.0, 0.0, 20.0]], 10.0);
    near(kernel::volume(&s), 300911.8497, 1e-3);
    healthy_g3(&s, 10.0);
}

#[test]
fn a_g3_rim_arc_builds_the_research_volume() {
    let m = [15.0 * 75f64.to_radians().cos(), 15.0 * 75f64.to_radians().sin(), 30.0];
    let s = g3(sector(), 30.0, &[m], 3.0);
    near(kernel::volume(&s), 8758.9576, 1e-2);
    healthy_g3(&s, 3.0);
}

const CORNER: [[f64; 3]; 3] = [[0.0, 25.0, 40.0], [-25.0, 0.0, 40.0], [-25.0, 25.0, 20.0]];

#[test]
fn a_g3_three_edge_corner_builds_the_research_volume() {
    let s = g3(square(), 40.0, &CORNER, 10.0);
    near(kernel::volume(&s), 96975.6919, 1e-2);
    healthy_g3_within(&s, 10.0, 0.1);
}

#[test]
fn a_g3_three_edge_corner_holds_at_other_radii() {
    let mut last = f64::INFINITY;
    for r in [3.0, 6.5, 15.0] {
        let s = g3(square(), 40.0, &CORNER, r);
        let v = kernel::volume(&s);
        assert!(v < last && v < 100_000.0 && v > 90_000.0, "R {r}: {v}");
        last = v;
        healthy_g3_within(&s, r, 0.1);
    }
}

#[test]
fn a_g3_wedge_off_the_origin_and_turned_keeps_its_volume() {
    let s = g3(wedge_at(90.0, [37.0, -12.5], 23.0), 40.0, &[[37.0, -12.5, 20.0]], 10.0);
    near(kernel::volume(&s), 49088.1503, 1e-3);
    healthy_g3(&s, 10.0);
}

#[test]
fn a_g3_on_an_asymmetric_slanted_edge_is_g3() {
    let mut f = prism(wedge_at(75.0, [-8.0, 21.0], -31.0), 40.0, json!({"taper": 6}));
    f.push(fillet(&[[-8.0, 21.0, 20.0]], 4.0, "G3"));
    let s = built(f);
    healthy_g3(&s, 4.0);
}

#[test]
fn g2_and_g3_refuse_a_plane_meeting_a_cylinder_along_its_axis() {
    for c in ["G2", "G3"] {
        for r in [1.0, 2.0, 3.0] {
            let mut f = prism(segment(), 40.0, json!({}));
            f.push(fillet(&[[0.0, 0.0, 20.0]], r, c));
            let msg = refusal(f);
            assert!(msg.contains(&format!("{c} {NOT_FLAT}")) && msg.contains("use G1 here"), "{c} R {r}: {msg:?}");
        }
    }
    let mut f = prism(segment(), 40.0, json!({}));
    f.push(fillet(&[[0.0, 0.0, 20.0]], 1.0, "G1"));
    built(f);
}

#[test]
fn g2_and_g3_refuse_a_sphere_edge() {
    let arc = json!({"type": "arc", "id": "a", "x1": 20.0, "y1": 0.0, "x2": 0.0, "y2": 20.0,
                     "mx": 14.142135623730951, "my": 14.142135623730951});
    let half = vec![
        json!({"id": "s", "type": "sketch", "plane": "XZ",
               "entities": [line("l0", [0.0, 0.0], [20.0, 0.0]), arc, line("l1", [0.0, 20.0], [0.0, 0.0])]}),
        json!({"id": "r", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 360, "operation": "new"}),
    ];
    for c in ["G2", "G3"] {
        let mut f = half.clone();
        f.push(fillet(&[[20.0, 0.0, 0.0]], 2.0, c));
        let msg = refusal(f);
        assert!(msg.contains(&format!("{c} {NOT_FLAT}")), "{c}: {msg:?}");
    }
}

/// Old G2 documents on flat edges build as before (tests/g3_probe/numbers.txt).
#[test]
fn g2_on_flat_edges_builds_as_before() {
    let mut f = prism(wedge(90.0), 40.0, json!({}));
    f.push(fillet(&[[0.0, 0.0, 20.0]], 10.0, "G2"));
    near(kernel::volume(&built(f)), 49039.0000, 1e-3);
    let mut f = prism(square(), 40.0, json!({}));
    f.push(fillet(&CORNER, 10.0, "G2"));
    near(kernel::volume(&built(f)), 96817.3739, 1e-3);
}

/// The curvature across each mesh edge, which the fillet tool weighs against its radius: the segment's edge along
/// the cylinder curves at 1/15.37 per mm, its rims and plane edges are flat.
#[test]
fn mesh_edges_report_their_cross_curvature() {
    let s = built(prism(segment(), 40.0, json!({})));
    let lines = edge_polylines(&MeshAccess::new(&s));
    let along = lines
        .iter()
        .find(|l| l.points.len() == 2 && l.points.iter().all(|q| q[0].abs() < 1e-6 && q[1].abs() < 1e-6))
        .expect("the vertical edge at the origin");
    let r = (15.0f64.powi(2) + 12.0f64.powi(2)) / 24.0;
    assert!((along.curvature - 1.0 / r).abs() < 1e-6, "{} vs {}", along.curvature, 1.0 / r);
    let chord = lines
        .iter()
        .find(|l| l.points.len() == 2 && l.points.iter().all(|q| q[1].abs() < 1e-6 && (q[2] - 40.0).abs() < 1e-6))
        .expect("the top chord edge");
    assert_eq!(chord.curvature, 0.0);
    let rims: Vec<f64> = lines.iter().filter(|l| l.points.len() > 2).map(|l| l.curvature).collect();
    assert!(!rims.is_empty() && rims.iter().all(|k| k.abs() < 1e-12), "{rims:?}");
}

/// The profile slides the inner poles along each leg, so a fuller or flatter section stays G2 or G3.
#[test]
fn g2_and_g3_keep_their_continuity_with_a_profile() {
    for p in [-0.4, 0.4] {
        for (c, setback) in [("G2", 1.55), ("G3", G3_SETBACK)] {
            let mut f = prism(wedge(90.0), 40.0, json!({}));
            let mut fl = fillet(&[[0.0, 0.0, 20.0]], 10.0, c);
            fl["profile"] = json!(p);
            f.push(fl);
            let s = built(f);
            let j = ops::contact_jumps(&s, 10.0, 10.0 * setback).expect("measured");
            assert!(j.valid && j.crease_deg < 0.01 && j.contacts >= 2, "{c} {p}: {j:?}");
            assert!(j.curvature < 1e-4, "{c} {p}: {j:?}");
            if c == "G3" {
                assert!(j.rate < 1e-2, "{c} {p}: {j:?}");
            } else {
                assert!(j.rate > 0.05, "{c} {p}: {j:?}");
            }
        }
    }
}

/// A cone met at its rim is flat across the edge, so is a hole's rim, whose cylinder faces inward.
#[test]
fn g3_builds_on_a_cone_rim_and_a_hole_rim() {
    let circle = vec![json!({"type": "circle", "id": "c", "x": 0, "y": 0, "radius": 20})];
    let mut f = prism(circle, 30.0, json!({"taper": 10}));
    let top = 20.0 - 30.0 * 10f64.to_radians().tan();
    f.push(fillet(&[[top, 0.0, 30.0]], 2.0, "G3"));
    healthy_g3(&built(f), 2.0);

    let mut f = prism(square(), 40.0, json!({}));
    f.push(json!({"id": "h", "type": "sketch", "plane": "XY",
                  "entities": [{"type": "circle", "id": "c", "x": 0, "y": 0, "radius": 8}]}));
    f.push(json!({"id": "x", "type": "extrude", "sketch": "h", "distance": 40, "operation": "cut"}));
    f.push(fillet(&[[8.0, 0.0, 40.0]], 2.0, "G3"));
    let s = built(f);
    let v = kernel::volume(&s);
    assert!(v < 50.0 * 50.0 * 40.0 - std::f64::consts::PI * 64.0 * 40.0, "{v}");
    healthy_g3(&s, 2.0);
}

/// One curved edge in a pick refuses the whole fillet, a flat neighbour does not carry it.
#[test]
fn a_mixed_pick_of_flat_and_curved_edges_refuses_g2_and_g3() {
    for c in ["G2", "G3"] {
        let mut f = prism(segment(), 40.0, json!({}));
        f.push(fillet(&[[-15.0, 0.0, 40.0], [0.0, 0.0, 20.0]], 1.0, c));
        let msg = refusal(f);
        assert!(msg.contains(&format!("{c} {NOT_FLAT}")), "{c}: {msg:?}");
    }
}
