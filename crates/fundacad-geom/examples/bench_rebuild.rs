//! Cold against warm rebuild timing, the Rust side of
//! sidecar/tools/bench_rebuild.py. Every phase rebuilds and meshes.
//!
//!   cargo run --release -p fundacad-geom --example bench_rebuild -- \
//!       sidecar/tools/corpus_engines.json fillet_g2_corners [--runs 5]
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
use serde_json::{Map, Value};

fn nudge_last(doc: &Value) -> Value {
    let mut d = doc.clone();
    if let Some(last) = d["features"].as_array_mut().and_then(|a| a.last_mut()).and_then(Value::as_object_mut) {
        for (k, v) in last.iter_mut() {
            if k == "id" {
                continue;
            }
            if let Some(x) = v.as_f64() {
                *v = serde_json::json!(x * 0.9);
                break;
            }
        }
    }
    d
}

fn median(mut v: Vec<Duration>) -> f64 {
    v.sort();
    v[v.len() / 2].as_secs_f64() * 1000.0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(corpus), Some(name)) = (args.first(), args.get(1)) else {
        eprintln!("usage: bench_rebuild <corpus.json> <document name> [--runs N]");
        std::process::exit(2);
    };
    let runs: usize = args
        .iter()
        .position(|a| a == "--runs")
        .and_then(|i| args.get(i + 1))
        .and_then(|n| n.parse().ok())
        .unwrap_or(5);
    let text = std::fs::read_to_string(corpus).expect("the corpus reads");
    let corpus: Value = serde_json::from_str(&text).expect("the corpus parses");
    let raw = corpus["documents"]
        .as_array()
        .and_then(|d| d.iter().find(|x| x["name"] == name.as_str()))
        .map(|x| x["document"].clone())
        .unwrap_or_else(|| panic!("no document named {name}"));
    let edited = nudge_last(&raw);
    let typed = |v: &Value| -> CadDocument { serde_json::from_value(v.clone()).expect("the document types") };
    let known = Map::new();

    let mut cold = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        let r = builder::rebuild(&typed(&raw), &raw, &NoWatch).ok().expect("not cancelled");
        let _ = reply::mesh_result(&r.bodies, 0.1, &known);
        cold.push(t.elapsed());
    }

    let mut ram_edit = Vec::new();
    let mut ram_same = Vec::new();
    for i in 0..runs {
        let mut cache = RebuildCache::new(None);
        let r = cache.rebuild(&typed(&raw), &raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known);
        let t = Instant::now();
        let r = cache.rebuild(&typed(&edited), &edited, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known);
        ram_edit.push(t.elapsed());
        if i == 0 {
            eprintln!("ram_last_edit stats: {}", fundacad_geom::cache::stats_json(&cache.stats));
        }
        let t = Instant::now();
        let r = cache.rebuild(&typed(&edited), &edited, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known);
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
        let r = cache.rebuild(&typed(&raw), &raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known);
    }
    let mut disk = Vec::new();
    for i in 0..runs {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).expect("store")));
        let t = Instant::now();
        let r = cache.rebuild(&typed(&raw), &raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known);
        disk.push(t.elapsed());
        if i == 0 {
            eprintln!("disk_reopen stats: {}", fundacad_geom::cache::stats_json(&cache.stats));
        }
    }
    let _ = std::fs::remove_dir_all(&root);

    println!(
        "{}",
        serde_json::json!({
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
