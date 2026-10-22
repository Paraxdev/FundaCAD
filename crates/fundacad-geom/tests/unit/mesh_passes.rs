use fundacad_geom::mesh::passes::*;
use fundacad_geom::mesh::Tessellation;
use serde_json::{json, Value};

#[test]
fn a_displaced_face_lands_in_order_under_its_own_id() {
    let mut out = Tessellation {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        indices: vec![0, 1, 2],
        face_ids: vec![0],
        normals: Some(vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
    };
    let m = FaceMesh {
        positions: vec![0.0, 0.0, 2.0, 1.0, 0.0, 2.0, 0.0, 1.0, 2.0, 1.0, 1.0, 2.0],
        indices: vec![0, 1, 2, 1, 3, 2],
        normals: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
    };
    append(&mut out, 1, &m, true);
    assert_eq!(out.face_ids, vec![0, 1, 1]);
    assert_eq!(out.indices, vec![0, 1, 2, 3, 4, 5, 4, 6, 5]);
    assert_eq!(out.normals.as_ref().map(Vec::len), Some(out.positions.len()));
}

#[test]
fn color_slots_only_when_a_face_carries_one() {
    let a = json!({"pass": "p"});
    let b = json!({"pass": "p", "colorSlot": 2});
    assert_eq!(face_color_slots(3, |k| (k == 1).then_some(&a)), None);
    assert_eq!(face_color_slots(3, |k| (k == 2).then_some(&b)), Some(vec![Value::Null, Value::Null, json!(2)]));
}
