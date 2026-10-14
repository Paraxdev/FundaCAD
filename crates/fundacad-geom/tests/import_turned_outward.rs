//! A file whose solids face into their material is turned outward where it is
//! read, and the import says so. A document that already stores such a solid
//! keeps it as it is, since a face selector saved against it carries the
//! normal it had, and keeps the build's warning. tests/fixtures/inside_out_*
//! are written by tests/step/gen_inside_out.py.

#[allow(dead_code)]
mod unsound;

use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::import::brep_b64_to_shape;
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel;
use opencascade::primitives::Shape;
use opencascade::xcaf;
use serde_json::{json, Map, Value};

const TURNED: &str = "1 solid was inside out, its faces pointed into the material, so it was turned outward";

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-outward-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"))
}

fn imported(path: &PathBuf, fmt: &str) -> Map<String, Value> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&path.to_string_lossy(), fmt, &store).unwrap()
}

/// A 10 mm cube as an STL file, its triangles wound clockwise seen from
/// outside when `inside_out`.
fn cube_stl(inside_out: bool) -> PathBuf {
    let q = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
    let facets = [
        [0, 2, 1], [0, 3, 2], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7], [4, 5, 6], [4, 6, 7],
    ];
    let mut stl = String::from("solid cube\n");
    for f in facets {
        let f = if inside_out { [f[0], f[2], f[1]] } else { f };
        stl.push_str("facet normal 0 0 0\nouter loop\n");
        for i in f {
            stl.push_str(&format!("vertex {} {} {}\n", q[i][0], q[i][1], q[i][2]));
        }
        stl.push_str("endloop\nendfacet\n");
    }
    stl.push_str("endsolid cube\n");
    let path = blob_dir().join(if inside_out { "inward.stl" } else { "outward.stl" });
    std::fs::write(&path, stl).unwrap();
    path
}

/// The feature the app writes from an import reply.
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

