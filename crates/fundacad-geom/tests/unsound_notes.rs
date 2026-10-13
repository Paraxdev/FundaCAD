//! What a build says of a solid body that is not closed and facing outward:
//! a note on the feature that brought it in, once, worded for a person. No
//! volume check sees such a body, and every cut, join and measurement after
//! it can come out wrong without failing.

mod unsound;

use fundacad_geom::builder::Rebuild;
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};
use unsound::{casing, inside_out, one_face_missing, one_face_turned, one_face_twice, shell_alone, sound, Edit};

const CODES: [&str; 4] = ["openShell", "nonManifold", "flippedFaces", "insideOut"];

fn build(edit: Edit) -> Rebuild {
    unsound::build(json!([casing(edit)]))
}

fn fault_notes(r: &Rebuild) -> Vec<&Value> {
    r.diagnostics.iter().filter(|d| CODES.iter().any(|c| d["code"] == *c)).collect()
}

/// The one fault note of the build, which has to carry `code`.
fn the_note<'a>(r: &'a Rebuild, code: &str) -> &'a str {
    let found = fault_notes(r);
    assert_eq!(found.len(), 1, "one note, got {:?}", r.diagnostics);
    assert_eq!(found[0]["code"], code, "{}", found[0]);
    assert_eq!(found[0]["feature_id"], "imp", "{}", found[0]);
    assert_eq!(found[0]["lossy"], json!(false), "it is advice, not a selector that drifted");
    found[0]["reason"].as_str().expect("worded")
}

#[test]
fn a_sound_solid_gets_no_note() {
    let r = build(sound);
    assert!(fault_notes(&r).is_empty(), "{:?}", r.diagnostics);
}

#[test]
fn the_build_says_a_solid_is_inside_out() {
    let r = build(inside_out);
    assert!(kernel::volume(&r.bodies[0].shape) < 0.0, "the fixture is not inside out");
    assert_eq!(
        the_note(&r, "insideOut"),
        "Casing is inside out, its faces point into the material, so a cut, a join or a measurement of it can come out wrong"
    );
}

#[test]
fn the_build_says_a_solid_has_faces_turned_the_wrong_way() {
    let r = build(one_face_turned);
    assert_eq!(
        the_note(&r, "flippedFaces"),
        "Casing has faces that point the wrong way, at 4 of its edges the two faces disagree about which side is inside"
    );
}

#[test]
fn the_build_says_an_edge_bounds_more_than_two_faces() {
    let r = build(one_face_twice);
    assert_eq!(
        the_note(&r, "nonManifold"),
        "Casing is not one clean solid, 4 of its edges are shared by more than two faces, so it has no single inside"
    );
}

#[test]
fn the_build_says_a_solid_is_open() {
    let r = build(one_face_missing);
    assert_eq!(
        the_note(&r, "openShell"),
        "Casing is not a closed solid, 4 of its edges bound only one face, so it has no inside"
    );
}

/// A surface is a state the app models with on purpose (an import that does
/// not close, what thicken starts from), so the build does not call it a fault.
#[test]
fn the_build_does_not_call_a_surface_body_a_fault() {
    let r = build(shell_alone);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 0, "the fixture is a surface");
    assert!(fault_notes(&r).is_empty(), "{:?}", r.diagnostics);
}

/// A later feature that leaves the body as it found it does not repeat the note.
#[test]
fn a_fault_is_said_once_on_the_feature_that_brought_it() {
    for (edit, code) in [(inside_out as Edit, "insideOut"), (one_face_turned, "flippedFaces")] {
        let r = unsound::build(json!([
            casing(edit),
            {"id": "mv", "type": "move", "dx": 3, "bodies": ["body1"]},
            {"id": "dup", "type": "box", "length": 4, "width": 4, "height": 4},
            {"id": "mv2", "type": "move", "dz": 30, "bodies": ["body1"]},
        ]));
        the_note(&r, code);
    }
}
