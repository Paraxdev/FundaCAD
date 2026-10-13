//! An analysis of a body that is not closed solids facing outward: an
//! inside-out solid, one with a face turned the wrong way, an edge on three
//! faces, a hole in its skin, or no solid at all. The kernel's common of such
//! a body comes back without an error and wrong, so each analysis either
//! turns it over and answers, or says it could not judge it and why.
//!
//! The box beside the casing is the same cube moved 5 mm along each axis, so
//! the two share the 5 mm cube at the corner.

mod unsound;

use fundacad_geom::builder::{NoWatch, Rebuild};
use fundacad_geom::inspect::{self, InspectBody};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::printcheck::op::printability_result;
use fundacad_geom::stress::stress_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};
use unsound::{casing, inside_out, one_face_missing, one_face_turned, one_face_twice, shell_alone, sound, Edit};

const SHARED: f64 = 125.0;

fn features(edit: Edit) -> Value {
    json!([
        casing(edit),
        {"id": "blk", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "corner", "type": "move", "dx": 5, "dy": 5, "dz": 5, "bodies": ["body2"]},
    ])
}

fn build(edit: Edit) -> Rebuild {
    let r = unsound::build(features(edit));
    assert_eq!(r.bodies.len(), 2);
    r
}

fn check(r: &Rebuild) -> Map<String, Value> {
    inspect::interference(&r.bodies, Some(1.0), inspect::MAX_INTERFERENCE_OPS, &NoWatch)
}

fn overlaps(reply: &Map<String, Value>) -> Vec<f64> {
    reply["pairs"].as_array().expect("pairs").iter().map(|p| p["volume"].as_f64().expect("volume")).collect()
}

/// Why the check did not judge body1.
fn not_judged(reply: &Map<String, Value>) -> String {
    let rows = reply.get("unchecked").and_then(Value::as_array);
    let row = rows.and_then(|rows| rows.iter().find(|u| u["id"] == "body1"));
    let row = row.unwrap_or_else(|| panic!("nothing says body1 was not judged: {reply:?}"));
    assert_eq!(row["name"], "Casing");
    assert_eq!(reply["uncheckedPairs"], json!(1));
    assert!(overlaps(reply).is_empty(), "a pair it could not test is reported: {reply:?}");
    assert_eq!(reply["clearances"], json!([]), "nor is it called a near miss");
    row["reason"].as_str().expect("worded").to_owned()
}

#[test]
fn a_sound_cube_overlaps_the_box_by_the_corner_they_share() {
    let reply = check(&build(sound));
    let found = overlaps(&reply);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!((found[0] - SHARED).abs() < 1e-6, "{found:?}");
    assert!(reply.get("unchecked").is_none(), "{:?}", reply.get("unchecked"));
}

#[test]
fn an_inside_out_solid_is_turned_over_and_its_overlap_found() {
    let r = build(inside_out);
    assert!(kernel::volume(&r.bodies[0].shape) < 0.0, "the fixture is not inside out");
    let reply = check(&r);
    let found = overlaps(&reply);
    assert_eq!(found.len(), 1, "no overlap found: {reply:?}");
    assert!((found[0] - SHARED).abs() < 1e-6, "{found:?}");
    assert!(reply.get("unchecked").is_none(), "{:?}", reply.get("unchecked"));
    // The body in the model is left as the file has it.
    assert!(kernel::volume(&r.bodies[0].shape) < 0.0);
}

#[test]
fn a_solid_with_a_face_turned_the_wrong_way_is_not_called_clear() {
    let r = build(one_face_turned);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 1);
    assert_eq!(kernel::open_edge_count(&r.bodies[0].shape), 0, "the fixture is closed");
    let why = not_judged(&check(&r));
    assert_eq!(
        why,
        "has faces that point the wrong way, at 4 of its edges the two faces disagree about which side is inside"
    );
}

#[test]
fn an_edge_on_three_faces_is_not_called_clear() {
    let why = not_judged(&check(&build(one_face_twice)));
    assert!(why.contains("4 of its edges are shared by more than two faces"), "{why}");
}

