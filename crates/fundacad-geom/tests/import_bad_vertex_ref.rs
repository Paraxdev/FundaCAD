//! A STEP whose EDGE_CURVE names another edge as its end vertex, the SolidWorks 2014 fault of the Aventador model.
//! tests/fixtures/sbsm_bad_vertex_ref.step is loose_faces_solid.step with its nine open shells in one
//! SHELL_BASED_SURFACE_MODEL and the end vertex of EDGE_CURVE #21 written as #31, another EDGE_CURVE.

use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_geom::import::{self, blobstore::BlobStore, step_refs};
use serde_json::{Map, Value};

const BAD_EDGE: &str = "#21 = EDGE_CURVE('',#22,#31,#26,.T.);";
const GOOD_EDGE: &str = "#21 = EDGE_CURVE('',#22,#24,#26,.T.);";

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-bad-vertex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/sbsm_bad_vertex_ref.step")
}

fn variant(name: &str, edit: impl Fn(&str) -> String) -> PathBuf {
    let text = std::fs::read_to_string(fixture()).unwrap();
    let out = blob_dir().join(name);
    std::fs::write(&out, edit(&text)).unwrap();
    out
}

fn import(path: &PathBuf, fmt: &str) -> Result<Map<String, Value>, String> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(path.to_str().unwrap(), fmt, &store)
}

fn notes(out: &Map<String, Value>) -> Vec<String> {
    out.get("notes")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

#[test]
fn the_fixture_holds_the_fault() {
    assert!(std::fs::read_to_string(fixture()).unwrap().contains(BAD_EDGE));
}

#[test]
fn the_mistyped_vertex_is_taken_from_the_edge_before_it_in_the_loop() {
    let repaired = step_refs::repair(&fixture()).unwrap().expect("the bad vertex is found");
    assert_eq!((repaired.fixed, repaired.unfixed), (1, 0));
    let text = std::fs::read_to_string(repaired.path()).unwrap();
    assert!(text.contains(GOOD_EDGE), "the repaired file names #24 again");
    assert!(!text.contains(BAD_EDGE));
}

/// The Aventador's own fault: the vertex record is missing, its id went to an edge, every edge at it names that id.
fn missing_vertex(t: &str) -> String {
    t.replace(BAD_EDGE, GOOD_EDGE)
        .replace("#24 = VERTEX_POINT('',#25);", "#24 = EDGE_CURVE('',#22,#32,#34,.T.);")
        .replace(
            "#26 = LINE('',#27,#28);",
            "#26 = B_SPLINE_CURVE_WITH_KNOTS('',1,(#27,#25),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,18.),.UNSPECIFIED.);",
        )
}

#[test]
fn a_vertex_whose_id_went_to_an_edge_is_made_on_the_end_of_its_curve() {
    let file = variant("missing_vertex_scan.step", missing_vertex);
    let repaired = step_refs::repair(&file).unwrap().expect("the missing vertex is found");
    assert_eq!(repaired.unfixed, 0);
    assert!(repaired.fixed >= 1);
    let text = std::fs::read_to_string(repaired.path()).unwrap();
    assert!(text.contains("=VERTEX_POINT('',#25);"), "a new vertex on the B-spline's last control point");
    let out = import(&variant("missing_vertex.step", missing_vertex), "step").unwrap();
    assert_eq!(out["faces"], 9);
    assert!(notes(&out).iter().any(|n| n.contains("rebuilt")), "{:?}", notes(&out));
}

#[test]
fn a_clean_file_needs_no_repair() {
    let clean = variant("clean.step", |t| t.replace(BAD_EDGE, GOOD_EDGE));
    assert!(step_refs::repair(&clean).unwrap().is_none());
}

#[test]
fn the_shell_model_imports_whole_with_a_note() {
    let clean = import(&variant("clean_whole.step", |t| t.replace(BAD_EDGE, GOOD_EDGE)), "step").unwrap();
    let out = import(&fixture(), "step").unwrap();
    assert_eq!(out["faces"], clean["faces"]);
    assert_eq!(out["faces"], 9);
    let notes = notes(&out);
    assert!(notes.iter().any(|n| n.contains("1 edge") && n.contains("exporter")), "{notes:?}");
}

#[test]
fn a_step_none_of_whose_faces_can_be_built_is_an_error() {
    let all_bad = variant("all_bad.step", |t| {
        let mut out = String::new();
        for line in t.split_inclusive('\n') {
            match line.find("EDGE_CURVE('',#") {
                Some(at) => {
                    let args: Vec<&str> = line[at + 12..].splitn(4, ',').collect();
                    out.push_str(&format!("{}EDGE_CURVE('',#21,#21,{}", &line[..at], args[3]));
                }
                None => out.push_str(line),
            }
        }
        out
    });
    let err = import(&all_bad, "step").unwrap_err();
    assert!(err.contains("none of its") && err.contains("faces"), "{err}");
    assert!(err.contains("STL"), "names a way through: {err}");
}

#[test]
fn a_mesh_past_the_size_cap_names_a_way_through() {
    let big = blob_dir().join("huge.obj");
    let file = std::fs::File::create(&big).unwrap();
    file.set_len(import::MAX_IMPORT_FILE_BYTES + 1024 * 1024).unwrap();
    drop(file);
    let err = import(&big, "obj").unwrap_err();
    let _ = std::fs::remove_file(&big);
    assert!(err.contains("too large to import"), "{err}");
    assert!(err.contains("binary STL") && err.contains("decimate"), "{err}");
}
