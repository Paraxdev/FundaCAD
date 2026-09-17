//! Cold against warm rebuild timing, the Rust side of
//! sidecar/tools/bench_rebuild.py. Every phase rebuilds and meshes.
//!
//!   cargo run --release -p fundacad-geom --example bench_rebuild -- \
//!       sidecar/tools/corpus_engines.json fillet_g2_corners [--runs 5]
//!   cargo run --release -p fundacad-geom --example bench_rebuild -- --synth 60
//!
//! `--synth <holes>` builds a plate drilled that many times, a long timeline
//! where the tip edit is cheap and the prefix is not, the shape of document
//! the prefix cache exists for.
//!
//! Phases: `cold` (no cache), `ram_last_edit` (the last feature's first number
//! nudged, resumed from the snapshot ring), `ram_unchanged` (nothing to
//! replay or mesh), `disk_reopen` (a new cache on a store an earlier build
//! filled, as a restarted worker sees it).

use std::time::{Duration, Instant};

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::cache::store::GeomStore;
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::reply;
use serde_json::{json, Map, Value};

/// The last feature's first number, nudged, standing in for the edit a user
/// makes at the tip of the timeline.
fn nudge_last(doc: &Value) -> Value {
    let mut d = doc.clone();
    let nudged = d["features"]
        .as_array_mut()
        .and_then(|a| a.last_mut())
        .is_some_and(nudge);
    assert!(nudged, "the last feature has no number to edit");
    d
}

/// Nested, since a hole or a pattern keeps its sizes inside an object.
fn nudge(v: &mut Value) -> bool {
    match v {
        Value::Number(_) => {
            let x = v.as_f64().unwrap_or(1.0);
            *v = json!(x * 0.9);
            true
        }
        Value::Object(m) => m.iter_mut().any(|(k, x)| k != "id" && nudge(x)),
        Value::Array(a) => a.iter_mut().any(nudge),
        _ => false,
    }
}

fn synthetic(holes: usize) -> Value {
    let mut features = vec![
        json!({"id": "plate", "type": "sketch", "plane": "XY",
               "entities": [{"type": "rectangle", "width": 200, "height": 120, "x": 0, "y": 0}]}),
        json!({"id": "body", "type": "extrude", "sketch": "plate", "distance": 10, "operation": "new"}),
    ];
    for i in 0..holes {
        let x = -90.0 + f64::from(u32::try_from(i % 18).unwrap_or(0)) * 10.0;
        let y = -50.0 + f64::from(u32::try_from(i / 18).unwrap_or(0)) * 10.0;
        features.push(json!({"id": format!("s{i}"), "type": "sketch", "plane": "XY",
                             "entities": [{"type": "circle", "radius": 2, "x": x, "y": y}]}));
        features.push(json!({"id": format!("c{i}"), "type": "extrude", "sketch": format!("s{i}"),
                             "distance": 10, "operation": "cut"}));
    }
    json!({"parameters": {}, "features": features})
}

fn median(mut v: Vec<Duration>) -> f64 {
    v.sort();
    v[v.len() / 2].as_secs_f64() * 1000.0
}

fn typed(v: &Value) -> CadDocument {
    serde_json::from_value(v.clone()).expect("the document types")
}

fn bench(raw: &Value, name: &str, runs: usize) {
    let edited = nudge_last(raw);
    let known = Map::new();

    let mut cold = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        let r = builder::rebuild(&typed(raw), raw, &NoWatch).ok().expect("not cancelled");
        let _ = reply::mesh_result(&r.bodies, 0.1, &known, &NoWatch);
        cold.push(t.elapsed());
    }

    let mut ram_edit = Vec::new();
    let mut ram_same = Vec::new();
    for i in 0..runs {
        let mut cache = RebuildCache::new(None);
        let r = cache.rebuild(&typed(raw), raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known, &mut |_, _| {});
        let t = Instant::now();
        let r = cache.rebuild(&typed(&edited), &edited, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known, &mut |_, _| {});
        ram_edit.push(t.elapsed());
        if i == 0 {
            eprintln!("ram_last_edit stats: {}", fundacad_geom::cache::stats_json(&cache.stats));
        }
        let t = Instant::now();
        let r = cache.rebuild(&typed(&edited), &edited, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known, &mut |_, _| {});
        ram_same.push(t.elapsed());
        if i == 0 {
            eprintln!("ram_unchanged stats: {}", fundacad_geom::cache::stats_json(&cache.stats));
        }
    }

    let root = std::env::temp_dir().join(format!("fundacad-bench-rebuild-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).expect("store")));
        cache.tip_after = Duration::ZERO;
        cache.mesh_persist_after = Duration::ZERO;
        let r = cache.rebuild(&typed(raw), raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known, &mut |_, _| {});
    }
    let mut disk = Vec::new();
    for i in 0..runs {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).expect("store")));
        let t = Instant::now();
        let r = cache.rebuild(&typed(raw), raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known, &mut |_, _| {});
        disk.push(t.elapsed());
        if i == 0 {
            eprintln!("disk_reopen stats: {}", fundacad_geom::cache::stats_json(&cache.stats));
        }
    }
    let _ = std::fs::remove_dir_all(&root);

    println!(
        "{}",
        json!({
            "document": name,
            "features": raw["features"].as_array().map_or(0, Vec::len),
            "runs": runs,
            "cold_ms": median(cold),
            "ram_last_edit_ms": median(ram_edit),
            "ram_unchanged_ms": median(ram_same),
            "disk_reopen_ms": median(disk),
        })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(corpus), Some(name)) = (args.first(), args.get(1)) else {
        eprintln!("usage: bench_rebuild <corpus.json> <document name> [--runs N]");
        eprintln!("       bench_rebuild --synth <holes> [--runs N]");
        std::process::exit(2);
    };
    let runs: usize = args
        .iter()
        .position(|a| a == "--runs")
        .and_then(|i| args.get(i + 1))
        .and_then(|n| n.parse().ok())
        .unwrap_or(5);
    if corpus == "--synth" {
        let holes: usize = name.parse().expect("--synth takes a hole count");
        bench(&synthetic(holes), &format!("synthetic-{holes}-holes"), runs);
        return;
    }
    let text = std::fs::read_to_string(corpus).expect("the corpus reads");
    let corpus: Value = serde_json::from_str(&text).expect("the corpus parses");
    let raw = corpus["documents"]
        .as_array()
        .and_then(|d| d.iter().find(|x| x["name"] == name.as_str()))
        .map(|x| x["document"].clone())
        .unwrap_or_else(|| panic!("no document named {name}"));
    bench(&raw, name, runs);
}
