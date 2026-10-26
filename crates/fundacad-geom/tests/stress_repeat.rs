//! The same stress study twice in one process gives the same reply, whatever the rebuild cache holds between them.
//! One test alone in its binary, so nothing else moves the shared cache.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::stress::{stress_result_with, StressLimits};
use fundacad_protocol::JobResult;
use serde_json::{json, Value};

fn run(req: &Value) -> Value {
    let Value::Object(m) = req.clone() else { panic!("a request is an object") };
    match stress_result_with(&m, &NoWatch, &StressLimits { refine_seconds: f64::INFINITY }) {
        JobResult::Json(m) => Value::Object(m),
        _ => panic!("expected a JSON result"),
    }
}

fn turn(p: [f64; 3]) -> [f64; 3] {
    let (cz, sz) = (30f64.to_radians().cos(), 30f64.to_radians().sin());
    let (cx, sx) = (20f64.to_radians().cos(), 20f64.to_radians().sin());
    let q = [cz * p[0] - sz * p[1], sz * p[0] + cz * p[1], p[2]];
    [q[0] + 17.0, cx * q[1] - sx * q[2] - 9.0, sx * q[1] + cx * q[2] + 31.0]
}

fn nearest(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": turn(p)})
}

#[test]
fn a_study_run_again_after_the_cache_kept_only_its_first_feature_answers_the_same() {
    let doc = json!({"features": [
        {"id": "p", "type": "box", "length": 120, "width": 40, "height": 10},
        {"id": "h", "type": "cylinder", "radius": 6, "height": 30},
        {"id": "cut", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
        {"id": "z", "type": "move", "rz": 30, "bodies": ["body1"]},
        {"id": "x", "type": "move", "rx": 20, "dx": 17, "dy": -9, "dz": 31, "bodies": ["body1"]},
    ]});
    let (a, b) = (turn([0.0; 3]), turn([1400.0, 0.0, 0.0]));
    let force = [0, 1, 2].map(|k| b[k] - a[k]);
    let req = json!({
        "document": doc, "body": "body1", "material": "aluminium", "refine": "off",
        "fixed": [nearest([-60.0, 3.0, 1.0])],
        "loads": [{"faces": [nearest([60.0, -3.0, -1.0])], "force": force}],
    });
    let first = run(&req);
    assert!(first.get("error").is_none(), "{first}");
    let mut box_only = req.clone();
    box_only["document"]["features"].as_array_mut().unwrap().truncate(1);
    run(&box_only);
    assert!(run(&req) == first, "the second run of the same study answered differently");
}
