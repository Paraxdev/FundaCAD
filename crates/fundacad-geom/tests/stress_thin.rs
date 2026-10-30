//! Parts with walls about one element thick under the automatic element size: a thin plate with four hollow
//! standoffs, held on a side or inside two bores and pushed on two standoff tops.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::stress::{stress_result_with, StressLimits, MAX_ELEMENTS};
use fundacad_protocol::JobResult;
use serde_json::{json, Value};

const LENGTH: f64 = 66.0;
const WIDTH: f64 = 52.0;
const PLATE: f64 = 2.0;
const OUTER: f64 = 3.0;
const BORE: f64 = 1.7;
const HEIGHT: f64 = 8.0;
const AT: [[f64; 2]; 4] = [[-29.0, -21.0], [29.0, -21.0], [29.0, 21.0], [-29.0, 21.0]];

fn json_of(r: JobResult) -> Value {
    match r {
        JobResult::Json(m) => Value::Object(m),
        _ => panic!("expected a JSON result"),
    }
}

fn run(req: Value) -> Value {
    let Value::Object(m) = req else { panic!("a request is an object") };
    json_of(stress_result_with(&m, &NoWatch, &StressLimits { refine_seconds: f64::INFINITY, ..Default::default() }))
}

/// A plate centred on the origin from z = -1 to 1, with four tubes standing on it to z = HEIGHT and bored through
/// the plate.
fn standoff_plate() -> Value {
    let mut features = vec![json!({"id": "plate", "type": "box", "length": LENGTH, "width": WIDTH, "height": PLATE})];
    for (i, [x, y]) in AT.iter().enumerate() {
        let body = format!("body{}", i + 2);
        features.push(json!({"id": format!("s{i}"), "type": "cylinder", "radius": OUTER, "height": HEIGHT}));
        features.push(
            json!({"id": format!("sm{i}"), "type": "move", "dx": x, "dy": y, "dz": HEIGHT / 2.0, "bodies": [body]}),
        );
    }
    features.push(json!({"id": "join", "type": "boolean", "operation": "union", "target": "body1",
        "tools": ["body2", "body3", "body4", "body5"]}));
    for (i, [x, y]) in AT.iter().enumerate() {
        let body = format!("body{}", i + 6);
        features.push(json!({"id": format!("b{i}"), "type": "cylinder", "radius": BORE, "height": 3.0 * HEIGHT}));
        features.push(json!({"id": format!("bm{i}"), "type": "move", "dx": x, "dy": y, "bodies": [body]}));
    }
    features.push(json!({"id": "bore", "type": "boolean", "operation": "subtract", "target": "body1",
        "tools": ["body6", "body7", "body8", "body9"]}));
    json!({ "features": features })
}

fn nearest(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p})
}

fn top(i: usize) -> Value {
    nearest([AT[i][0] + 0.5 * (OUTER + BORE), AT[i][1], HEIGHT])
}

