//! The rebuild caches against the Python engine's test_checkpoint.py and the disk resume cases of test_assembly.py:
//! a warm rebuild replays only what changed and answers exactly what a cold one does.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild, Watch};
use fundacad_geom::cache::meshes::{Payloads, Tiered};
use fundacad_geom::cache::store::GeomStore;
use fundacad_geom::cache::{RebuildCache, Source};
use fundacad_geom::import::{self, blobstore, blobstore::BlobStore};
use fundacad_geom::kernel;
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
    let JobResult::Mesh(m) = reply::mesh_result(&r.bodies, TOL, &Map::new(), &NoWatch) else { panic!("mesh") };
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

/// `tests/faces/split_wall.brep`: one body whose side is two faces of one surface, which puts `faceBands` in its
/// payload. faces_parity covers the memory tier, this covers the artifact written to a real store.
fn split_wall() -> opencascade::primitives::Shape {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/faces/split_wall.brep");
    let text = std::fs::read_to_string(path).unwrap();
    opencascade::mesh_access::read_brep_str(&text).expect("the fixture BREP reads")
}

fn banded_payload(payloads: &mut Payloads, store: Option<&GeomStore>, shape: &opencascade::primitives::Shape) -> Value {
    let body = fundacad_geom::mesh::MeshBody {
        id: "body1".into(),
        name: "Wall".into(),
        shape: Some(shape),
        identity: Some((7, 9)),
        mesh_key: Some("ab".repeat(16)),
        ..Default::default()
    };
    payloads.reset_counters();
    let mut tiered = Tiered { payloads, store, persist_after: Duration::ZERO };
    let m = fundacad_geom::mesh::mesh_result_full(
        std::slice::from_ref(&body),
        TOL,
        &Map::new(),
        &mut tiered,
        &mut |_, _| {},
    );
    match &m.bodies[0] {
        WireBody::Full(f) => json!([f.fields["faceBands"], f.fields["etag"]]),
        WireBody::Stub(_) => Value::Null,
    }
}

#[test]
fn a_cached_payload_keeps_its_face_bands() {
    let shape = split_wall();
    let root = scratch("bands");
    let store = GeomStore::open(&root).unwrap();
    let mut payloads = Payloads::default();

    let fresh = banded_payload(&mut payloads, Some(&store), &shape);
    assert_eq!(fresh[0], json!([[0, 1]]), "the fixture carries no face bands");
    assert_eq!((payloads.ram_hits, payloads.disk_hits, payloads.meshed), (0, 0, 1));

    let warm = banded_payload(&mut payloads, Some(&store), &shape);
    assert_eq!(
        (payloads.ram_hits, payloads.disk_hits, payloads.meshed),
        (1, 0, 0),
        "a banded payload was meshed again instead of served from memory"
    );
    assert_eq!(warm, fresh);

    let mut reopened = Payloads::default();
    let from_disk = banded_payload(&mut reopened, Some(&store), &shape);
    assert_eq!(
        (reopened.ram_hits, reopened.disk_hits, reopened.meshed),
        (0, 1, 0),
        "the disk artifact of a banded body was not read back"
    );
    assert_eq!(from_disk, fresh);
}

