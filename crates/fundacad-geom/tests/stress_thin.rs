//! Parts with walls about one element thick under the automatic element size: a thin plate with four hollow
//! standoffs, held on a side or inside two bores and pushed on two standoff tops.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::stress::{stress_result_with, StressLimits};
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
    json_of(stress_result_with(&m, &NoWatch, &StressLimits { refine_seconds: f64::INFINITY }))
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
