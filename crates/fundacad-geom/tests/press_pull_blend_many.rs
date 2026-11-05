//! A block with several vertical corners rounded G3, its rounds pushed together with the top they all meet: every
//! round is carried at its own radius, so the block comes out as the taller block rounded the same way. Carrying
//! only the first round left the others shrunk by the push, or rounding the old top.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const RADIUS: f64 = 37.1;
const HEIGHT: f64 = 52.132;
/// The fixture's box, tools/harness/fixtures/filleted_box.json, as half sizes.
const FIXTURE: [f64; 2] = [55.651, 33.903];
/// A box wide enough for all four corners at R37.1, which set back about one and a half radii along each wall.
const ROOMY: [f64; 2] = [90.0, 70.0];
const DIAGONAL: [[f64; 2]; 2] = [[1.0, 1.0], [-1.0, -1.0]];
const ALL: [[f64; 2]; 4] = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0]];

fn rebuild(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn body(raw: &Value) -> Shape {
    let r = rebuild(raw);
    let errors: Vec<_> = r.errors.iter().map(|e| (&e.feature_id, &e.message)).collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(r.bodies.len(), 1);
    let shape = r.bodies[0].shape.clone();
    assert!(shape.is_valid().unwrap_or(false), "a valid body");
    assert_eq!(kernel::count(&shape, Kind::Solid), 1);
    shape
}

/// The fixture's sketch, extrude and G3 fillet, on a `half` sized box `height` tall with `corners` rounded.
fn block(half: [f64; 2], height: f64, corners: &[[f64; 2]]) -> Value {
    let edges: Vec<Value> = corners
        .iter()
        .map(|[sx, sy]| json!({"kind": "edge", "by": "nearest", "point": [sx * half[0], sy * half[1], height / 2.0]}))
        .collect();
    json!({"version": 10, "parameters": {}, "features": [
        {"id": "f1", "type": "sketch", "plane": "XY", "constraints": [], "entities": [{"type": "rectangle",
            "id": "e0", "width": 2.0 * half[0], "height": 2.0 * half[1], "x": 0, "y": 0}]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": height, "operation": "new", "regions": [[0, 0, 0]]},
        {"id": "f3", "type": "fillet", "edges": edges, "radius": RADIUS, "continuity": "G3"}]})
}

fn near(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p, "body": "body1"})
}

/// The rounds at `corners` and the top, the rounds picked first or not.
fn picks(half: [f64; 2], corners: &[[f64; 2]], rounds_first: bool) -> Vec<Value> {
    // Just off the corner, inside the cut away corner, the round is the nearest face.
    let mut faces: Vec<Value> =
        corners.iter().map(|[sx, sy]| near([sx * (half[0] - 11.0), sy * (half[1] - 11.0), HEIGHT / 2.0])).collect();
    let top = near([0.0, 0.0, HEIGHT]);
    if rounds_first {
        faces.push(top);
    } else {
        faces.insert(0, top);
    }
    faces
}

fn pushed(mut raw: Value, faces: Vec<Value>, d: f64) -> Value {
    raw["features"].as_array_mut().unwrap().push(json!({"id": "push", "type": "press-pull", "face": faces,
        "distance": d, "operation": if d > 0.0 { "join" } else { "cut" }, "body": "body1"}));
    raw
}

/// The block `made` at the fixture's height with the rounds at `corners` and the top pushed `d` against the block
/// made `d` taller, in both pick orders.
fn carries_every_round(half: [f64; 2], corners: &[[f64; 2]], d: f64, made: impl Fn(f64) -> Value) {
    let want = body(&made(HEIGHT + d));
    let (v, a, n) = (kernel::volume(&want), kernel::area(&want), kernel::count(&want, Kind::Face));
    for rounds_first in [true, false] {
        let out = body(&pushed(made(HEIGHT), picks(half, corners, rounds_first), d));
        let (got, area) = (kernel::volume(&out), kernel::area(&out));
        eprintln!("{} rounds +{d} rounds first {rounds_first}: {got} against {v}", corners.len());
        assert!((got - v).abs() < 1e-5 * v, "rounds first {rounds_first}: {got} against {v}");
        assert!((area - a).abs() < 1e-5 * a, "rounds first {rounds_first}: area {area} against {a}");
        assert_eq!(kernel::count(&out, Kind::Face), n, "rounds first {rounds_first}");
    }
}

#[test]
fn two_rounds_and_the_top_pushed_seven_carry_both_rounds_up() {
    carries_every_round(FIXTURE, &DIAGONAL, 7.0, |h| block(FIXTURE, h, &DIAGONAL));
}

#[test]
fn four_rounds_and_the_top_pushed_seven_carry_every_round_up() {
    carries_every_round(ROOMY, &ALL, 7.0, |h| block(ROOMY, h, &ALL));
}

#[test]
fn rounds_of_two_radii_and_the_top_pushed_seven_carry_each_at_its_own() {
    carries_every_round(FIXTURE, &DIAGONAL, 7.0, |h| {
        let mut raw = block(FIXTURE, h, &DIAGONAL[..1]);
        raw["features"].as_array_mut().unwrap().push(json!({"id": "f4", "type": "fillet", "radius": 30.0,
            "continuity": "G3", "edges": [{"kind": "edge", "by": "nearest", "body": "body1",
            "point": [-FIXTURE[0], -FIXTURE[1], h / 2.0]}]}));
        raw
    });
}

#[test]
fn the_top_of_a_rounded_block_pushed_alone_is_unchanged() {
    // Pinned from d0b0babb1, before several rounds were carried together.
    let pinned = 1415911.0643379767;
    let out = body(&pushed(block(ROOMY, HEIGHT, &ALL), vec![near([0.0, 0.0, HEIGHT])], 7.0));
    let got = kernel::volume(&out);
    eprintln!("top alone +7: {got}");
    assert!((got - pinned).abs() < 1e-5 * pinned, "{got} against {pinned}");
}