#[test]
fn a_projecting_sketch_is_never_resumed_past() {
    let raw = json!({"parameters": {}, "features": [
        {"id": "c", "type": "cylinder", "radius": 10, "height": 20},
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"id": "p", "type": "projected", "source": {"kind": "silhouette", "body": "body1", "group": "p"},
             "curve": {"kind": "circle", "x": 0, "y": 0, "r": 9}}]},
        {"id": "b", "type": "box", "length": 4, "width": 4, "height": 4},
    ]});
    let mut cache = RebuildCache::new(None);
    let watch = Replayed::default();
    let first = cache.rebuild(&typed(&raw), &raw, &watch).unwrap();
    assert_eq!(first.projection_updates.len(), 1, "the fixture projects nothing");

    let watch = Replayed::default();
    let again = cache.rebuild(&typed(&raw), &raw, &watch).unwrap();
    assert_eq!(cache.stats.resumed_at, 1, "a resume skipped the projecting sketch");
    assert_eq!(
        again.projection_updates, first.projection_updates,
        "the projection update was cached away, the frontend would never hear it"
    );

    // The update applied, the sketch stops reporting and a resume may pass it.
    let mut applied = raw.clone();
    applied["features"][1]["entities"][0]["curve"] = json!({"kind": "circle", "x": 0, "y": 0, "r": 10});
    let quiet = cache.rebuild(&typed(&applied), &applied, &Replayed::default()).unwrap();
    assert!(quiet.projection_updates.is_empty(), "{:?}", quiet.projection_updates);
    let (_, replayed) = warm(&mut cache, &applied);
    assert!(replayed.is_empty(), "a quiet prefix still replayed {replayed:?}");
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
fn only_a_build_this_process_made_is_held_and_a_disk_resume_stays_in_ram() {
    let root = scratch("held");
    let base = doc();
    {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
        cache.budget_ms = 0.0;
        cache.tip_after = Duration::ZERO;
        assert!(cache.held(&base).is_none(), "nothing is built yet");
        warm(&mut cache, &base);
        assert_eq!(cache.held(&base).map(|b| b.len()), Some(2));
        let prefix = json!({"parameters": base["parameters"], "features": base["features"].as_array().unwrap()[..2]});
        assert_eq!(cache.held(&prefix).map(|b| b.len()), Some(1));
        assert!(cache.held(&edit(&base, 5, "radius", json!(1.0))).is_none());
    }
    let mut reopened = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    assert!(reopened.held(&base).is_none(), "a checkpoint on disk is not held");
    warm(&mut reopened, &base);
    assert_eq!(reopened.stats.source, Source::Disk);
    assert_eq!(reopened.held(&base).map(|b| b.len()), Some(2));
    let (got, replayed) = warm(&mut reopened, &base);
    assert_eq!(reopened.stats.source, Source::Ram, "read the checkpoint back again");
    assert!(replayed.is_empty(), "replayed {replayed:?}");
    assert_eq!(got, cold(&base));
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

/// One blob folder for the whole file, the variable that names it is the
/// process's: a test reads only the geometry it stored there itself.
fn blob_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let blobs = scratch("blobs-shared");
        std::fs::create_dir_all(&blobs).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &blobs);
        blobs
    })
    .clone()
}

fn import_doc(fixture: &str, extra: Value) -> Value {
    let blobs = blob_dir();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{fixture}.step"));
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
    let cases = [import_doc("asm_face_colors", json!({})), import_doc("asm_nested", json!({"explode": false}))];
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

/// A box imported from the blob store after a feature that needs nothing
/// outside the document: the document, where its blob lives, and the blob.
fn stored_box(length: f64) -> (Value, PathBuf, Vec<u8>) {
    let bytes = opencascade::xcaf::to_bin_v3(&kernel::make_box(length, 4.0, 3.0).unwrap()).unwrap();
    let geom = blobstore::hash_bytes(&bytes);
    let raw = json!({"parameters": {}, "features": [
        {"id": "f1", "type": "box", "length": 2, "width": 2, "height": 2, "operation": "new"},
        {"id": "f2", "type": "import", "name": "Part", "geom": geom},
        {"id": "f3", "type": "box", "length": 3, "width": 3, "height": 3, "operation": "new"},
    ]});
    (raw, blob_dir().join(format!("{geom}.bbrep")), bytes)
}

fn missing_geometry(sig: &Value) -> bool {
    sig["errors"][0]["message"].as_str().is_some_and(|m| m.contains("missing from local storage"))
}

#[test]
fn geometry_that_arrives_is_not_served_the_failure_cached_without_it() {
    let (raw, blob, bytes) = stored_box(11.0);
    let mut cache = RebuildCache::new(None);
    let (without, _) = warm(&mut cache, &raw);
    assert!(missing_geometry(&without), "the import built with no blob: {}", without["errors"]);
    assert_eq!(without["bodies"].as_array().map(Vec::len), Some(2));

    // What opening the .funda that carries the geometry does, with the engine still running.
    std::fs::write(&blob, &bytes).unwrap();
    let (with, replayed) = warm(&mut cache, &raw);
    assert_eq!(with["errors"], json!([]), "the failure of before the geometry arrived was served from memory");
    assert_eq!(replayed, [1, 2], "the features that never read the blob store replayed too");
    assert_eq!(with, cold(&raw));
    assert_eq!(with["bodies"].as_array().map(Vec::len), Some(3));
}

#[test]
fn geometry_that_arrives_is_not_served_the_failure_checkpointed_without_it() {
    let (raw, blob, bytes) = stored_box(12.0);
    let root = scratch("arrives");
    {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
        cache.budget_ms = 0.0;
        cache.tip_after = Duration::ZERO;
        let (without, _) = warm(&mut cache, &raw);
        assert!(missing_geometry(&without), "the import built with no blob: {}", without["errors"]);
        assert!(cache.stats.checkpoints_written >= 3);
    }
    std::fs::write(&blob, &bytes).unwrap();
    let mut reopened = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    reopened.budget_ms = 0.0;
    let (with, replayed) = warm(&mut reopened, &raw);
    assert_eq!(with["errors"], json!([]), "the failure of before the geometry arrived was served from disk");
    assert_eq!(reopened.stats.source, Source::Disk, "the box before the import was not resumed");
    assert_eq!(replayed, [1, 2]);
    assert_eq!(with, cold(&raw));

    // Each state keeps its own checkpoints: the blob gone again is the failure again, and neither replays.
    std::fs::remove_file(&blob).unwrap();
    let mut third = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let (gone, replayed) = warm(&mut third, &raw);
    assert!(missing_geometry(&gone), "{}", gone["errors"]);
    assert!(replayed.is_empty(), "replayed {replayed:?}");
    std::fs::write(&blob, &bytes).unwrap();
    let mut fourth = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let (back, replayed) = warm(&mut fourth, &raw);
    assert!(replayed.is_empty(), "replayed {replayed:?}");
    assert_eq!(back, with);
}

#[test]
fn a_corrupt_blob_replaced_is_not_served_the_failure_it_caused() {
    let (raw, blob, bytes) = stored_box(13.0);
    let root = scratch("corrupt-blob");
    let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    cache.budget_ms = 0.0;
    cache.tip_after = Duration::ZERO;
    std::fs::write(&blob, &bytes[..bytes.len() / 2]).unwrap();
    let (torn, _) = warm(&mut cache, &raw);
    assert!(missing_geometry(&torn), "the import built from half a blob: {}", torn["errors"]);
    assert!(!blob.exists(), "the blob store kept bytes that do not hash to their name");

    std::fs::write(&blob, &bytes).unwrap();
    let (with, _) = warm(&mut cache, &raw);
    assert_eq!(with["errors"], json!([]), "the failure the corrupt blob caused was served from memory");
    assert_eq!(with, cold(&raw));
    let mut reopened = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let (again, _) = warm(&mut reopened, &raw);
    assert_eq!(again, with, "the failure the corrupt blob caused was served from disk");
}

#[test]
fn hiding_a_join_target_is_not_served_the_cached_join() {
    let mut cache = RebuildCache::new(None);
    let base = json!({"features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10, "operation": "new"},
        {"id": "b2", "type": "box", "length": 4, "width": 4, "height": 20, "operation": "join"},
        {"id": "b3", "type": "box", "length": 2, "width": 2, "height": 2, "operation": "new"},
    ]});
    let (shown, _) = warm(&mut cache, &base);
    assert_eq!(shown["bodies"].as_array().map(Vec::len), Some(2));
    let mut hidden = base.clone();
    hidden["bodyVisibility"] = json!({"body1": false});
    let (got, replayed) = warm(&mut cache, &hidden);
    assert!(replayed.contains(&1), "the join was not replayed: {replayed:?}");
    assert_eq!(got, cold(&hidden));
    assert_eq!(got["bodies"].as_array().map(Vec::len), Some(3));
}

