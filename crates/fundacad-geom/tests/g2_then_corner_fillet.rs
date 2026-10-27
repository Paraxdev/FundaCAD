//! A round up the miter where two G2 blends meet: the kernel closes the seam between its two surface
//! pieces with a degenerated edge whose one vertex, 6.35 mm wide, stands in for both ends.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::blend::ops;
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::mesh::{self, viewport_profile};
use fundacad_geom::select::entity::edges_of;
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const MITRE: [f64; 3] = [15.68, -21.21, 9.92];

fn rebuild(corner: Option<f64>) -> Rebuild {
    let (w, d, h) = (35.392, 46.453, 10.782);
    let mut features = vec![
        json!({"id": "f1", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "e0", "width": w, "height": d, "x": 0, "y": 0}]}),
        json!({"id": "f2", "type": "extrude", "sketch": "f1", "distance": h, "operation": "new", "regions": [[0, 0, 0]]}),
        json!({"id": "f3", "type": "fillet", "radius": 4.7, "continuity": "G2", "edges": [
            {"kind": "edge", "by": "nearest", "point": [-w / 2.0, 0, h], "body": "body1"},
            {"kind": "edge", "by": "nearest", "point": [0, d / 2.0, h], "body": "body1"},
            {"kind": "edge", "by": "nearest", "point": [w / 2.0, 0, h], "body": "body1"},
            {"kind": "edge", "by": "nearest", "point": [0, -d / 2.0, h], "body": "body1"}]}),
    ];
    if let Some(r) = corner {
        features.push(json!({"id": "f4", "type": "fillet", "radius": r, "edges":
            {"kind": "edge", "by": "nearest", "point": MITRE, "body": "body1"}}));
    }
    let doc: Value = json!({"parameters": {}, "features": features, "bodyIds": {"f2:0": "body1"}});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

/// The mitre rounded at 4.5 mm by the kernel itself, which the fillet feature refuses as rippled.
fn g2_then_corner() -> Shape {
    let r = rebuild(None);
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let base = r.bodies[0].shape.clone();
    let mitre = edges_of(&base)
        .unwrap()
        .into_iter()
        .min_by(|a, b| {
            let d = |e: &Shape| kernel::distance_to_point(e, MITRE).unwrap_or(f64::INFINITY);
            d(&a.shape).total_cmp(&d(&b.shape))
        })
        .expect("the mitre")
        .shape;
    let (out, built) = ops::fillet(&base, &[mitre], &[4.5]).expect("the kernel runs");
    assert!(matches!(built, ops::Built::Done), "{built:?}");
    out
}

/// A G2 round of 4.7 mm curves tighter than a 4.5 mm ball near its middle (1.37 / 4.7 per mm), so no rolling ball
/// round of that size rests on it.
#[test]
fn a_round_up_the_mitre_larger_than_the_g2_curve_is_refused_with_a_size_that_builds() {
    let refused = rebuild(Some(4.5));
    let message = refused.errors.iter().map(|e| e.message.clone()).collect::<Vec<_>>().join(" | ");
    let fits = message
        .strip_suffix("mm, so try that size.")
        .and_then(|head| head.rsplit(' ').next())
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or_else(|| panic!("refused with a size: {message}"));
    assert!(message.starts_with("Fillet failed on Body1: at 4.5mm the fillet comes out rippled"), "{message}");
    let built = rebuild(Some(fits));
    assert!(built.errors.is_empty(), "{fits}: {:?}", built.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
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
