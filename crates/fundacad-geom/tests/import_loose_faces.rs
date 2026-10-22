//! A STEP file whose faces share no edge, so the reader hands back loose faces where it declared solids.
//! tests/fixtures/loose_faces_*.step are written by tests/step/gen_loose_faces.py.

use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use opencascade::xcaf;
use serde_json::{json, Map, Value};

/// The bracket the fixtures were cut from: a 20 x 12 x 8 block with a
/// through hole of radius 3 and one edge rounded at radius 2.
const BRACKET_VOLUME: f64 = 1680.0708113989717;
/// A plug of radius 4 and height 6.
const PLUG_VOLUME: f64 = 301.5928947446201;
const RED: [f64; 3] = [0.8, 0.1, 0.1];
const YELLOW: [f64; 3] = [0.9, 0.8, 0.1];
const BLUE: [f64; 3] = [0.1, 0.2, 0.9];
const ORANGE: [f64; 3] = [0.9, 0.5, 0.1];
const GREEN: [f64; 3] = [0.1, 0.7, 0.2];

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-loose-{}", std::process::id()));
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

/// The feature the app writes from an import reply.
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

fn said(reply: &Map<String, Value>) -> Vec<&str> {
    reply.get("notes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

fn warnings(r: &Rebuild) -> Vec<&str> {
    r.diagnostics.iter().filter_map(|d| d["reason"].as_str()).collect()
}

fn channels(hex: &str) -> [i32; 3] {
    let v = i32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap();
    [v >> 16 & 255, v >> 8 & 255, v & 255]
}

fn is_color(hex: Option<&str>, want: [f64; 3]) -> bool {
    hex.is_some_and(|h| channels(h).iter().zip(want).all(|(got, w)| (f64::from(*got) - w * 255.0).abs() <= 1.0))
}

fn is_closed_solid(shape: &Shape) -> Result<(), String> {
    let solids = kernel::count(shape, Kind::Solid);
    if solids != 1 {
        return Err(format!("{solids} solids"));
    }
    if kernel::open_edge_count(shape) != 0 {
        return Err(format!("{} open edges", kernel::open_edge_count(shape)));
    }
    if !shape.is_valid().unwrap_or(false) {
        return Err("the kernel's check rejects it".into());
    }
    if kernel::volume(shape) <= 0.0 {
        return Err(format!("volume {}, it faces inward", kernel::volume(shape)));
    }
    Ok(())
}

fn holds(shape: &Shape, volume: f64) -> Result<(), String> {
    is_closed_solid(shape)?;
    let got = kernel::volume(shape);
    // The fixture moves two faces by 0.4 micron, inside the sewing tolerance.
    if (got - volume).abs() > 0.05 {
        return Err(format!("volume {got}, want {volume}"));
    }
    Ok(())
}

#[test]
fn loose_faces_that_close_import_as_one_solid() {
    let reply = imported("loose_faces_solid");
    assert_eq!(reply["solid"], json!(true), "the import reports a surface");
    assert_eq!(reply["faces"], json!(9));
    assert!(said(&reply).is_empty(), "{:?}", said(&reply));
    let r = build(reply);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].name, "loose_faces_solid");
    holds(&r.bodies[0].shape, BRACKET_VOLUME).unwrap();
    assert!(warnings(&r).is_empty(), "{:?}", warnings(&r));
}

#[test]
fn each_declared_solid_closes_on_its_own_and_keeps_its_name_and_colours() {
    let reply = imported("loose_faces_mixed");
    assert_eq!(reply["solid"], json!(true));
    assert_eq!(reply["parts"].as_array().map(Vec::len), Some(4), "one part per declared solid");

    let r = build(reply);
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Housing 1", "Housing 2", "Housing 3", "Housing 4"]);
    holds(&r.bodies[0].shape, BRACKET_VOLUME).unwrap();
    for (body, want) in r.bodies.iter().zip([RED, BLUE, ORANGE]) {
        assert!(is_color(body.part_color.as_deref(), want), "{}: {:?}", body.name, body.part_color);
    }

    // The file paints the hole alone, and sewing reorders the faces.
    let faces = kernel::subshapes(&r.bodies[0].shape, Kind::Face);
    let colors = fundacad_core::face_colors::decode_value(r.bodies[0].face_colors.as_ref(), faces.len());
    let painted: Vec<&Shape> = faces.iter().zip(&colors).filter(|(_, c)| c.is_some()).map(|(f, _)| f).collect();
    assert_eq!(painted.len(), 1, "{colors:?}");
    assert!(colors.iter().flatten().all(|c| is_color(Some(c), YELLOW)), "{colors:?}");
    let hole = 2.0 * std::f64::consts::PI * 3.0 * 8.0;
    assert!((kernel::area(painted[0]) - hole).abs() < 1e-3, "{} is not the hole", kernel::area(painted[0]));
}

