//! The stages an import reports while it runs, read by the engine's `importing` frames.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use fundacad_geom::import::{self, blobstore::BlobStore, stage};

type Seen = Arc<Mutex<Vec<(i64, i64, i64)>>>;

fn import_watching(path: &std::path::Path, fmt: &str) -> Vec<(i64, i64, i64)> {
    let dir = std::env::temp_dir().join(format!("fundacad-import-progress-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = BlobStore::open(&dir).unwrap();
    let seen: Seen = Arc::default();
    let sink = seen.clone();
    let _hook = stage::install(Some(Arc::new(move |s, d, t| sink.lock().unwrap().push((s, d, t)))));
    import::import_geometry(&path.to_string_lossy(), fmt, &store).unwrap();
    let out = seen.lock().unwrap().clone();
    out
}

fn assert_in_order(seen: &[(i64, i64, i64)]) {
    for w in seen.windows(2) {
        let ((a, da, _), (b, db, _)) = (w[0], w[1]);
        assert!(b > a || (b == a && db >= da), "went back from {:?} to {:?} in {seen:?}", w[0], w[1]);
    }
}

fn stages(seen: &[(i64, i64, i64)]) -> Vec<i64> {
    let mut out: Vec<i64> = seen.iter().map(|s| s.0).collect();
    out.dedup();
    out
}

#[test]
fn a_step_assembly_reports_read_build_n_of_parts_then_store() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/asm_colors.step");
    let seen = import_watching(&path, "step");
    assert_in_order(&seen);
    let order = stages(&seen);
    assert_eq!(order.first(), Some(&stage::READ), "{seen:?}");
    assert_eq!(order.last(), Some(&stage::STORE), "{seen:?}");
    assert!(order.contains(&stage::BUILD), "{seen:?}");
    let counted: Vec<_> = seen.iter().filter(|s| s.0 == stage::BUILD && s.2 > 0).collect();
    assert!(counted.len() >= 2, "one BUILD report per part: {seen:?}");
    assert!(counted.iter().all(|s| s.1 < s.2));
}

#[test]
fn a_mesh_file_reports_read_build_then_store() {
    let dir = std::env::temp_dir().join(format!("fundacad-import-progress-stl-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tet.stl");
    let facet = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| {
        format!(
            "facet normal 0 0 0\nouter loop\nvertex {} {} {}\nvertex {} {} {}\nvertex {} {} {}\nendloop\nendfacet\n",
            a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]
        )
    };
    let (o, x, y, z) = ([0.0; 3], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0]);
    let body = [facet(o, y, x), facet(o, x, z), facet(o, z, y), facet(x, y, z)].concat();
    std::fs::write(&path, format!("solid tet\n{body}endsolid tet\n")).unwrap();
    let seen = import_watching(&path, "stl");
    assert_in_order(&seen);
    assert_eq!(stages(&seen), vec![stage::READ, stage::BUILD, stage::STORE], "{seen:?}");
}
