//! Spots in the `stress` op: a support or a load placed by a point and a radius, with no face
//! of its own. Meshes stay coarse so the debug build is quick.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::stress::stress_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Value};

/// A 100 x 10 x 10 bar along x from x = 0 to 100, y and z from -5 to 5.
fn bar() -> Value {
    json!({"features": [
        {"id": "b", "type": "box", "length": 100, "width": 10, "height": 10},
        {"id": "m", "type": "move", "dx": 50, "bodies": ["body1"]},
    ]})
}

/// A 60 x 60 plate 2 mm thick, its top at z = 1.
fn plate() -> Value {
    json!({"features": [{"id": "b", "type": "box", "length": 60, "width": 60, "height": 2}]})
}

fn face(dir: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "normal", "dir": dir})
}

fn spot(at: [f64; 3], radius: f64) -> Value {
    json!({"at": at, "radius": radius})
}

fn run(req: Value) -> Value {
    let Value::Object(m) = req else {
        panic!("a request is an object")
    };
    match stress_result(&m, &NoWatch) {
        JobResult::Json(m) => Value::Object(m),
        _ => panic!("expected a JSON result"),
    }
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn vec3(v: &Value) -> [f64; 3] {
    std::array::from_fn(|k| num(&v[k]))
}

fn error_of(v: &Value) -> String {
    v["error"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("expected an error: {v}"))
        .to_string()
}

fn balanced(r: &Value) {
    assert!(r.get("error").is_none(), "{r}");
    let applied = vec3(&r["applied"]);
    let reaction = vec3(&r["reaction"]);
    let size = applied.iter().map(|v| v * v).sum::<f64>().sqrt();
    for k in 0..3 {
        assert!(
            (applied[k] + reaction[k]).abs() < 1e-6 * size,
            "{applied:?} vs {reaction:?}"
        );
    }
}

#[test]
fn a_force_on_a_spot_bends_the_bar_like_one_on_its_end() {
    let on_end = run(json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -100]}],
        "material": "aluminium", "size": 3,
    }));
    // The same push on the top, 5 mm in from the end, with no face of its own there.
    let on_spot = run(json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "loads": [{"spots": [spot([95.0, 0.0, 5.0], 4.0)], "force": [0, 0, -100]}],
        "material": "aluminium", "size": 3,
    }));
    balanced(&on_spot);
    assert_eq!(vec3(&on_spot["applied"]), [0.0, 0.0, -100.0]);
    let (end, at_spot) = (
        num(&on_end["maxDisplacement"]["value"]),
        num(&on_spot["maxDisplacement"]["value"]),
    );
    // A load at 95 of 100 mm bends the tip about (95 / 100)^2 (3 - 0.95) / 2 as far.
    let share = 0.95f64.powi(2) * (3.0 - 0.95) / 2.0;
    assert!(
        (at_spot / end - share).abs() < 0.08,
        "{at_spot} mm on the spot, {end} mm on the end"
    );
    assert!(num(&on_spot["maxDisplacement"]["vector"][2]) < 0.0);
    // The peak is named by a face of the body, never by a spot's own id.
    let faces = 6;
    assert!(
        on_spot["maxVonMises"]["face"]
            .as_u64()
            .is_some_and(|f| f < faces),
        "{on_spot}"
    );
}

#[test]
fn a_fixed_spot_holds_the_bar() {
    let r = run(json!({
        "document": bar(), "body": "body1",
        "supports": [{"type": "fixed", "spots": spot([0.0, 0.0, 0.0], 4.0)}],
        "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -10]}],
        "material": "aluminium", "size": 3,
    }));
    balanced(&r);
    // Held on a patch of its end and not the whole of it, the bar bends further.
    let whole = run(json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -10]}],
        "material": "aluminium", "size": 3,
    }));
    assert!(
        num(&r["maxDisplacement"]["value"]) > num(&whole["maxDisplacement"]["value"]),
        "{r}"
    );
    let w = r["warnings"].to_string();
    assert!(w.contains("where a fixed spot ends"), "{w}");
}

