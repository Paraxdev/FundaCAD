//! Press/pull of a G3 fillet blend on a box's vertical corner changes its radius as a refillet would: the blend
//! stays tangent to both walls and nothing grows past their planes. It used to be swept out as a slab along its
//! centre normal, which stood proud of both box sides. Pushed together with a wall it meets, the round keeps
//! its radius.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::axis_push::face_axis_result;
use fundacad_geom::features::blend::ops::dihedral_deg;
use fundacad_geom::kernel::{self, Kind};
use fundacad_protocol::JobResult;
use opencascade::primitives::{Shape, ShapeType, SurfaceType};
use serde_json::{json, Value};

const FILLETED_BOX: &str = include_str!("../../../tools/harness/fixtures/filleted_box.json");

const BLEND: [f64; 3] = [43.59, 24.29, 34.75];
const RADIUS: f64 = 37.1;
const X_WALL: f64 = 55.651;
const Y_WALL: f64 = 33.903;

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

fn filleted() -> Value {
    serde_json::from_str(FILLETED_BOX).expect("the filleted box")
}

/// The fixture filleted at `radius` from the start.
fn filleted_at(radius: f64) -> Value {
    let mut raw = filleted();
    raw["features"][2]["radius"] = json!(radius);
    raw
}

fn pushed(d: f64) -> Value {
    let mut raw = filleted();
    raw["features"].as_array_mut().unwrap().push(json!({"id": "push", "type": "press-pull",
        "face": {"kind": "face", "by": "nearest", "point": BLEND, "body": "body1"},
        "distance": d, "operation": if d > 0.0 { "join" } else { "cut" }, "body": "body1"}));
    raw
}

fn blend(shape: &Shape) -> Shape {
    let faces: Vec<Shape> = kernel::subshapes(shape, Kind::Face)
        .into_iter()
        .filter(|f| f.as_face().is_some_and(|g| g.surface_type() == SurfaceType::BSplineSurface))
        .collect();
    assert_eq!(faces.len(), 1, "one freeform blend");
    faces[0].clone()
}

/// The blend meets each wall smoothly along its whole seam.
fn tangent_to_walls(shape: &Shape) {
    let face = blend(shape);
    let mut smooth = 0;
    for e in face.shape_map(ShapeType::Edge).iter() {
        let a = dihedral_deg(shape, &e).expect("a dihedral");
        // The kernel gives a smooth edge as 0 or 180 by how its faces are oriented.
        if a.min(180.0 - a) < 0.5 {
            smooth += 1;
        }
    }
    assert_eq!(smooth, 2, "the blend runs smoothly into both walls");
}

fn inside_the_walls(shape: &Shape) {
    let b = kernel::bbox(shape).expect("a box");
    assert!(b[3] <= X_WALL + 1e-4, "past the x wall: {b:?}");
    assert!(b[4] <= Y_WALL + 1e-4, "past the y wall: {b:?}");
}

fn regrows_as_refillet(d: f64, radius: f64) {
    let out = body(&pushed(d));
    tangent_to_walls(&out);
    inside_the_walls(&out);
    let want = body(&filleted_at(radius));
    let (got, want) = (kernel::volume(&out), kernel::volume(&want));
    assert!((got - want).abs() < 1e-5 * want, "d {d}: {got} against R{radius} {want}");
    assert_eq!(kernel::count(&out, Kind::Face), kernel::count(&body(&filleted()), Kind::Face));
}

#[test]
fn pushing_the_blend_in_grows_its_radius_tangent_to_the_walls() {
    regrows_as_refillet(-8.0, RADIUS + 8.0);
}

#[test]
fn pulling_the_blend_out_shrinks_its_radius_tangent_to_the_walls() {
    regrows_as_refillet(8.0, RADIUS - 8.0);
}

#[test]
fn the_blend_is_offered_as_a_round_of_its_fillet_radius() {
    let req = json!({"document": filleted(), "body": "body1",
                     "face": {"kind": "face", "by": "nearest", "point": BLEND}});
    let JobResult::Json(got) = face_axis_result(req.as_object().unwrap(), &NoWatch) else {
        panic!("a json reply");
    };
    let r = &got["resize"];
    assert_eq!(r["kind"], json!("cylinder"), "{got:?}");
    assert!((r["size"].as_f64().unwrap() - RADIUS).abs() < 1e-3, "{got:?}");
    // An outside corner: a larger radius takes material off, as a bore growing does.
    assert_eq!(r["concave"], json!(true), "{got:?}");
    assert_eq!(r["full"], json!(false), "{got:?}");
    assert_eq!(r["axis"]["origin"][0].as_f64().map(|x| (x - X_WALL).abs() < 1e-4), Some(true), "{got:?}");
    assert_eq!(r["axis"]["origin"][1].as_f64().map(|y| (y - Y_WALL).abs() < 1e-4), Some(true), "{got:?}");
}

const HEIGHT: f64 = 52.132;
const TOP: [f64; 3] = [0.0, 0.0, HEIGHT];
const X_SIDE: [f64; 3] = [X_WALL, -30.0, 10.0];
const Y_SIDE: [f64; 3] = [-30.0, Y_WALL, 10.0];

fn near(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p, "body": "body1"})
}

/// The blend and the wall at `wall` pushed `d` in one Press/Pull, the blend picked first or second.
fn with_wall(wall: [f64; 3], d: f64, blend_first: bool) -> Value {
    let mut faces = vec![near(BLEND), near(wall)];
    if !blend_first {
        faces.reverse();
    }
    let mut raw = filleted();
    raw["features"].as_array_mut().unwrap().push(json!({"id": "push", "type": "press-pull", "face": faces,
        "distance": d, "operation": if d > 0.0 { "join" } else { "cut" }, "body": "body1"}));
    raw
}

