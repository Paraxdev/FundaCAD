//! Times what finding a fillet blend costs where the app asks for it: faceAxis when a round face is selected, and
//! each preview tick of a Press/Pull drag. Run with `--ignored --nocapture`, FUNDACAD_DISK_CACHE=0.

use std::time::Instant;

use fundacad_geom::builder::NoWatch;
use fundacad_geom::features::axis_push::face_axis_result;
use fundacad_geom::jobs::rebuild_result_cached;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};

const FILLETED_BOX: &str = include_str!("../../../tools/harness/fixtures/filleted_box.json");
const BLEND: [f64; 3] = [43.59, 24.29, 34.75];

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn face_axis_ms(doc: &Value, point: [f64; 3]) -> (f64, Value) {
    let req = json!({"document": doc, "body": "body1", "face": {"kind": "face", "by": "nearest", "point": point}});
    let t = Instant::now();
    let JobResult::Json(got) = face_axis_result(req.as_object().unwrap(), &NoWatch) else {
        panic!("a json reply");
    };
    (ms(t), Value::Object(got))
}

fn blend_of_phase() -> String {
    let r = fundacad_geom::bench::report();
    fundacad_geom::bench::reset();
    r.get("blend_of").map_or("-".into(), |v| v.to_string())
}

/// The fixture's box with every edge rounded G3, so one blend runs smoothly through the whole set and meets six walls.
fn all_rounded() -> Value {
    let mut raw: Value = serde_json::from_str(FILLETED_BOX).unwrap();
    raw["features"][2]["edges"] = json!({"kind": "edge", "by": "all", "body": "body1"});
    raw["features"][2]["radius"] = json!(8.0);
    raw
}

#[test]
#[ignore]
fn blend_lookup_cost() {
    let doc: Value = serde_json::from_str(FILLETED_BOX).unwrap();
    for i in 0..3 {
        let (t, got) = face_axis_ms(&doc, BLEND);
        eprintln!("faceAxis blend #{i}: {t:.1} ms {} blend_of {}", got["resize"]["size"], blend_of_phase());
    }
    fundacad_geom::features::regrow::forget();
    let mut cache = fundacad_geom::cache::global().lock().unwrap();
    let t = Instant::now();
    rebuild_result_cached(&doc, 0.1, &Map::new(), &NoWatch, &mut *cache);
    eprintln!("base rebuild: {:.1} ms", ms(t));
    blend_of_phase();
    for (i, d) in [0.6, 1.3, 2.1, 2.8, 3.5, 4.4].into_iter().enumerate() {
        let mut raw = doc.clone();
        raw["features"].as_array_mut().unwrap().push(json!({"id": "push", "type": "press-pull",
            "face": {"kind": "face", "by": "nearest", "point": BLEND, "body": "body1"},
            "distance": d, "operation": "join", "body": "body1"}));
        let t = Instant::now();
        rebuild_result_cached(&raw, 0.1, &Map::new(), &NoWatch, &mut *cache);
        eprintln!("preview tick #{i} d {d}: {:.1} ms blend_of {}", ms(t), blend_of_phase());
    }
    drop(cache);
    let doc = all_rounded();
    for i in 0..3 {
        let (t, got) = face_axis_ms(&doc, [55.651 - 2.3, 33.903 - 2.3, 26.066]);
        eprintln!("faceAxis all rounded #{i}: {t:.1} ms {} blend_of {}", got["resize"], blend_of_phase());
    }
}
