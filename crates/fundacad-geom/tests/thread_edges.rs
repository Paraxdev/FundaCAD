//! A thread's helical edges draw on the surface they lie on. A whole turn the
//! deflection sampler took as one chord was drawn as a square across the bore,
//! in front of the thread, and took the picks meant for it.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use fundacad_geom::mesh::edges::{edge_polylines, EDGE_DEFLECTION};
use opencascade::mesh_access::MeshAccess;
use serde_json::{json, Value};

const M10_PROFILE: [[f64; 2]; 4] = [[0.12178, -0.72656], [-0.8119, -0.1875], [-0.8119, 0.1875], [0.12178, 0.72656]];
const M5_PROFILE: [[f64; 2]; 4] = [[0.06495, -0.3875], [-0.43301, -0.1], [-0.43301, 0.1], [0.06495, 0.3875]];
const CUT_PROFILE: [[f64; 2]; 4] = [[-0.13801, -0.70465], [0.9201, -0.09375], [0.9201, 0.09375], [-0.13801, 0.70465]];

/// A thread joined into a bore drawn at the nominal diameter, as the Screws
/// plugin's Standard Thread builds it.
fn joined_hole(outer: f64, height: f64, bore: f64, profile: [[f64; 2]; 4], pitch: f64) -> Value {
    json!({"parameters": {}, "features": [
        {"id": "f1", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "c1", "radius": outer, "x": 0, "y": 0}]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": height, "operation": "new", "regions": [[0, 0, 0]]},
        {"id": "f3", "type": "sketch", "plane": {"origin": [0, 0, height], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [{"type": "circle", "id": "c2", "radius": bore, "x": 0, "y": 0}]},
        {"id": "f4", "type": "extrude", "sketch": "f3", "distance": -height, "operation": "cut", "regions": [[0, 0, height]]},
        {"id": "th", "type": "thread", "face": {"kind": "face", "by": "nearest", "point": [bore, 0, height / 2.0], "body": "body1"},
         "profile": profile, "pitch": pitch, "starts": 1, "hand": "right", "operation": "join", "axis": [0, 0, 1]}]})
}

fn cut_thread(base: Value) -> Value {
    json!({"parameters": {}, "features": [base,
        {"id": "th", "type": "thread", "face": {"kind": "face", "by": "nearest", "point": [5, 0, 0], "body": "body1"},
         "profile": CUT_PROFILE, "pitch": 1.5, "starts": 1, "hand": "right", "operation": "cut", "axis": [0, 0, 1]}]})
}

fn cut_hole() -> Value {
    let mut doc = cut_thread(json!({"id": "bk", "type": "box", "length": 24, "width": 24, "height": 10}));
    doc["features"].as_array_mut().unwrap().insert(
        1,
        json!({"id": "bo", "type": "cylinder", "radius": 5, "height": 12, "operation": "cut", "targets": ["body1"]}),
    );
    doc
}

fn cut_rod() -> Value {
    cut_thread(json!({"id": "sh", "type": "cylinder", "radius": 5, "height": 10}))
}

fn coil() -> Value {
    json!({"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XZ", "entities": [{"type": "rectangle", "id": "r", "x": 5.5, "y": 0.25, "width": 1, "height": 0.5}]},
        {"id": "rv", "type": "revolve", "sketch": "s", "axis": "z", "angle": 720, "pitch": 2, "operation": "new", "regions": [[5.5, 0, 0.25]]}]})
}

fn to_segment(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab: Vec<f64> = (0..3).map(|k| b[k] - a[k]).collect();
    let ap: Vec<f64> = (0..3).map(|k| p[k] - a[k]).collect();
    let len2: f64 = ab.iter().map(|x| x * x).sum();
    let t = if len2 > 0.0 { ((0..3).map(|k| ap[k] * ab[k]).sum::<f64>() / len2).clamp(0.0, 1.0) } else { 0.0 };
    (0..3).map(|k| (ap[k] - t * ab[k]).powi(2)).sum::<f64>().sqrt()
}

/// Edge count, volume and how far the curve of any drawn edge strays from its
/// polyline, the curve sampled densely at a prime count so no whole number of
/// turns hides it. A polyline is matched to its edge by its middle point.
fn drawn(doc: &Value) -> (usize, f64, f64) {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(r.bodies.len(), 1);
    let shape = &r.bodies[0].shape;
    let access = MeshAccess::new(shape);
    let lines = edge_polylines(&access);
    let curves: Vec<(usize, f64, f64, [f64; 3])> = (0..access.edge_count())
        .filter_map(|e| {
            let (u0, u1) = access.edge_range(e)?;
            Some((e, u0, u1, access.edge_values(e, &[0.5 * (u0 + u1)])?[0]))
        })
        .collect();
    let mut worst = 0.0f64;
    for line in &lines {
        let p = &line.points;
        assert!(
            p.len() == 2 || p.len() % 2 == 1,
            "a curve keeps an odd point count, its middle point the parametric midpoint"
        );
        let middle = if p.len() == 2 {
            [(p[0][0] + p[1][0]) / 2.0, (p[0][1] + p[1][1]) / 2.0, (p[0][2] + p[1][2]) / 2.0]
        } else {
            p[p.len() / 2]
        };
        let &(e, u0, u1, _) = curves
            .iter()
            .find(|c| (0..3).all(|k| (c.3[k] - middle[k]).abs() < 1e-7))
            .expect("every drawn edge is an edge of the solid");
        let dense: Vec<f64> = (0..=499).map(|j| u0 + (u1 - u0) * j as f64 / 499.0).collect();
        for q in access.edge_values(e, &dense).expect("the curve evaluates") {
            let d = p.windows(2).map(|w| to_segment(q, w[0], w[1])).fold(f64::INFINITY, f64::min);
            worst = worst.max(d);
        }
    }
    (lines.len(), kernel::volume(shape), worst)
}

fn assert_on_surface(name: &str, doc: &Value, edges: usize, volume: f64) {
    let (n, v, sag) = drawn(doc);
    assert_eq!(n, edges, "{name}: the drawn edges are the solid's own");
    assert!((v - volume).abs() < 1e-6 * volume, "{name}: volume {v}, was {volume}");
    // EDGE_MAX_SEG caps the long thread's 24 turn crest at r 2.07 to a sag of 0.0224.
    assert!(sag <= 2.5 * EDGE_DEFLECTION, "{name}: an edge strays {sag} mm from its curve");
}

#[test]
fn a_joined_thread_draws_its_helices_on_the_bore() {
    assert_on_surface("joined hole", &joined_hole(15.0, 12.0, 5.0, M10_PROFILE, 1.5), 36, 7681.131_035);
}

/// The crest helix of a 24 turn thread came back as 9 points three turns
/// apart, a straight line down the bore.
#[test]
fn a_long_joined_thread_is_not_a_line_down_the_bore() {
    assert_on_surface("long joined hole", &joined_hole(10.0, 20.0, 2.5, M5_PROFILE, 0.8), 87, 5958.850_149);
}

#[test]
fn a_cut_thread_keeps_its_edges() {
    assert_on_surface("cut hole", &cut_hole(), 91, 4826.496_805);
    assert_on_surface("cut rod", &cut_rod(), 79, 656.501_319);
}

#[test]
fn a_two_turn_helix_is_not_four_chords() {
    assert_on_surface("coil", &coil(), 12, 34.557_559);
}
