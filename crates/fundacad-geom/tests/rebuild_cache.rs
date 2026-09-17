//! The rebuild caches, the oracles of sidecar/tests/test_checkpoint.py and
//! the disk resume cases of test_assembly.py: a warm rebuild replays only
//! what changed and answers exactly what a cold one does.

use std::cell::RefCell;
use std::path::PathBuf;
use std::time::Duration;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild, Watch};
use fundacad_geom::cache::store::GeomStore;
use fundacad_geom::cache::{RebuildCache, Source};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::measure;
use fundacad_geom::reply;
use fundacad_protocol::{JobResult, MeshResult, WireBody};
use serde_json::{json, Map, Value};

const TOL: f64 = 0.1;

fn doc() -> Value {
    json!({
        "parameters": {"w": 40, "h": 20, "t": 5, "r": 2},
        "features": [
            {"id": "f1", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": "w", "height": "h", "x": 0, "y": 0}]},
            {"id": "f2", "type": "extrude", "sketch": "f1", "distance": "t", "operation": "new"},
            {"id": "f3", "type": "sketch", "plane": "XY",
             "entities": [{"type": "circle", "radius": 3, "x": -12, "y": 0}]},
            {"id": "f4", "type": "extrude", "sketch": "f3", "distance": "t", "operation": "cut"},
            {"id": "f5", "type": "box", "length": 6, "width": 6, "height": 6, "operation": "new"},
            {"id": "f6", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": "r"},
        ]
    })
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-rebuild-cache-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn typed(raw: &Value) -> CadDocument {
    serde_json::from_value(raw.clone()).unwrap()
}

#[derive(Default)]
struct Replayed(RefCell<Vec<usize>>);

impl Watch for Replayed {
    fn feature(&self, index: usize) {
        self.0.borrow_mut().push(index);
    }
}

/// What a reply must reproduce: ids, names, node refs, volumes, errors,
/// diagnostics and every payload's etag.
fn signature(r: &Rebuild, mesh: &MeshResult) -> Value {
    let etags: Vec<Value> = mesh
        .bodies
        .iter()
        .map(|b| match b {
            WireBody::Full(f) => f.fields["etag"].clone(),
            WireBody::Stub(s) => s["etag"].clone(),
        })
        .collect();
    json!({
        "bodies": r.bodies.iter().map(|b| json!([b.id, b.name, b.node_ref, b.part_color,
            b.face_colors, (measure::volume(&b.shape) * 1e6).round() / 1e6, b.owners.len()])).collect::<Vec<_>>(),
        "errors": r.errors.iter().map(|e| e.wire()).collect::<Vec<_>>(),
        "diagnostics": r.diagnostics,
        "bodyIds": r.body_ids,
        "datums": serde_json::to_value(&r.datum_planes).unwrap(),
        "etags": etags,
        "bbox": mesh.fields["bbox"],
    })
}

fn cold(raw: &Value) -> Value {
    let r = builder::rebuild(&typed(raw), raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    let JobResult::Mesh(m) = reply::mesh_result(&r.bodies, TOL, &Map::new(), &NoWatch) else {
        panic!("mesh")
    };
    signature(&r, &m)
}

fn warm(cache: &mut RebuildCache, raw: &Value) -> (Value, Vec<usize>) {
    let watch = Replayed::default();
    let r = cache.rebuild(&typed(raw), raw, &watch).unwrap_or_else(|_| panic!("cancelled"));
    let m = cache.mesh(&r, TOL, &Map::new(), &mut |_, _| {});
    let replayed = watch.0.borrow().clone();
    assert_eq!(replayed, cache.stats.replayed);
    (signature(&r, &m), replayed)
}

fn edit(raw: &Value, index: usize, field: &str, value: Value) -> Value {
    let mut d = raw.clone();
    d["features"][index][field] = value;
    d
}

#[test]
fn editing_the_last_feature_replays_only_it_and_matches_a_cold_build() {
    let mut cache = RebuildCache::new(None);
    let base = doc();
    let (first, replayed) = warm(&mut cache, &base);
    assert_eq!(cache.stats.source, Source::Full);
    assert_eq!(replayed, [0, 1, 2, 3, 4, 5]);
    assert_eq!(first, cold(&base));

    let edited = edit(&base, 5, "radius", json!(1.5));
    let (resumed, replayed) = warm(&mut cache, &edited);
    assert_eq!(cache.stats.source, Source::Ram);
    assert_eq!(cache.stats.resumed_at, 5);
    assert_eq!(replayed, [5], "a warm rebuild replayed earlier features");
    assert_eq!(resumed, cold(&edited));
    assert_ne!(resumed["etags"], first["etags"]);

    let (again, replayed) = warm(&mut cache, &edited);
    assert!(replayed.is_empty());
    assert_eq!(again, resumed);
    assert_eq!(cache.stats.mesh_ram_hits, 2, "unchanged bodies were meshed again");
    assert_eq!(cache.stats.meshed, 0);
}

#[test]
fn a_mid_timeline_edit_resumes_at_it() {
    let mut cache = RebuildCache::new(None);
    let base = doc();
    warm(&mut cache, &base);
    let edited = edit(&base, 1, "distance", json!(6));
    let (resumed, replayed) = warm(&mut cache, &edited);
    assert_eq!(replayed, [1, 2, 3, 4, 5]);
    assert_eq!(resumed, cold(&edited));
}

#[test]
fn a_parameter_edit_replays_from_its_first_reader() {
    let mut cache = RebuildCache::new(None);
    let base = doc();
    warm(&mut cache, &base);
    let mut edited = base.clone();
    edited["parameters"]["r"] = json!(1);
    let (resumed, replayed) = warm(&mut cache, &edited);
    assert_eq!(replayed, [5]);
    assert_eq!(resumed, cold(&edited));
    edited["parameters"]["t"] = json!(4);
    let (_, replayed) = warm(&mut cache, &edited);
    assert_eq!(replayed, [1, 2, 3, 4, 5]);
}

#[test]
fn a_renumbering_body_id_map_is_not_served_from_the_cache() {
    let mut cache = RebuildCache::new(None);
    let base = doc();
    warm(&mut cache, &base);
    let mut renumbered = base.clone();
    renumbered["bodyIds"] = json!({"f2:0": "body7", "f5:0": "body3"});
    let (got, replayed) = warm(&mut cache, &renumbered);
    assert_eq!(replayed.first(), Some(&0));
    assert_eq!(got, cold(&renumbered));
}

#[test]
fn a_new_process_resumes_from_disk_with_identical_payloads() {
    let root = scratch("disk");
    let base = doc();
    let reference = cold(&base);
    {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
        cache.budget_ms = 0.0;
        cache.tip_after = Duration::ZERO;
        cache.mesh_persist_after = Duration::ZERO;
        let (got, _) = warm(&mut cache, &base);
        assert_eq!(got, reference);
        assert!(cache.stats.checkpoints_written >= 6);
    }
    let mut reopened = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let (got, replayed) = warm(&mut reopened, &base);
    assert_eq!(reopened.stats.source, Source::Disk);
    assert!(replayed.is_empty(), "replayed {replayed:?} after a disk resume");
    assert_eq!(reopened.stats.mesh_disk_hits, 2);
    assert_eq!(got, reference);

    let edited = edit(&base, 5, "radius", json!(1.0));
    let mut third = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let (got, replayed) = warm(&mut third, &edited);
    assert_eq!(third.stats.source, Source::Disk);
    assert_eq!(replayed, [5]);
    assert_eq!(got, cold(&edited));
}

#[test]
fn a_corrupt_checkpoint_blob_is_a_cold_rebuild_not_wrong_geometry() {
    let root = scratch("corrupt");
    let base = doc();
    {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
        cache.budget_ms = 1e12;
        cache.tip_after = Duration::ZERO;
        warm(&mut cache, &base);
        assert_eq!(cache.stats.checkpoints_written, 1);
    }
    for shard in std::fs::read_dir(root.join("blobs")).unwrap().flatten() {
        for blob in std::fs::read_dir(shard.path()).unwrap().flatten() {
            std::fs::write(blob.path(), b"Open CASCADE Topology V3 but torn").unwrap();
        }
    }
    let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let (got, replayed) = warm(&mut cache, &base);
    assert_eq!(cache.stats.source, Source::Full);
    assert_eq!(replayed.len(), 6);
    assert_eq!(got, cold(&base));
}

#[test]
fn compute_all_purges_the_documents_checkpoints() {
    let root = scratch("purge");
    let base = doc();
    let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    cache.budget_ms = 0.0;
    warm(&mut cache, &base);
    assert!(cache.store().unwrap().stats().checkpoints > 0);
    cache.purge(&base);
    assert_eq!(cache.store().unwrap().stats().checkpoints, 0);
    let (_, replayed) = warm(&mut cache, &base);
    assert_eq!(replayed.len(), 6);
}

fn import_doc(fixture: &str, extra: Value) -> Value {
    let blobs = scratch("blobs-shared");
    std::fs::create_dir_all(&blobs).unwrap();
    std::env::set_var("FUNDACAD_BLOB_DIR", &blobs);
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../sidecar/fixtures/{fixture}.step"));
    let store = BlobStore::open(&blobs).unwrap();
    let mut f = import::import_geometry(&path.to_string_lossy(), "step", &store).unwrap();
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    if let Value::Object(m) = extra {
        f.extend(m);
    }
    json!({"parameters": {}, "features": [
        f,
        {"id": "f2", "type": "box", "length": 2, "width": 2, "height": 2, "operation": "new"},
    ]})
}

#[test]
fn import_metadata_and_diagnostics_survive_a_disk_resume() {
    let cases = [
        import_doc("asm_face_colors", json!({})),
        import_doc("asm_nested", json!({"explode": false})),
    ];
    let mut mismatch = import_doc("asm_multisolid", json!({}));
    mismatch["features"][0]["parts"][2]["faces"] = json!(999);
    for (i, raw) in cases.iter().chain([&mismatch]).enumerate() {
        let root = scratch(&format!("import{i}"));
        let reference = cold(raw);
        {
            let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
            cache.budget_ms = 0.0;
            warm(&mut cache, raw);
        }
        let mut reopened = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
        let edited = edit(raw, 1, "length", json!(3));
        let (got, replayed) = warm(&mut reopened, &edited);
        assert_eq!(reopened.stats.source, Source::Disk, "case {i}");
        assert_eq!(replayed, [1], "case {i}");
        assert_eq!(got, cold(&edited), "case {i}");
        assert_eq!(got["bodies"].as_array().unwrap().len(), reference["bodies"].as_array().unwrap().len());
    }
    assert!(!cold(&mismatch)["diagnostics"].as_array().unwrap().is_empty());
}
