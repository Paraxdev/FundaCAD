//! IGES files, tests/fixtures/*.igs written by tests/step/gen_iges.py.

use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

const BRACKET_VOLUME: f64 = 20.0 * 12.0 * 8.0;
const PLUG_VOLUME: f64 = std::f64::consts::PI * 16.0 * 6.0;
const RED: [f64; 3] = [0.8, 0.1, 0.1];
const BLUE: [f64; 3] = [0.1, 0.2, 0.9];

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-iges-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"))
}

fn imported(name: &str, fmt: &str) -> Map<String, Value> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&fixture(name).to_string_lossy(), fmt, &store).unwrap()
}

fn build(reply: Map<String, Value>, fmt: &str) -> Rebuild {
    let mut f = reply;
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!(fmt));
    let doc = json!({"version": 1, "parameters": {}, "features": [f]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

/// The file holds linear RGB, a reply holds sRGB.
fn is_color(hex: Option<&str>, linear: [f64; 3]) -> bool {
    let Some(h) = hex else { return false };
    let v = i64::from_str_radix(h.trim_start_matches('#'), 16).unwrap();
    let got = [v >> 16 & 255, v >> 8 & 255, v & 255];
    got.iter().zip(linear).all(|(g, l)| {
        let s = if l <= 0.003_130_8 { 12.92 * l } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
        (*g as f64 - s * 255.0).abs() <= 1.5
    })
}

fn holds(shape: &Shape, volume: f64) {
    assert_eq!(kernel::count(shape, Kind::Solid), 1);
    assert_eq!(kernel::open_edge_count(shape), 0);
    let got = kernel::volume(shape);
    assert!((got - volume).abs() < 0.05, "volume {got}, want {volume}");
}

fn two_named_parts(name: &str) {
    let reply = imported(name, "iges");
    assert_eq!(reply["solid"], json!(true));
    assert_eq!(reply["parts"].as_array().map(Vec::len), Some(2), "{reply:?}");
    let r = build(reply, "iges");
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Bracket", "Plug"]);
    holds(&r.bodies[0].shape, BRACKET_VOLUME);
    holds(&r.bodies[1].shape, PLUG_VOLUME);
    for (body, want) in r.bodies.iter().zip([RED, BLUE]) {
        let faces = kernel::count(&body.shape, Kind::Face);
        let face = fundacad_core::face_colors::decode_value(body.face_colors.as_ref(), faces);
        let painted = is_color(body.part_color.as_deref(), want)
            || (face.iter().all(|c| is_color(c.as_deref(), want)) && !face.is_empty());
        assert!(painted, "{}: {:?} {:?}", body.name, body.part_color, face);
    }
}

#[test]
fn iges_solids_keep_their_names_and_colours() {
    two_named_parts("two_parts_mode1.igs");
}

#[test]
fn iges_trimmed_surfaces_sew_into_named_solids() {
    two_named_parts("two_parts_mode0.igs");
}

#[test]
fn igs_is_the_same_format() {
    let reply = imported("two_parts_mode1.igs", "IGS");
    assert_eq!(reply["parts"].as_array().map(Vec::len), Some(2));
}

#[test]
fn iges_faces_written_one_by_one_sew_into_one_solid() {
    let reply = imported("face_soup.igs", "iges");
    assert_eq!(reply["solid"], json!(true), "{reply:?}");
    let r = build(reply, "iges");
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].name, "face_soup");
    holds(&r.bodies[0].shape, BRACKET_VOLUME - std::f64::consts::PI * 9.0 * 8.0);
}

#[test]
fn a_step_file_is_not_read_as_iges() {
    let store = BlobStore::open(blob_dir()).unwrap();
    let e = import::import_geometry(&fixture("asm_flat.step").to_string_lossy(), "iges", &store).unwrap_err();
    assert!(e.contains("IGES"), "{e}");
}
