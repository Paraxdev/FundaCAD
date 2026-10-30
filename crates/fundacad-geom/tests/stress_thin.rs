//! Parts with walls about one element thick under the automatic element size: a thin plate with four hollow
//! standoffs, held on a side or inside two bores and pushed on two standoff tops.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::fem::adapt::solve_seconds;
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
    assert!(r["error"].get("finer").is_none(), "{r}");
}

fn run_within(req: Value, limits: StressLimits) -> Value {
    let Value::Object(m) = req else { panic!("a request is an object") };
    json_of(stress_result_with(&m, &NoWatch, &limits))
}

fn plate_on_its_side() -> Value {
    json!({
        "document": standoff_plate(), "body": "body1",
        "fixed": [nearest([-LENGTH / 2.0, 0.0, 0.0])],
        "loads": [{"faces": [top(1), top(2)], "force": [0, 0, -20]}],
        "material": "PLA",
    })
}

fn asking(mut req: Value) -> Value {
    req["finer"] = json!(true);
    req
}

fn assert_finer_answer(r: &Value, elements: std::ops::Range<f64>) {
    let finer = &r["error"]["finer"];
    assert!(elements.contains(&num(&finer["elements"])), "{r}");
    assert!(num(&finer["seconds"]) >= 1.0, "{r}");
}

fn no_time_limit() -> StressLimits {
    StressLimits { refine_seconds: f64::INFINITY, ..Default::default() }
}

#[test]
fn fine_retries_as_far_as_standard_but_an_asked_limit_alone_holds() {
    let mut limited = plate_on_its_side();
    limited["maxElements"] = json!(35_000);
    assert_finer_answer(&run(limited.clone()), 35_000.0..90_000.0);
    limited["refine"] = json!("fine");
    let r = run(limited);
    sane(&r);
    assert!(num(&r["mesh"]["elements"]) > 35_000.0, "{}", r["mesh"]);
}

#[test]
fn a_wall_past_the_element_limit_answers_with_a_finer_run() {
    let r = run_within(plate_on_its_side(), StressLimits { auto_elements: 30_000, ..no_time_limit() });
    assert_finer_answer(&r, 30_000.0..60_000.0);
}

#[test]
fn a_wall_past_the_time_limit_answers_with_a_finer_run() {
    let r = run_within(plate_on_its_side(), StressLimits { refine_seconds: 1.0, ..no_time_limit() });
    assert_finer_answer(&r, 30_000.0..60_000.0);
}

#[test]
fn a_mesh_past_the_memory_limit_answers_with_a_finer_run() {
    let r = run_within(plate_on_its_side(), StressLimits { memory_cap: 1 << 20, ..no_time_limit() });
    assert!(r["error"]["message"].as_str().is_some_and(|m| m.contains("memory")), "{r}");
    assert_finer_answer(&r, 30_000.0..60_000.0);
}

#[test]
fn asking_for_the_finer_run_lifts_the_element_and_memory_limits_once() {
    let limits = StressLimits { auto_elements: 30_000, memory_cap: 1 << 20, ..no_time_limit() };
    sane(&run_within(asking(plate_on_its_side()), limits));
}

#[test]
fn a_finer_run_past_its_own_memory_limit_is_a_plain_refusal() {
    let limits = StressLimits { memory_cap: 1 << 20, finer_memory_cap: 1 << 20, ..no_time_limit() };
    for req in [plate_on_its_side(), asking(plate_on_its_side())] {
        let r = run_within(req, limits);
        assert!(r["error"]["message"].as_str().is_some_and(|m| m.contains("memory")), "{r}");
        assert!(r["error"].get("finer").is_none(), "{r}");
    }
}

#[test]
fn a_part_too_thin_for_the_finer_limit_gets_no_button() {
    let mut doc = standoff_plate();
    let features = doc["features"].as_array_mut().unwrap();
    for f in features.iter_mut().filter(|f| f["id"].as_str().is_some_and(|i| i.starts_with('b'))) {
        if f["type"] == "cylinder" {
            f["radius"] = json!(OUTER - 0.2);
        }
    }
    let mut req = plate_on_its_side();
    req["document"] = doc;
    let r = run_within(req, no_time_limit());
    assert!(r["error"]["message"].as_str().is_some_and(|m| !m.is_empty()), "{r}");
    assert!(r["error"].get("finer").is_none(), "{r}");
}

#[test]
fn a_face_narrower_than_the_finest_mesh_answers_with_a_finer_run() {
    let r = run_within(
        json!({
            "document": ribbed_block(0.8), "body": "body1",
            "fixed": [nearest([-BLOCK[0] / 2.0, 0.0, 0.0])],
            "loads": [{"faces": [rib_top()], "force": [0, 0, -20]}],
            "material": "PLA",
        }),
        StressLimits { auto_elements: 30_000, ..no_time_limit() },
    );
    assert!(r["error"]["message"].as_str().is_some_and(|m| !m.is_empty()), "{r}");
    assert_finer_answer(&r, 30_000.0..400_000.0);
}

#[test]
fn a_wall_that_stops_the_run_is_named_with_its_thickness_and_place() {
    let r = run_within(plate_on_its_side(), StressLimits { auto_elements: 30_000, ..no_time_limit() });
    let message = r["error"]["message"].as_str().unwrap_or_else(|| panic!("{r}"));
    let (_, words) = message.split_once("the thinnest wall is about 1.3 mm thick, near (").unwrap_or(("", ""));
    let (place, unit) = words.split_once(')').unwrap_or_else(|| panic!("{message}"));
    assert_eq!(unit, " mm", "{message}");
    let place: Vec<f64> = place.split(", ").map(|n| n.parse().unwrap_or_else(|_| panic!("{message}"))).collect();
    let on_a_tube = AT.iter().any(|[x, y]| {
        let from_axis = (place[0] - x).hypot(place[1] - y);
        from_axis > BORE - 0.1 && from_axis < OUTER + 0.1
    });
    assert!(on_a_tube, "{message}");
}

#[test]
fn a_mesh_past_the_memory_limit_is_priced_as_a_compact_part() {
    let r = run_within(plate_on_its_side(), StressLimits { memory_cap: 1 << 20, ..no_time_limit() });
    let finer = &r["error"]["finer"];
    let plain = solve_seconds(num(&finer["elements"]) as usize);
    assert!(num(&finer["seconds"]) >= 1.5 * plain, "{r}");
}
