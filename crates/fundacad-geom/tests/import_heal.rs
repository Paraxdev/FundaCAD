//! A solid whose file draws an edge away from the faces it bounds is healed where the file is read.
//! tests/fixtures/heal_edge_off.step is written by tests/step/gen_heal_edge_off.py.

use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

/// 20 x 12 x 8 with a through hole of radius 3.
const BLOCK_VOLUME: f64 = 1693.805328941535;

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-heal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}.step"))
}

fn imported(name: &str) -> Map<String, Value> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&fixture(name).to_string_lossy(), "step", &store).unwrap()
}

fn build(reply: Map<String, Value>) -> Rebuild {
    let mut f = reply;
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("step"));
    let doc = json!({"version": 1, "parameters": {}, "features": [f]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn said(reply: &Map<String, Value>) -> Vec<String> {
    reply
        .get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect()
}

fn sound(shape: &Shape) -> Result<(), String> {
    let skin = kernel::skin(shape);
    if skin.solids != 1 || skin.open_edges + skin.crowded_edges + skin.flipped_edges != 0 {
        return Err(format!(
            "{} solids, {} open, {} crowded, {} flipped edges",
            skin.solids, skin.open_edges, skin.crowded_edges, skin.flipped_edges
        ));
    }
    if !shape.is_valid().unwrap_or(false) {
        return Err("the kernel's check rejects it".into());
    }
    Ok(())
}

#[test]
fn an_edge_drawn_off_its_faces_is_redrawn_where_they_meet() {
    let reply = imported("heal_edge_off");
    let notes = said(&reply);
    assert_eq!(reply["solid"], json!(true), "{notes:?}");
    let r = build(reply);
    assert_eq!(r.bodies.len(), 1);
    let block = &r.bodies[0].shape;
    sound(block).unwrap();
    let got = kernel::volume(block);
    assert!((got - BLOCK_VOLUME).abs() < 1e-3 * BLOCK_VOLUME, "volume {got}, want {BLOCK_VOLUME}");
    let (away, widest) = opencascade::xcaf::edges_away(block, 1e-3);
    assert_eq!(away, 0, "an edge is still {widest} mm from its faces");
    let tolerance = opencascade::xcaf::widest_tolerance(block);
    assert!(tolerance <= 1e-3, "tolerance {tolerance}");
    let heal = notes.iter().find(|n| n.contains("redrawn")).unwrap_or_else(|| panic!("{notes:?}"));
    assert!(
        heal.contains("1 edge the file draws up to 3 mm away from its faces was redrawn where they meet"),
        "{heal}"
    );
    assert!(notes.iter().all(|n| !n.contains("a section or a mesh")), "{notes:?}");
}

/// The post of loose_faces_mixed ends on an edge 2 mm below where its round
/// face meets its back, and those faces meet nowhere between its ends.
#[test]
fn an_edge_whose_faces_do_not_meet_keeps_the_body_as_read() {
    let reply = imported("loose_faces_mixed");
    let notes = said(&reply);
    let r = build(reply);
    let post = &r.bodies[2].shape;
    assert_eq!(kernel::count(post, Kind::Face), 3);
    assert_eq!(kernel::count(post, Kind::Solid), 1);
    let (away, widest) = opencascade::xcaf::edges_away(post, 1e-3);
    assert_eq!(away, 1);
    assert!((widest - 2.0).abs() < 0.1, "{widest}");
    let note = notes
        .iter()
        .find(|n| n.starts_with("Housing 3") && n.contains("1 edge is drawn up to 2 mm away"))
        .unwrap_or_else(|| panic!("{notes:?}"));
    assert!(note.contains("it was not redrawn because the faces do not meet between the edge's ends"), "{note}");
}

/// Blob hashes of imports before the heal existed.
#[test]
fn a_file_that_needs_no_healing_stores_the_same_blob() {
    for (name, geom) in [
        ("loose_faces_solid", "4ae830ed9768df57b13f7cfe1c53c2e1"),
        ("asm_multisolid", "df988bd93ee6c3fc1c5bc89f628051ab"),
    ] {
        let reply = imported(name);
        let notes = said(&reply);
        assert!(notes.iter().all(|n| !n.contains("redrawn")), "{name}: {notes:?}");
        // Note: the kernel writes a few different bits per platform, these hashes were taken on Windows.
        if cfg!(windows) {
            assert_eq!(reply["geom"], json!(geom), "{name}");
        }
    }
}