#[test]
fn a_spot_on_a_thin_plate_stays_on_its_side() {
    // A pressure on a spot of the top: were the spot to reach the underside 2 mm below, the
    // two pushes would cancel.
    let r = run(json!({
        "document": plate(), "body": "body1",
        "fixed": [face([1.0, 0.0, 0.0]), face([-1.0, 0.0, 0.0])],
        "loads": [{"spots": [spot([0.0, 0.0, 1.0], 6.0)], "pressure": 1}],
        "material": "PLA", "size": 1.5,
    }));
    balanced(&r);
    let applied = vec3(&r["applied"]);
    let disc = std::f64::consts::PI * 36.0;
    assert!(
        applied[2] < -0.6 * disc && applied[2] > -1.4 * disc,
        "{applied:?} for a disc of {disc} mm2"
    );
    assert!(
        applied[0].abs() < 0.05 * disc && applied[1].abs() < 0.05 * disc,
        "{applied:?}"
    );
}

#[test]
fn a_spot_and_the_face_under_it_both_carry_their_loads() {
    let r = run(json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "loads": [
            {"faces": [face([0.0, 0.0, 1.0])], "force": [0, 0, -10]},
            {"spots": [spot([50.0, 0.0, 5.0], 4.0)], "force": [0, 0, -5]},
            {"faces": [face([0.0, 0.0, 1.0])], "pressure": 0.01},
        ],
        "material": "aluminium", "size": 3,
    }));
    balanced(&r);
    // 10 N and 5 N, and 0.01 MPa on the whole 100 x 10 top.
    let applied = vec3(&r["applied"]);
    assert!((applied[2] + 25.0).abs() < 1e-6 * 25.0, "{applied:?}");
}

#[test]
fn a_spot_smaller_than_the_elements_is_warned_about() {
    let r = run(json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "loads": [{"spots": [spot([95.0, 0.0, 5.0], 0.2)], "force": [0, 0, -10]}],
        "material": "aluminium", "size": 3,
    }));
    balanced(&r);
    let w = r["warnings"].to_string();
    assert!(
        w.contains("spot 1 of load 1 (loads[0]) (radius 0.200 mm) is smaller than the elements"),
        "{w}"
    );
}

#[test]
fn the_spot_refusals_say_why() {
    let base = |patch: Value| {
        let mut req = json!({
            "document": bar(), "body": "body1",
            "fixed": [face([-1.0, 0.0, 0.0])],
            "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -10]}],
            "material": "aluminium", "size": 3,
        });
        for (k, v) in patch.as_object().unwrap() {
            req[k] = v.clone();
        }
        error_of(&run(req))
    };
    let off =
        base(json!({"loads": [{"spots": [spot([50.0, 0.0, 40.0], 3.0)], "force": [0, 0, -1]}]}));
    assert!(
        off.contains("spot 1 of load 1 (loads[0]) is not on body1")
            && off.contains("place it on the body again"),
        "{off}"
    );
    let slider = base(
        json!({"supports": [{"type": "slider", "faces": face([0.0, 0.0, -1.0]),
                                           "spots": [spot([0.0, 0.0, 0.0], 3.0)]}]}),
    );
    assert!(
        slider.contains("support 1 (supports[0]) is slider and has spots"),
        "{slider}"
    );
    let radius =
        base(json!({"loads": [{"spots": [{"at": [95, 0, 5], "radius": 0}], "force": [0, 0, -1]}]}));
    assert!(
        radius.contains(
            "the radius of loads[0].spots[0] of load 1 (loads[0]) must be a number above 0"
        ),
        "{radius}"
    );
    let shape = base(json!({"loads": [{"spots": [{"point": [95, 0, 5]}], "force": [0, 0, -1]}]}));
    assert!(shape.contains("must be {at, radius}"), "{shape}");
    let none = base(json!({"loads": [{"force": [0, 0, -1]}]}));
    assert!(
        none.contains(
            "load 1 (loads[0]) has no faces, give the faces it pushes on, or spots to push at"
        ),
        "{none}"
    );
}

#[test]
fn a_spot_on_a_wall_one_element_thick_starts_on_the_side_it_was_put_on() {
    // A 2 mm plate meshed at 2 mm, as thin as the mesher takes: the pressure still pushes
    // down from the top, wherever the triangle centres happen to fall.
    for at in [[0.0, 0.0, 1.0], [7.3, -4.1, 1.0], [-11.0, 9.5, 1.0]] {
        let r = run(json!({
            "document": plate(), "body": "body1",
            "fixed": [face([1.0, 0.0, 0.0]), face([-1.0, 0.0, 0.0])],
            "loads": [{"spots": [spot(at, 8.0)], "pressure": 1}],
            "material": "PLA", "size": 2,
        }));
        balanced(&r);
        let applied = vec3(&r["applied"]);
        assert!(applied[2] < -100.0, "{applied:?} for a spot at {at:?}");
    }
}