fn said(reply: &Map<String, Value>) -> Vec<&str> {
    reply.get("notes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

fn warnings(r: &Rebuild) -> Vec<(&str, &str)> {
    r.diagnostics.iter().map(|d| (d["code"].as_str().unwrap_or(""), d["reason"].as_str().unwrap_or(""))).collect()
}

fn faces_outward(shape: &Shape, volume: f64) {
    let v = kernel::volume(shape);
    assert!((v - volume).abs() < 1e-6, "volume {v}, want {volume}");
    assert!(kernel::inward_solids(shape) == 0, "a solid still faces inward");
}

#[test]
fn a_mesh_wound_inside_out_is_turned_outward_and_the_import_says_so() {
    let reply = imported(&cube_stl(true), "stl");
    assert_eq!(said(&reply), [TURNED]);
    let r = build(reply, "stl");
    assert_eq!(r.bodies.len(), 1);
    faces_outward(&r.bodies[0].shape, 1000.0);
    assert_eq!(warnings(&r), [("importNote", TURNED)], "the import says so, the body is no longer at fault");
}

/// The BREP text of a 10 mm cube centred on the origin, edited by `edit`, as a
/// .brep file.
fn cube_brep(edit: unsound::Edit, name: &str) -> PathBuf {
    let text = fundacad_geom::features::import::base64_decode(&unsound::cube_brep(edit)).unwrap();
    let path = blob_dir().join(name);
    std::fs::write(&path, text).unwrap();
    path
}

#[test]
fn a_brep_file_inside_out_is_turned_outward() {
    let reply = imported(&cube_brep(unsound::inside_out, "inward.brep"), "brep");
    assert_eq!(said(&reply), [TURNED]);
    let r = build(reply, "brep");
    faces_outward(&r.bodies[0].shape, 1000.0);
    assert_eq!(warnings(&r), [("importNote", TURNED)]);
}

/// One whose faces disagree with each other has no one way to face, so it is
/// left as the file has it for the build to warn about.
#[test]
fn a_solid_whose_faces_disagree_is_left_as_it_is() {
    let reply = imported(&cube_brep(unsound::one_face_turned, "mixed.brep"), "brep");
    assert!(said(&reply).is_empty(), "{:?}", said(&reply));
    let r = build(reply, "brep");
    assert_eq!(kernel::skin(&r.bodies[0].shape).flipped_edges, 4);
    assert_eq!(
        warnings(&r),
        [(
            "flippedFaces",
            "mixed has faces that point the wrong way, at 4 of its edges the two faces disagree about which side is inside"
        )]
    );
}

/// The STEP reader holds the shell of a solid it turned outward reversed. It
/// does the same to a solid whose faces disagree, which then faces no one way
/// and measures a volume of either sign, so that one is not said to be turned.
#[test]
fn only_a_solid_the_reader_left_facing_outward_is_said_to_be_turned() {
    let shape = |edit| brep_b64_to_shape(&unsound::cube_brep(edit)).unwrap_or_else(|_| panic!("decodes"));
    let turned = shape(unsound::shell_reversed_faces_turned);
    assert!((kernel::volume(&turned) - 1000.0).abs() < 1e-6, "{}", kernel::volume(&turned));
    assert_eq!(kernel::reader_turned_solids(&turned), 1);

    let mixed = shape(unsound::shell_reversed_four_faces_turned);
    assert!(kernel::volume(&mixed) > 0.0, "{}", kernel::volume(&mixed));
    assert!(kernel::skin(&mixed).flipped_edges > 0);
    assert_eq!(kernel::reader_turned_solids(&mixed), 0);

    assert_eq!(kernel::reader_turned_solids(&shape(unsound::sound)), 0);
}

/// The STEP reader turns a solid outward itself as it reads it, the import
/// says which. It also mends a solid whose faces disagree and then turns that
/// one too, which is OCCT's healing and not undone here.
#[test]
fn a_step_file_written_inside_out_comes_in_outward_and_the_import_says_so() {
    let reply = imported(&fixture("inside_out_cube.step"), "step");
    assert_eq!(said(&reply), [TURNED]);
    let r = build(reply, "step");
    faces_outward(&r.bodies[0].shape, 1000.0);
    assert_eq!(warnings(&r), [("importNote", TURNED)]);

    let reply = imported(&fixture("inside_out_parts.step"), "step");
    let notes = [format!("Housing 2: {TURNED}"), format!("Housing 3: {TURNED}")];
    assert_eq!(said(&reply), notes);
    let r = build(reply, "step");
    for (body, volume) in r.bodies.iter().zip([1000.0, 216.0, 512.0]) {
        faces_outward(&body.shape, volume);
    }
    assert_eq!(warnings(&r), notes.iter().map(|n| ("importNote", n.as_str())).collect::<Vec<_>>());
}

#[test]
fn a_file_that_faces_outward_says_nothing() {
    let reply = imported(&cube_stl(false), "stl");
    assert!(said(&reply).is_empty(), "{:?}", said(&reply));
    let r = build(reply, "stl");
    faces_outward(&r.bodies[0].shape, 1000.0);
    assert!(warnings(&r).is_empty(), "{:?}", warnings(&r));
    for name in ["asm_multisolid.step", "asm_nested.step", "loose_faces_solid.step"] {
        let reply = imported(&fixture(name), "step");
        assert!(!said(&reply).iter().any(|n| n.contains("inside out")), "{name}: {:?}", said(&reply));
    }
}

/// A document saved before imports were turned holds the inward solid in its
/// blob, and builds it as it always did, warning and all.
#[test]
fn a_stored_inside_out_blob_builds_as_it_did() {
    let old = brep_b64_to_shape(&unsound::cube_brep(unsound::inside_out)).unwrap_or_else(|_| panic!("decodes"));
    assert!(kernel::volume(&old) < 0.0, "the stand-in for an old blob is not inside out");
    let store = BlobStore::open(blob_dir()).unwrap();
    let geom = store.put_bytes(&xcaf::to_bin_v3(&old).unwrap()).unwrap();
    let mut f = Map::new();
    f.insert("name".into(), json!("Shell"));
    f.insert("geom".into(), json!(geom));
    f.insert("solid".into(), json!(true));
    let r = build(f, "stl");
    assert!(kernel::volume(&r.bodies[0].shape) < 0.0, "the stored geometry is not turned at build time");
    assert_eq!(
        warnings(&r),
        [(
            "insideOut",
            "Shell is inside out, its faces point into the material, so a cut, a join or a measurement of it can come out wrong"
        )]
    );
}
