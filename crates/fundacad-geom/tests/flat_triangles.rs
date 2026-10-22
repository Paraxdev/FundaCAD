//! The kernel's mesher triangulates a face in its own parameters, where a pole
//! (the tip of a sphere, the corner patch three fillets leave, the point a
//! lofted spline face closes to) is a whole side of the face. That side gets
//! two nodes at the one point and a triangle between them, which has no area.
//! No mesh handed out may hold one: a voxeliser refuses the STL over it.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::export;
use fundacad_geom::mesh::{self, viewport_profile};
use fundacad_geom::printcheck::op::printability_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};

#[path = "support/soup.rs"]
mod soup;

fn sphere() -> Value {
    json!({"features": [{"id": "ball", "type": "sphere", "radius": 10}]})
}

/// A box with the three edges of one corner rounded, the patch between them
/// is a piece of a sphere with a pole on its outline.
fn rounded_corner() -> Value {
    json!({
        "features": [
            {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
                {"type": "rectangle", "id": "e0", "width": 40, "height": 40, "x": 0, "y": 0}]},
            {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 15.23,
             "operation": "new", "regions": [[0, 0, 0]]},
            {"id": "f3", "type": "fillet", "radius": 3.35, "edges": [
                {"kind": "edge", "by": "nearest", "point": [0, -20, 15.23], "body": "body1"},
                {"kind": "edge", "by": "nearest", "point": [20, 0, 15.23], "body": "body1"},
                {"kind": "edge", "by": "nearest", "point": [20, -20, 7.615], "body": "body1"}]},
        ],
        "bodyIds": {"f2:0": "body1"}
    })
}

fn findings(doc: &Value) -> Vec<Value> {
    let mut req = Map::new();
    req.insert("document".into(), doc.clone());
    let JobResult::Json(r) = printability_result(&req, &NoWatch) else { panic!("expected a JSON result") };
    assert!(r.get("error").is_none(), "{r:?}");
    r["findings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["kind"] == "meshHole" || f["kind"] == "flatTriangle")
        .cloned()
        .collect()
}

fn assert_no_flat_triangle(label: &str, raw: Value) {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{label}: {:?}", r.errors);
    let shape = &r.bodies[0].shape;

    let view = mesh::body_payload(shape, "body1", label, 0.1, viewport_profile(1));
    assert_eq!(view.indices.len() / 3, view.face_ids.len(), "{label}: one face id a triangle");
    let stl = export::export_mesh(shape, &export::mesh_options(None));
    let stl32: Vec<f32> = stl.0.iter().map(|&v| v as f32).collect();
    let (welded, welded_idx) = export::weld(&stl.0, &stl.1);
    let welded32: Vec<f32> = welded.iter().map(|&v| v as f32).collect();
    for (what, positions, indices) in
        [("viewport mesh", &view.positions, &view.indices), ("STL", &stl32, &stl.1), ("3MF", &welded32, &welded_idx)]
    {
        let flat = soup::flat_triangles(positions, indices);
        assert!(
            flat.is_empty(),
            "{label}: {} triangles without area in the {what}, the first {:?}",
            flat.len(),
            flat[0]
        );
        assert_eq!(
            soup::open_sides(positions, indices),
            0,
            "{label}: sides of the {what} not met twice, once each way"
        );
    }
    assert_eq!(soup::lost_in_seven_digits(&stl.0, &stl.1), 0, "{label}: triangles an ASCII STL writes without area");
    assert_eq!(findings(&raw), Vec::<Value>::new(), "{label}: printability mesh findings");
}

#[test]
fn a_sphere_has_no_triangle_without_area_at_its_poles() {
    assert_no_flat_triangle("sphere", sphere());
}

#[test]
fn a_corner_rounded_on_three_edges_has_no_triangle_without_area_at_its_pole() {
    assert_no_flat_triangle("rounded corner", rounded_corner());
}
