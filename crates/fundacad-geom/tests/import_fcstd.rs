//! FreeCAD documents, tests/fixtures/*.FCStd written by tests/step/gen_fcstd.py.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Map, Value};

use std::f64::consts::PI;

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-fcstd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"))
}

fn import_path(path: &std::path::Path) -> Result<Map<String, Value>, String> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&path.to_string_lossy(), "fcstd", &store)
}

fn build(reply: Map<String, Value>) -> Rebuild {
    let mut f = reply;
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("fcstd"));
    let doc = json!({"version": 1, "parameters": {}, "features": [f]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn near(got: f64, want: f64) {
    assert!((got - want).abs() < 0.05, "volume {got}, want {want}");
}

#[test]
fn the_visible_solids_come_in_with_their_labels() {
    let reply = import_path(&fixture("plate.FCStd")).unwrap();
    assert_eq!(reply["solid"], json!(true));
    let r = build(reply);
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Plate with hole", "Ball"]);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Face), 7);
    near(kernel::volume(&r.bodies[0].shape), 40.0 * 20.0 * 5.0 - PI * 16.0 * 5.0);
    near(kernel::volume(&r.bodies[1].shape), 4.0 / 3.0 * PI * 125.0);
}

#[test]
fn a_body_and_its_tip_come_in_once_where_the_part_places_them() {
    let reply = import_path(&fixture("bracket.FCStd")).unwrap();
    let r = build(reply);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].name, "Bracket");
    near(kernel::volume(&r.bodies[0].shape), 2400.0);
    let b = kernel::bbox(&r.bodies[0].shape).unwrap();
    assert!((b[0] - 100.0).abs() < 1e-6 && (b[3] - 130.0).abs() < 1e-6, "{b:?}");
}

#[test]
fn a_document_without_a_solid_says_so() {
    let path = std::env::temp_dir().join(format!("fundacad-fcstd-empty-{}.FCStd", std::process::id()));
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("Document.xml", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><Document SchemaVersion="4"><Objects Count="0"/><ObjectData Count="0"/></Document>"#)
        .unwrap();
    zip.finish().unwrap();
    let e = import_path(&path).unwrap_err();
    let _ = std::fs::remove_file(&path);
    assert!(e.contains("no visible solid"), "{e}");
}

#[test]
fn a_file_that_is_not_a_freecad_document_says_so() {
    let e = import_path(&fixture("two_parts_mode1.igs")).unwrap_err();
    assert!(e.contains("FreeCAD"), "{e}");
}