fn bore(i: usize) -> Value {
    nearest([AT[i][0] + BORE, AT[i][1], HEIGHT / 2.0])
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn vec3(v: &Value) -> [f64; 3] {
    std::array::from_fn(|k| num(&v[k]))
}

fn sane(r: &Value) {
    assert!(r.get("error").is_none(), "{}", r["error"]);
    let peak = num(&r["maxVonMises"]["value"]);
    let moved = num(&r["maxDisplacement"]["value"]);
    assert!(peak.is_finite() && peak > 0.0, "{peak}");
    assert!(moved.is_finite() && moved > 0.0, "{moved}");
    assert!(num(&r["mesh"]["elements"]) <= MAX_ELEMENTS as f64, "{}", r["mesh"]);
    let warnings = r["warnings"].as_array().map_or(&[][..], |w| w.as_slice());
    assert!(!warnings.iter().any(|w| w.as_str().is_some_and(|w| w.contains("grew"))), "{warnings:?}");
    let applied = vec3(&r["applied"]);
    let reaction = vec3(&r["reaction"]);
    let size = applied.iter().map(|v| v * v).sum::<f64>().sqrt();
    for k in 0..3 {
        assert!((applied[k] + reaction[k]).abs() < 1e-6 * size, "{applied:?} vs {reaction:?}");
    }
}

#[test]
fn a_plate_held_on_its_side_and_pushed_on_two_standoffs_meshes_by_itself() {
    sane(&run(json!({
        "document": standoff_plate(), "body": "body1",
        "fixed": [nearest([-LENGTH / 2.0, 0.0, 0.0])],
        "loads": [{"faces": [top(1), top(2)], "force": [0, 0, -20]}],
        "material": "PLA",
    })));
}

#[test]
fn a_plate_held_in_two_bores_and_pushed_on_the_other_standoffs_meshes_by_itself() {
    sane(&run(json!({
        "document": standoff_plate(), "body": "body1",
        "fixed": [bore(0), bore(3)],
        "loads": [{"faces": [top(1), top(2)], "force": [0, 0, -20]}],
        "material": "PLA",
    })));
}

const BLOCK: [f64; 3] = [20.0, 20.0, 20.0];
const RIB: f64 = 1.0;
const RISE: f64 = 1.0;
// A fixed face needs two rows of nodes to stop the body turning, so it comes back at a wider rib than a load does.
const HELD_RIB: f64 = 1.2;

/// A block with one low narrow rib across its top, so the top of the rib is a small face on a coarse mesh.
fn ribbed_block(rib: f64) -> Value {
    json!({ "features": [
        {"id": "block", "type": "box", "length": BLOCK[0], "width": BLOCK[1], "height": BLOCK[2]},
        {"id": "rib", "type": "box", "length": rib, "width": BLOCK[1], "height": 2.0 * RISE},
        {"id": "ribm", "type": "move", "dz": BLOCK[2] / 2.0, "bodies": ["body2"]},
        {"id": "join", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]},
    ]})
}

fn rib_top() -> Value {
    nearest([0.0, 0.0, BLOCK[2] / 2.0 + RISE])
}

#[test]
fn a_narrow_loaded_face_gets_a_finer_mesh_by_itself() {
    sane(&run(json!({
        "document": ribbed_block(RIB), "body": "body1",
        "fixed": [nearest([-BLOCK[0] / 2.0, 0.0, 0.0])],
        "loads": [{"faces": [rib_top()], "force": [0, 0, -20]}],
        "material": "PLA",
    })));
}

#[test]
fn a_narrow_fixed_face_gets_a_finer_mesh_by_itself() {
    sane(&run(json!({
        "document": ribbed_block(HELD_RIB), "body": "body1",
        "fixed": [rib_top()],
        "loads": [{"faces": [nearest([-BLOCK[0] / 2.0, 0.0, 0.0])], "force": [0, 0, -20]}],
        "material": "PLA",
    })));
}

#[test]
fn a_narrow_fixed_face_beside_a_wide_one_gets_a_finer_mesh_by_itself() {
    let r = run(json!({
        "document": ribbed_block(RIB), "body": "body1",
        "fixed": [rib_top(), nearest([0.0, 0.0, -BLOCK[2] / 2.0])],
        "loads": [{"faces": [nearest([-BLOCK[0] / 2.0, 0.0, 0.0])], "force": [0, 0, -20]}],
        "material": "PLA",
    }));
    sane(&r);
    let warnings = r["warnings"].as_array().map_or(&[][..], |w| w.as_slice());
    assert!(!warnings.iter().any(|w| w.as_str().is_some_and(|w| w.contains("got no elements"))), "{warnings:?}");
}

#[test]
fn an_asked_size_that_loses_a_narrow_face_stays_refused() {
    let r = run(json!({
        "document": ribbed_block(RIB), "body": "body1", "size": 3.0,
        "fixed": [nearest([-BLOCK[0] / 2.0, 0.0, 0.0])],
        "loads": [{"faces": [rib_top()], "force": [0, 0, -20]}],
        "material": "PLA",
    }));
    assert!(r["error"]["message"].as_str().is_some_and(|m| m.contains("got no elements")), "{r}");
}
