//! A body's rebuild payload says why it is not a sound solid, in the words
//! inspect uses, so the app can say so in place of a volume and a mass.

#[allow(dead_code)]
mod unsound;

use fundacad_geom::builder::NoWatch;
use fundacad_geom::reply;
use fundacad_protocol::{JobResult, WireBody};
use serde_json::{json, Map, Value};
use unsound::{casing, inside_out, one_face_missing, one_face_turned, one_face_twice, shell_alone, sound, Edit};

fn payload(edit: Edit) -> Map<String, Value> {
    let r = unsound::build(json!([casing(edit)]));
    let JobResult::Mesh(m) = reply::mesh_result(&r.bodies, 0.1, &Map::new(), &NoWatch) else {
        panic!("a mesh result");
    };
    match m.bodies.into_iter().next() {
        Some(WireBody::Full(b)) => b.fields,
        other => panic!("a full body, got {other:?}"),
    }
}

fn fault(edit: Edit) -> String {
    let p = payload(edit);
    p.get("fault").and_then(Value::as_str).unwrap_or_else(|| panic!("no fault in {:?}", p.keys().collect::<Vec<_>>())).to_owned()
}

#[test]
fn a_sound_body_carries_no_fault() {
    let p = payload(sound);
    assert!(!p.contains_key("fault"), "{:?}", p.get("fault"));
    let keys: Vec<&str> = p.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["id", "name", "etag", "positions", "indices", "faceIds", "faceOwners", "edges", "faceCount", "bbox", "normals"],
        "a sound body's payload keeps its keys"
    );
}

#[test]
fn an_open_body_says_it_is_not_closed() {
    assert_eq!(fault(one_face_missing), "is not a closed solid, 4 of its edges bound only one face, so it has no inside");
}

#[test]
fn a_body_with_an_edge_on_more_than_two_faces_says_so() {
    assert_eq!(
        fault(one_face_twice),
        "is not one clean solid, 4 of its edges are shared by more than two faces, so it has no single inside"
    );
}

#[test]
fn a_body_whose_faces_disagree_says_so() {
    assert_eq!(
        fault(one_face_turned),
        "has faces that point the wrong way, at 4 of its edges the two faces disagree about which side is inside"
    );
}

#[test]
fn an_inside_out_body_says_so() {
    assert_eq!(fault(inside_out), "is inside out, its faces point into the material");
}

#[test]
fn a_surface_says_it_has_no_inside() {
    assert_eq!(fault(shell_alone), "is a surface, not a solid, so it has no inside");
}
