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
