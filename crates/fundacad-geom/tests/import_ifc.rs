//! IFC building models, tests/fixtures/ifc_tiny.ifc written by hand (IFC4,
//! millimetres). Volumes agree with IfcOpenShell.

use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Map, Value};

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-ifc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"))
}

fn imported(path: &str) -> Result<Map<String, Value>, String> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(path, "ifc", &store)
}

fn build(reply: Map<String, Value>) -> Rebuild {
    let mut f = reply;
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("ifc"));
    let doc = json!({"version": 1, "parameters": {}, "features": [f]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn rgb(hex: &str) -> [i32; 3] {
    let v = |i: usize| i32::from_str_radix(&hex[i..i + 2], 16).unwrap();
    [v(1), v(3), v(5)]
}

#[test]
fn an_ifc_file_imports_one_body_per_product_with_names_colours_and_voids() {
    let reply = imported(&fixture("ifc_tiny.ifc").to_string_lossy()).unwrap_or_else(|e| panic!("{e}"));
    let r = build(reply);
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Wall A", "Floor slab", "Roof light", "Plinth", "Column 1", "Column 2"]);

    let want: [(f64, Option<[i32; 3]>); 6] = [
        (1.6e9, Some([0xcc, 0x33, 0x33])),
        (2.4e9, Some([0x99, 0x99, 0x99])),
        (1.0e9 / 6.0, Some([0x33, 0x66, 0xe6])),
        (2.7e7, None),
        (2.25e8, Some([0x8c, 0x59, 0x26])),
        (2.25e8, Some([0x8c, 0x59, 0x26])),
    ];
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for (b, (vol, color)) in r.bodies.iter().zip(want) {
        assert_eq!(kernel::count(&b.shape, Kind::Solid), 1, "{}", b.name);
        assert!(b.shape.is_valid().unwrap(), "{} is not a valid solid", b.name);
        let got = kernel::volume_precise(&b.shape);
        assert!((got - vol).abs() <= vol * 1e-3, "{}: volume {got}, want {vol}", b.name);
        match (b.part_color.as_deref(), color) {
            (None, None) => {}
            (Some(h), Some(c)) => {
                let g = rgb(h);
                assert!((0..3).all(|k| (g[k] - c[k]).abs() <= 1), "{}: colour {h}, want {c:?}", b.name);
            }
            (got, want) => panic!("{}: colour {got:?}, want {want:?}", b.name),
        }
        let bb = kernel::bbox(&b.shape).unwrap();
        for k in 0..3 {
            lo[k] = lo[k].min(bb[k]);
            hi[k] = hi[k].max(bb[k + 3]);
        }
    }
    let want_lo = [0.0, 0.0, -200.0];
    let want_hi = [4000.0, 3000.0, 3000.0];
    for k in 0..3 {
        assert!((lo[k] - want_lo[k]).abs() < 0.5 && (hi[k] - want_hi[k]).abs() < 0.5, "bbox {lo:?} {hi:?}");
    }
    let wall = &r.bodies[0].shape;
    assert!(kernel::count(wall, Kind::Face) > 6, "the wall keeps its door hole");
}

#[test]
fn a_zipped_ifc_is_refused_by_name() {
    let dir = blob_dir().join("ifczip");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("house.ifc");
    std::fs::write(&p, b"PK\x03\x04not really a zip").unwrap();
    let e = imported(&p.to_string_lossy()).unwrap_err();
    assert!(e.contains("IFCZIP") || e.contains("zip"), "{e}");
}

fn notes(reply: &Map<String, Value>) -> Vec<String> {
    reply
        .get("notes")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
}

fn scratch(name: &str, text: &str) -> String {
    let dir = blob_dir().join("variants");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    p.to_string_lossy().into_owned()
}

#[test]
fn openings_spaces_envelopes_virtual_elements_and_annotations_are_left_out() {
    let reply = imported(&fixture("ifc_not_material.ifc").to_string_lossy()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(reply.get("name").and_then(Value::as_str), Some("Wall B"), "one element keeps its IFC name");
    assert!(notes(&reply).is_empty(), "{:?}", notes(&reply));
    let r = build(reply);
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Wall B"]);
    let wall = &r.bodies[0].shape;
    assert_eq!(kernel::count(wall, Kind::Solid), 1);
    let want = 3000.0 * 200.0 * 2500.0 - 800.0 * 200.0 * 1000.0;
    let got = kernel::volume_precise(wall);
    assert!((got - want).abs() <= want * 1e-3, "the window hole is cut, volume {got}, want {want}");
}

#[test]
fn a_revit_wall_with_openings_comes_in_closed() {
    let reply = imported(&fixture("ifc_revit_wall_openings.ifc").to_string_lossy()).unwrap_or_else(|e| panic!("{e}"));
    assert!(!notes(&reply).iter().any(|n| n.contains("open shell")), "{:?}", notes(&reply));
    let r = build(reply);
    assert_eq!(r.bodies.len(), 8);
    for b in &r.bodies {
        assert!(kernel::count(&b.shape, Kind::Solid) >= 1, "{} is not solid", b.name);
        assert!(kernel::volume_precise(&b.shape) > 0.0, "{} is inside out", b.name);
        assert!(b.shape.is_valid().unwrap(), "{} is not valid, its touching pieces were sewn into one shell", b.name);
    }
    let wall = r.bodies.iter().find(|b| b.name.starts_with("Basic Wall")).expect("the wall");
    // ifc-lite's own mesh of this wall encloses 31.4214 m3
    let got = kernel::volume_precise(&wall.shape);
    assert!((got - 31.4214e9).abs() <= 31.4214e9 * 1e-3, "wall volume {got}");
}

#[test]
fn an_element_that_does_not_close_and_a_cut_off_file_say_so() {
    let text = std::fs::read_to_string(fixture("ifc_not_material.ifc")).unwrap().replace(
        "IFCANNOTATION('0bbbbbbbbbbbbbbbbbbbbC',$,'Level mark',$,$,#106,#105)",
        "IFCBUILDINGELEMENTPROXY('0bbbbbbbbbbbbbbbbbbbbC',$,'Canopy',$,$,#33,#305,$,.NOTDEFINED.)",
    );
    let reply = imported(&scratch("open.ifc", &text)).unwrap_or_else(|e| panic!("{e}"));
    let said = notes(&reply);
    assert!(said.iter().any(|n| n.starts_with("Canopy:") && n.contains("open shell")), "{said:?}");
    assert!(!said.iter().any(|n| n.starts_with("Wall B:")), "{said:?}");
    assert_eq!(reply.get("solid"), Some(&json!(true)));

    let tiny = std::fs::read_to_string(fixture("ifc_tiny.ifc")).unwrap();
    let cut = &tiny[..tiny.find("#110=").unwrap()];
    let reply = imported(&scratch("cut.ifc", cut)).unwrap_or_else(|e| panic!("{e}"));
    assert!(notes(&reply).iter().any(|n| n.contains("cut off")), "{:?}", notes(&reply));
}