/// The fixture's box made `dx` wider at its x wall, `dy` at its y wall and `dz` taller, filleted G3 at its own
/// radius.
fn direct(dx: f64, dy: f64, dz: f64) -> Value {
    let mut raw = filleted();
    let rect = &mut raw["features"][0]["entities"][0];
    rect["width"] = json!(2.0 * X_WALL + dx);
    rect["x"] = json!(dx / 2.0);
    rect["height"] = json!(2.0 * Y_WALL + dy);
    rect["y"] = json!(dy / 2.0);
    raw["features"][1]["distance"] = json!(HEIGHT + dz);
    raw["features"][2]["edges"]["point"] = json!([X_WALL + dx, Y_WALL + dy, (HEIGHT + dz) / 2.0]);
    raw
}

fn carries_the_round(wall: [f64; 3], d: f64, [dx, dy, dz]: [f64; 3]) {
    let want = body(&direct(dx, dy, dz));
    let (v, a) = (kernel::volume(&want), kernel::area(&want));
    for blend_first in [true, false] {
        let out = body(&with_wall(wall, d, blend_first));
        tangent_to_walls(&out);
        let b = kernel::bbox(&out).expect("a box");
        assert!(b[3] <= X_WALL + dx + 1e-4 && b[4] <= Y_WALL + dy + 1e-4 && b[5] <= HEIGHT + dz + 1e-4, "{b:?}");
        let (got, area) = (kernel::volume(&out), kernel::area(&out));
        eprintln!("{wall:?} {d} blend first {blend_first}: {got} against {v}");
        assert!((got - v).abs() < 1e-5 * v, "{wall:?} {d}: {got} against {v}");
        assert!((area - a).abs() < 1e-5 * a, "{wall:?} {d}: area {area} against {a}");
        assert_eq!(kernel::count(&out, Kind::Face), kernel::count(&want, Kind::Face), "{wall:?} {d}");
    }
}

#[test]
fn the_blend_and_top_pushed_half_a_millimetre_carry_the_round_up() {
    carries_the_round(TOP, 0.5, [0.0, 0.0, 0.5]);
}

#[test]
fn the_blend_and_top_pushed_three_millimetres_carry_the_round_up() {
    carries_the_round(TOP, 3.0, [0.0, 0.0, 3.0]);
}

#[test]
fn the_blend_and_top_pushed_seven_millimetres_carry_the_round_up() {
    carries_the_round(TOP, 7.0, [0.0, 0.0, 7.0]);
}

#[test]
fn the_blend_and_the_side_wall_it_meets_carry_the_round_out() {
    carries_the_round(X_SIDE, 3.0, [3.0, 0.0, 0.0]);
}

#[test]
fn the_blend_and_the_other_side_wall_it_meets_carry_the_round_out() {
    carries_the_round(Y_SIDE, 3.0, [0.0, 3.0, 0.0]);
}

#[test]
fn a_wall_pushed_in_too_far_for_the_carried_round_is_refused_saying_why() {
    let r = rebuild(&with_wall(Y_SIDE, -20.0, true));
    let errors: Vec<&str> = r.errors.iter().map(|e| e.message.as_str()).collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("R37.1") && errors[0].contains("runs off the face"), "{errors:?}");
}

#[test]
fn a_radius_too_large_for_the_walls_is_refused_saying_why() {
    let r = rebuild(&pushed(-14.0));
    let errors: Vec<&str> = r.errors.iter().map(|e| e.message.as_str()).collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("R51.1") && errors[0].contains("runs off the face"), "{errors:?}");
}

#[test]
fn a_kept_blend_is_the_one_a_fresh_search_finds() {
    use fundacad_geom::features::regrow::{blend_of, forget, regrow};
    let r = rebuild(&filleted());
    let (part, id) = (r.bodies[0].shape.clone(), Some(r.bodies[0].identity));
    let face = blend(&part);
    forget();
    let fresh = blend_of(&part, &face, id).expect("the blend");
    // A rebuild resumed from RAM hands the next tick a copy of the same body.
    let copy = kernel::copy_topology(&part).expect("a copy");
    let kept = blend_of(&copy, &blend(&copy), id).expect("the blend");
    assert!(kept.corner.is_same(&fresh.corner), "the copy is answered from what was kept");
    let again = blend_of(&part, &face, None).expect("the blend");
    assert!(!again.corner.is_same(&fresh.corner), "no identity, no keeping");
    for b in [&kept, &again] {
        assert_eq!((b.radius, b.continuity, b.concave), (fresh.radius, fresh.continuity, fresh.concave));
        assert_eq!(b.axis, fresh.axis);
        assert_eq!(kernel::volume(&b.corner), kernel::volume(&fresh.corner));
    }
    for d in [3.0, -5.0, 3.0] {
        let cached = regrow(&copy, &blend(&copy), d, id).expect("a blend").expect("a refillet");
        let uncached = regrow(&part, &face, d, None).expect("a blend").expect("a refillet");
        assert_eq!(kernel::volume(&cached), kernel::volume(&uncached), "d {d}");
        assert_eq!(kernel::area(&cached), kernel::area(&uncached), "d {d}");
        assert_eq!(kernel::count(&cached, Kind::Face), kernel::count(&uncached, Kind::Face));
    }
}