#[test]
fn the_eye_of_a_named_target_does_not_move_the_cached_cut() {
    let base = json!({"features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10, "operation": "new"},
        {"id": "b2", "type": "box", "length": 4, "width": 4, "height": 20, "operation": "cut", "targets": ["body1"]},
        {"id": "b3", "type": "box", "length": 2, "width": 2, "height": 2, "operation": "new"},
    ]});
    let mut hidden = base.clone();
    hidden["bodyVisibility"] = json!({"body1": false});
    let reference = cold(&base);
    assert_eq!(reference["bodies"][0][5], json!(840.0), "the fixture's cut is not the box less the post");
    assert_eq!(cold(&hidden), reference, "a cold build left the hidden target uncut");
    for (first, second) in [(&base, &hidden), (&hidden, &base)] {
        let mut cache = RebuildCache::new(None);
        let (built, _) = warm(&mut cache, first);
        assert_eq!(built, reference);
        let (toggled, replayed) = warm(&mut cache, second);
        assert!(replayed.is_empty(), "an eye toggle replayed {replayed:?}");
        assert_eq!(toggled, reference);
    }
}

/// Each face's owner in face order, what a reply's `faceOwners` says.
fn face_owners(r: &Rebuild) -> Vec<Vec<Option<String>>> {
    r.bodies
        .iter()
        .map(|b| {
            kernel::subshapes(&b.shape, kernel::Kind::Face)
                .iter()
                .map(|f| builder::owners::face_key(f).and_then(|k| b.owners.get(&k).cloned()))
                .collect()
        })
        .collect()
}

