//! A round up the miter where two G2 blends meet: the kernel closes the seam
//! between its two surface pieces with an edge it calls degenerated, with one
//! vertex 6.35 mm wide standing in for both ends, and every mesh of the body
//! fans to that vertex.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::mesh::{self, viewport_profile};
use opencascade::primitives::Shape;
use serde_json::json;

fn g2_then_corner() -> Shape {
    let (w, d, h) = (35.392, 46.453, 10.782);
    let doc = json!({
        "parameters": {},
        "features": [
            {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
                {"type": "rectangle", "id": "e0", "width": w, "height": d, "x": 0, "y": 0}]},
            {"id": "f2", "type": "extrude", "sketch": "f1", "distance": h,
             "operation": "new", "regions": [[0, 0, 0]]},
            {"id": "f3", "type": "fillet", "radius": 4.7, "continuity": "G2", "edges": [
                {"kind": "edge", "by": "nearest", "point": [-w / 2.0, 0, h], "body": "body1"},
                {"kind": "edge", "by": "nearest", "point": [0, d / 2.0, h], "body": "body1"},
                {"kind": "edge", "by": "nearest", "point": [w / 2.0, 0, h], "body": "body1"},
                {"kind": "edge", "by": "nearest", "point": [0, -d / 2.0, h], "body": "body1"}]},
            {"id": "f4", "type": "fillet", "radius": 4.5, "edges":
                {"kind": "edge", "by": "nearest", "point": [15.68, -21.21, 9.92], "body": "body1"}}
        ],
        "bodyIds": {"f2:0": "body1"}
    });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r.bodies[0].shape.clone()
}

#[test]
fn a_corner_round_after_a_g2_fillet_keeps_its_vertices_tight() {
    let s = g2_then_corner();
    assert_eq!(kernel::count(&s, Kind::Face), 13);
    assert!((kernel::volume(&s) - 16863.63).abs() < 0.5, "{}", kernel::volume(&s));
    let widest = opencascade_sys::xcaf::step_widest_tolerance(s.raw());
    assert!(widest < 0.01, "a vertex or edge {widest} mm wide");
}

#[test]
fn a_corner_round_after_a_g2_fillet_meshes_to_its_own_area() {
    let s = g2_then_corner();
    let faces = kernel::subshapes(&s, Kind::Face);
    let view = mesh::body_payload(&s, "body1", "box", 0.1, viewport_profile(1));
    let mut meshed = vec![0.0f64; faces.len()];
    for (t, &f) in view.face_ids.iter().enumerate() {
        let p = |k: usize| {
            let i = view.indices[3 * t + k] as usize;
            [0, 1, 2].map(|c| view.positions[3 * i + c] as f64)
        };
        let (a, b, c) = (p(0), p(1), p(2));
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        meshed[f as usize] += 0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    }
    let off: Vec<String> = faces
        .iter()
        .zip(&meshed)
        .enumerate()
        .filter_map(|(i, (f, &m))| {
            let exact = kernel::face_area_centre(f).expect("measurable")[0];
            ((m - exact).abs() > 0.5 + 0.02 * exact).then(|| format!("face {i}: mesh {m:.3} vs {exact:.3}"))
        })
        .collect();
    assert!(off.is_empty(), "{off:?}");
}
