use fundacad_geom::cache::store::*;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-geomstore-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn entry(body: &str, blob: &str) -> ManifestEntry {
    ManifestEntry {
        body_id: body.into(),
        name: body.into(),
        blob_key: blob.into(),
        node_ref: None,
        intact: false,
        scan: false,
        face_colors: None,
        part_color: None,
        mesh_passes: Vec::new(),
    }
}

fn cp(index: usize, manifest: Vec<ManifestEntry>, replay_ms: f64) -> Checkpoint {
    Checkpoint { feat_index: index, manifest, state: Value::Null, replay_ms, bytes: 0, pinned: false }
}

fn key(n: u8) -> String {
    format!("{n:02x}").repeat(16)
}

#[test]
fn a_temp_file_from_a_crash_is_swept() {
    let root = scratch("tmp");
    GeomStore::open(&root).unwrap();
    fs::write(root.join("tmp").join("junk.tmp"), b"x").unwrap();
    GeomStore::open(&root).unwrap();
    assert_eq!(fs::read_dir(root.join("tmp")).unwrap().count(), 0);
}

#[test]
fn purge_keeps_blobs_another_checkpoint_needs() {
    let s = GeomStore::open(scratch("purge")).unwrap();
    let shape = fundacad_geom::kernel::make_box(1.0, 2.0, 3.0).unwrap();
    s.put_blob(&key(1), &shape).unwrap();
    s.put_blob(&key(2), &shape).unwrap();
    s.save_checkpoint(&key(40), cp(0, vec![entry("a", &key(1)), entry("b", &key(2))], 1.0)).unwrap();
    s.save_checkpoint(&key(41), cp(0, vec![entry("a", &key(1))], 1.0)).unwrap();
    assert_eq!(s.purge(&[key(40)]), 1);
    assert!(s.has_blob(&key(1)) && !s.has_blob(&key(2)));
}