fn built(raw: &Value) -> Rebuild {
    builder::rebuild(&typed(raw), raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"))
}

/// A ring of rotated tiles with tops at z 0.25, where a face fingerprint rounds either way, then a slot through the
/// first. A rotation read back from a blob is off in the last bit, so a restored tile measures a hair off.
fn tile_ring(slot: f64) -> Value {
    json!({"parameters": {}, "features": [
        {"id": "tile", "type": "box", "length": 4, "width": 1, "height": 0.5, "operation": "new"},
        {"id": "out", "type": "move", "bodies": ["body1"], "dx": 20},
        {"id": "ring", "type": "patternCircular", "bodies": ["body1"], "count": 29, "angle": 360, "axis": "Z"},
        {"id": "slot", "type": "box", "length": 60, "width": slot, "height": 6, "operation": "cut", "targets": ["body1"]},
    ]})
}

#[test]
fn face_owners_survive_a_disk_resume_of_faces_measuring_on_a_rounding_tie() {
    let root = scratch("ties");
    let base = tile_ring(0.4);
    let reference = face_owners(&built(&base));
    assert!(reference[0].len() > 150, "the fixture lost its ring: {} faces", reference[0].len());
    assert!(reference[0].iter().all(Option::is_some), "a cold build left a face without an owner");
    {
        let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
        cache.budget_ms = 0.0;
        cache.tip_after = Duration::ZERO;
        let first = cache.rebuild(&typed(&base), &base, &NoWatch).unwrap();
        assert_eq!(face_owners(&first), reference);
    }

    let mut reopened = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    reopened.budget_ms = 0.0;
    reopened.tip_after = Duration::ZERO;
    let restored = reopened.rebuild(&typed(&base), &base, &NoWatch).unwrap();
    assert_eq!(reopened.stats.source, Source::Disk);
    assert!(reopened.stats.replayed.is_empty());
    assert_eq!(face_owners(&restored), reference, "faces lost their owner in a rebuild answered from disk");

    // The slot replays on the restored ring: the tiles it leaves alone keep the owner they had.
    let edited = tile_ring(0.6);
    let mut third = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    third.budget_ms = 0.0;
    third.tip_after = Duration::ZERO;
    let resumed = third.rebuild(&typed(&edited), &edited, &NoWatch).unwrap();
    assert_eq!(third.stats.source, Source::Disk);
    assert_eq!(third.stats.replayed, [3]);
    assert_eq!(
        face_owners(&resumed),
        face_owners(&built(&edited)),
        "a feature replayed on a restored body owns faces it did not make"
    );

    // A checkpoint written from a restored body restores the same way.
    let mut fourth = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let again = fourth.rebuild(&typed(&edited), &edited, &NoWatch).unwrap();
    assert_eq!(fourth.stats.source, Source::Disk);
    assert!(fourth.stats.replayed.is_empty());
    assert_eq!(face_owners(&again), face_owners(&built(&edited)), "faces lost their owner in the second restore");
}

#[test]
fn releasing_the_cache_drops_its_snapshots_and_payloads_and_the_next_build_is_whole() {
    let raw = doc();
    let mut cache = RebuildCache::new(None);
    let (first, _) = warm(&mut cache, &raw);
    let (snapshots, payloads) = cache.holding();
    assert!(snapshots > 0 && payloads > 0, "a build held nothing: {:?}", cache.holding());

    cache.release();
    assert_eq!(cache.holding(), (0, 0));
    let (after, replayed) = warm(&mut cache, &raw);
    assert_eq!((after, replayed.len(), cache.stats.source), (first, 6, Source::Full));

    // A second document builds on a released cache as on a fresh one.
    let other = edit(&raw, 4, "length", json!(9));
    let mut fresh = RebuildCache::new(None);
    cache.release();
    assert_eq!(warm(&mut cache, &other).0, warm(&mut fresh, &other).0);
}

#[test]
fn a_cancelled_mesh_pass_meshes_no_body_and_answers_none() {
    let raw = doc();
    let r = builder::rebuild(&typed(&raw), &raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    let mut cache = RebuildCache::new(None);
    let token = fundacad_protocol::CancelToken::new();
    let _installed = fundacad_geom::cancel::install(Some(token.clone()));

    let mut ticks = 0;
    let whole = cache.mesh(&r, TOL, &Map::new(), &mut |_, _| ticks += 1);
    assert_eq!((whole.bodies.len(), ticks, cache.stats.meshed), (r.bodies.len(), r.bodies.len(), r.bodies.len()));

    token.cancel();
    let mut stopped = RebuildCache::new(None);
    let mut ticks = 0;
    let none = stopped.mesh(&r, TOL, &Map::new(), &mut |_, _| ticks += 1);
    assert_eq!((none.bodies.len(), ticks, stopped.stats.meshed, stopped.holding()), (0, 0, 0, (0, 0)));
}
