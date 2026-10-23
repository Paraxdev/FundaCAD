//! The reply of a cached rebuild carries the engine's stage times for the app's one-line timing per edit.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::jobs::{rebuild_result, rebuild_result_cached};
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};

fn doc(radius: f64, width: f64) -> Value {
    json!({
        "parameters": {"w": width, "r": radius},
        "features": [
            {"id": "f1", "type": "box", "length": "w", "width": 23, "height": 9, "operation": "new"},
            {"id": "f2", "type": "move", "x": 41, "y": 13, "z": 5},
            {"id": "f3", "type": "box", "length": 8, "width": 6, "height": 7, "operation": "new"},
            {"id": "f4", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": "r"},
        ]
    })
}

fn timing(result: JobResult) -> Option<Value> {
    let JobResult::Mesh(m) = result else {
        panic!("expected a mesh result");
    };
    m.fields.get("timing").cloned()
}

#[test]
fn a_cached_rebuild_reports_its_stages_and_an_uncached_one_none() {
    let mut cache = RebuildCache::new(None);
    let first = timing(rebuild_result_cached(&doc(1.5, 37.0), 0.1, &Map::new(), &NoWatch, &mut cache)).unwrap();
    assert_eq!(first["meshed"], json!(2));
    assert!(first["replay"].as_f64().unwrap() > 0.0, "{first}");

    // Only the fillet reads r, so it alone replays and only the body it changed is meshed again.
    let second = timing(rebuild_result_cached(&doc(1.2, 37.0), 0.1, &Map::new(), &NoWatch, &mut cache)).unwrap();
    assert_eq!(second["slow"], json!("fillet"), "{second}");
    assert_eq!(second["meshed"], json!(1), "{second}");
    assert!(second["mesh"].as_f64().unwrap() > 0.0, "{second}");

    // A different width reaches the first box, so the whole chain replays and the slowest is a feature that ran.
    let third = timing(rebuild_result_cached(&doc(1.2, 29.0), 0.1, &Map::new(), &NoWatch, &mut cache)).unwrap();
    assert_eq!(third["meshed"], json!(2), "{third}");
    assert!(["box", "move", "fillet"].contains(&third["slow"].as_str().unwrap()), "{third}");

    assert_eq!(timing(rebuild_result(&doc(1.5, 37.0), 0.1, &Map::new(), &NoWatch)), None);
}

#[test]
fn the_meshing_time_of_many_bodies_never_exceeds_the_edit_it_is_part_of() {
    let features: Vec<Value> = (0..6)
        .flat_map(|i| {
            let f = f64::from(i);
            [
                json!({"id": format!("b{i}"), "type": "sphere", "radius": 9.0 + f, "operation": "new"}),
                json!({"id": format!("m{i}"), "type": "move", "x": 31.0 * f + 3.0, "y": 7.0 * f, "z": 2.0 * f}),
            ]
        })
        .collect();
    let mut cache = RebuildCache::new(None);
    let began = std::time::Instant::now();
    let reply =
        timing(rebuild_result_cached(&json!({"features": features}), 0.05, &Map::new(), &NoWatch, &mut cache)).unwrap();
    let wall = began.elapsed().as_secs_f64() * 1e3;
    assert_eq!(reply["meshed"], json!(6), "{reply}");
    let parts: f64 = ["copy", "replay", "post", "mesh"].iter().map(|k| reply[*k].as_f64().unwrap()).sum();
    assert!(reply["mesh"].as_f64().unwrap() > 0.0, "{reply}");
    assert!(parts <= wall + 1.0, "stages {parts} ms exceed the edit {wall} ms: {reply}");
}