#[test]
fn a_face_the_file_gets_wrong_does_not_spoil_its_solid() {
    let reply = imported("loose_faces_mixed");
    let notes: Vec<String> = said(&reply).iter().map(|n| n.to_string()).collect();
    let r = build(reply);

    // The plug's top went out as a cylinder of no height, and comes back flat.
    holds(&r.bodies[1].shape, PLUG_VOLUME).unwrap();
    assert_eq!(kernel::count(&r.bodies[1].shape, Kind::Face), 3);
    let flat = notes.iter().find(|n| n.starts_with("Housing 2")).expect("nothing names the plug");
    assert!(flat.contains("1 face with no area became a flat face"), "{flat}");

    // The post's round face ends on an edge 2 mm away that the reader lays on the far half of the cylinder.
    // Its bottom is that edge, so no volume is expected of it.
    is_closed_solid(&r.bodies[2].shape).unwrap();
    assert_eq!(kernel::count(&r.bodies[2].shape, Kind::Face), 3);
    let post: Vec<&String> = notes.iter().filter(|n| n.starts_with("Housing 3")).collect();
    assert!(post.iter().any(|n| n.contains("1 face has an edge the file draws up to 2 mm away")), "{post:?}");
    assert!(post.iter().any(|n| n.contains("1 edge is drawn up to 2 mm away from the faces it bounds")), "{post:?}");
}

#[test]
fn what_does_not_close_stays_a_surface_and_the_feature_says_so() {
    let reply = imported("loose_faces_mixed");
    let notes: Vec<String> = said(&reply).iter().map(|n| n.to_string()).collect();
    let r = build(reply);
    let tray = &r.bodies[3];
    assert_eq!(kernel::count(&tray.shape, Kind::Solid), 0);
    assert_eq!(kernel::count(&tray.shape, Kind::Shell), 1, "its faces are joined");
    assert_eq!(kernel::count(&tray.shape, Kind::Face), 5);
    let colors = fundacad_core::face_colors::decode_value(tray.face_colors.as_ref(), 5);
    assert!(colors.iter().all(|c| is_color(c.as_deref(), GREEN)), "{colors:?}");

    assert_eq!(warnings(&r), notes, "the build repeats what the import said");
    let open = notes.iter().find(|n| n.starts_with("Housing 4")).expect("nothing names the tray");
    assert_eq!(open, "Housing 4: 5 faces did not close into a solid and stay a surface, 4 open edges");
    // The history chip has room for one note, the first.
    assert_eq!(notes.first(), Some(open), "{notes:?}");
    assert!(!notes.iter().any(|n| n.starts_with("Housing 1")), "{notes:?}");
}

/// A document saved before the import sewed anything holds the loose faces in
/// its blob and no note, and builds the surface body it always did.
#[test]
fn a_stored_blob_of_loose_faces_builds_as_it_did() {
    let raw = Shape::read_step(fixture("loose_faces_solid")).unwrap();
    assert_eq!(kernel::count(&raw, Kind::Solid), 0);
    let store = BlobStore::open(blob_dir()).unwrap();
    let geom = store.put_bytes(&xcaf::to_bin_v3(&raw).unwrap()).unwrap();
    let mut f = Map::new();
    f.insert("name".into(), json!("Bracket"));
    f.insert("geom".into(), json!(geom));
    f.insert("solid".into(), json!(false));
    let r = build(f);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 0);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Shell), 9);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Face), 9);
    assert!(warnings(&r).is_empty(), "{:?}", warnings(&r));
}

/// A file that holds proper solids goes through none of this.
#[test]
fn a_file_of_proper_solids_is_read_as_before() {
    for name in ["asm_multisolid", "asm_face_colors", "asm_empty_product", "asm_nested"] {
        let reply = imported(name);
        assert!(said(&reply).is_empty(), "{name}: {:?}", said(&reply));
    }
}
