//! What a rebuild reports while it runs: a feature when it starts, a checkpoint save as saving, and a meshing
//! count that holds only the bodies really meshed.

use std::sync::Mutex;
use std::time::Duration;

use fundacad_geom::builder::Watch;
use fundacad_geom::cache::store::GeomStore;
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::jobs::rebuild_result_cached;
use fundacad_protocol::build_phase::{ASSEMBLING, SAVING};
use serde_json::{json, Map, Value};

#[derive(Default)]
struct Events(Mutex<Vec<String>>);

impl Events {
    fn push(&self, e: String) {
        self.0.lock().unwrap().push(e);
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl Watch for Events {
    fn feature(&self, index: usize) {
        self.push(format!("done {index}"));
    }

    fn feature_started(&self, index: usize) {
        self.push(format!("start {index}"));
    }

    fn phase(&self, phase: i64) {
        self.push(format!("phase {phase}"));
    }

    fn meshing(&self, done: usize, total: usize) {
        self.push(format!("mesh {done}/{total}"));
    }
}

fn doc() -> Value {
    json!({
        "parameters": {"w": 37, "h": 23, "r": 1.5},
        "features": [
            {"id": "f1", "type": "box", "length": "w", "width": "h", "height": 9, "operation": "new"},
            {"id": "f2", "type": "move", "x": 41, "y": 13, "z": 5},
            {"id": "f3", "type": "box", "length": 8, "width": 6, "height": 7, "operation": "new"},
            {"id": "f4", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": "r"},
        ]
    })
}

fn run(cache: &mut RebuildCache, raw: &Value, events: &Events) -> Vec<String> {
    rebuild_result_cached(raw, 0.1, &Map::new(), events, cache);
    events.take()
}

#[test]
fn a_first_build_starts_each_feature_before_it_finishes_and_counts_every_body_it_meshes() {
    let events = Events::default();
    let mut cache = RebuildCache::new(None);
    let got = run(&mut cache, &doc(), &events);
    let want = [
        "start 0", "done 0", "start 1", "done 1", "start 2", "done 2", "start 3", "done 3", "phase 4", "mesh 0/2",
        "mesh 1/2", "mesh 2/2", "phase 4",
    ];
    assert_eq!(got, want);
}

#[test]
fn a_rebuild_that_meshes_nothing_never_reports_meshing() {
    let events = Events::default();
    let mut cache = RebuildCache::new(None);
    run(&mut cache, &doc(), &events);
    let got = run(&mut cache, &doc(), &events);
    assert_eq!(got, [format!("phase {ASSEMBLING}"), format!("phase {ASSEMBLING}")]);
}

#[test]
fn an_edit_counts_only_the_body_it_changed() {
    let events = Events::default();
    let mut cache = RebuildCache::new(None);
    run(&mut cache, &doc(), &events);
    let mut edited = doc();
    edited["parameters"]["r"] = json!(2.5);
    let got = run(&mut cache, &edited, &events);
    let meshed: Vec<&String> = got.iter().filter(|e| e.starts_with("mesh")).collect();
    assert_eq!(meshed, ["mesh 0/1", "mesh 1/1"]);
    assert_eq!(got.iter().filter(|e| e.starts_with("start")).collect::<Vec<_>>(), ["start 3"]);
}

#[test]
fn a_checkpoint_write_is_saving_and_the_next_feature_leaves_it() {
    let root = std::env::temp_dir().join(format!("fundacad-progress-phases-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let events = Events::default();
    let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    cache.budget_ms = 0.0;
    cache.tip_after = Duration::ZERO;
    let got = run(&mut cache, &doc(), &events);
    assert_eq!(got[..4], ["start 0", &format!("phase {SAVING}"), "done 0", "start 1"]);
    assert!(got.contains(&"mesh 2/2".to_owned()), "{got:?}");
    let _ = std::fs::remove_dir_all(&root);
}