#[test]
fn an_open_solid_is_not_called_clear() {
    let why = not_judged(&check(&build(one_face_missing)));
    assert!(why.contains("is not a closed solid, 4 of its edges bound only one face"), "{why}");
}

#[test]
fn a_surface_body_is_not_called_clear() {
    let r = build(shell_alone);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 0, "the fixture is a surface");
    let why = not_judged(&check(&r));
    assert!(why.contains("is a surface, not a solid"), "{why}");
}

/// A body nothing comes near was not left untested: its box clears the rest.
#[test]
fn a_body_that_reaches_no_other_is_not_listed() {
    let r = unsound::build(json!([
        casing(one_face_turned),
        {"id": "blk", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "away", "type": "move", "dx": -40, "bodies": ["body2"]},
    ]));
    let reply = check(&r);
    assert!(reply.get("unchecked").is_none(), "{reply:?}");
    assert!(overlaps(&reply).is_empty());
}

fn inspected(r: &Rebuild) -> Value {
    let body = &r.bodies[0];
    let asked = [InspectBody { id: json!(body.id), name: json!(body.name), shape: Some(&body.shape) }];
    inspect::inspect_bodies(&asked, false, 0, 0).expect("inspected").remove(0)
}

/// inspect gives no volume for a body it cannot measure one of, and says why.
#[test]
fn inspect_gives_no_volume_where_there_is_none_to_trust() {
    for (edit, word) in [
        (one_face_turned as Edit, "wrong way"),
        (one_face_twice, "more than two faces"),
        (one_face_missing, "not a closed solid"),
        (shell_alone, "a surface"),
    ] {
        let report = inspected(&build(edit));
        assert!(report["volume"].is_null(), "{word}: volume {}", report["volume"]);
        assert!(report["fault"].as_str().is_some_and(|f| f.contains(word)), "{word}: {}", report["fault"]);
    }
    let report = inspected(&build(inside_out));
    assert_eq!(report["volume"], json!(1000.0), "what its skin encloses");
    assert_eq!(report["insideOut"], json!(true));
    assert!(report.get("fault").is_none());
    let report = inspected(&build(sound));
    assert_eq!(report["volume"], json!(1000.0));
    assert!(report.get("fault").is_none() && report.get("insideOut").is_none(), "{report}");
}

fn stress_refusal(edit: Edit) -> String {
    let face = |x: f64| json!({"kind": "face", "by": "normal", "dir": [x, 0.0, 0.0]});
    let req = json!({
        "document": {"parameters": {}, "features": [casing(edit)]}, "body": "body1",
        "fixed": face(-1.0),
        "loads": [{"faces": face(1.0), "force": [0, 0, -1]}],
        "size": 3,
    });
    let Value::Object(m) = req else { unreachable!() };
    let JobResult::Json(reply) = stress_result(&m, &NoWatch) else { panic!("expected a JSON result") };
    reply["error"]["message"].as_str().unwrap_or_else(|| panic!("the analysis ran: {reply:?}")).to_owned()
}

#[test]
fn stress_refuses_a_body_with_no_dependable_inside() {
    let why = stress_refusal(one_face_turned);
    assert!(why.starts_with("body1 has faces that point the wrong way"), "{why}");
    let why = stress_refusal(one_face_twice);
    assert!(why.starts_with("body1 is not one clean solid"), "{why}");
    let why = stress_refusal(inside_out);
    assert!(why.starts_with("body1 is inside out, its faces point into the material"), "{why}");
}

#[test]
fn printability_says_a_body_is_not_a_sound_solid() {
    let req = json!({"document": {"parameters": {}, "features": [casing(one_face_turned)]}});
    let Value::Object(m) = req else { unreachable!() };
    let JobResult::Json(reply) = printability_result(&m, &NoWatch) else { panic!("expected a JSON result") };
    assert!(reply.get("error").is_none(), "{reply:?}");
    let report = reply["report"].as_str().expect("report");
    assert!(
        report.contains("not a sound solid: it has faces that point the wrong way, at 4 of its edges"),
        "{report}"
    );
    assert!(reply["bodies"][0]["fault"].as_str().is_some_and(|f| f.contains("wrong way")), "{}", reply["bodies"][0]);
}
