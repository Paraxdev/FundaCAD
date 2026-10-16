//! Rhino .3dm, tests/fixtures written by tests/rhino/gen_3dm.py.

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
        let dir = std::env::temp_dir().join(format!("fundacad-import-rhino-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"))
}

fn imported(name: &str) -> Map<String, Value> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&fixture(name).to_string_lossy(), "3dm", &store).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn build(reply: Map<String, Value>) -> Rebuild {
    let mut f = reply;
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("3dm"));
    let doc = json!({"version": 1, "parameters": {}, "features": [f]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn near(got: f64, want: f64, what: &str) {
    assert!((got - want).abs() <= want.abs() * 1e-3, "{what}: {got}, want {want}");
}

#[test]
fn a_rhino_file_imports_breps_extrusions_surfaces_and_meshes() {
    let reply = imported("rhino_mix.3dm");
    assert!(reply.get("notes").is_none(), "{:?}", reply.get("notes"));
    let nodes = reply["nodes"].as_array().unwrap();
    let names: Vec<&str> = nodes.iter().map(|n| n["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "Boxes", "Surfaces", "Trimmed", "Meshes", "box10x20x30", "cyl", "sphere", "plate_with_hole",
            "cyl_extrusion", "bump_surface", "disc", "tetra"
        ]
    );
    let parent = |name: &str| {
        let n = &nodes[names.iter().position(|&x| x == name).unwrap()];
        n["parent"].as_u64().map(|p| names[p as usize])
    };
    assert_eq!(parent("Trimmed"), Some("Surfaces"));
    assert_eq!(parent("Boxes"), None);
    assert_eq!(parent("box10x20x30"), Some("Boxes"));
    assert_eq!(parent("disc"), Some("Trimmed"));
    assert_eq!(parent("tetra"), Some("Meshes"));
    assert_eq!(nodes[0]["color"], json!("#c81e1e"));

    let r = build(reply.clone());
    let bodies: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(bodies, names[4..]);
    let colors: Vec<Option<&str>> = r.bodies.iter().map(|b| b.part_color.as_deref()).collect();
    assert_eq!(colors[0], Some("#c81e1e"), "the box takes its layer colour");
    assert_eq!(colors[1], Some("#ff8000"), "the cylinder its own");
    assert_eq!(colors[6], Some("#1ec81e"));
    assert_eq!(colors[7], Some("#0ac8c8"));

    let pi = std::f64::consts::PI;
    let solids = [
        ("box10x20x30", 6000.0),
        ("cyl", pi * 25.0 * 12.0),
        ("sphere", 4.0 / 3.0 * pi * 343.0),
        ("plate_with_hole", 3200.0 - pi * 16.0 * 8.0),
        ("cyl_extrusion", pi * 9.0 * 10.0),
        ("tetra", 1000.0 / 6.0),
    ];
    for (name, want) in solids {
        let b = r.bodies.iter().find(|b| b.name == name).unwrap();
        assert_eq!(kernel::count(&b.shape, Kind::Solid), 1, "{name}");
        assert!(b.shape.is_valid().unwrap(), "{name} is not a valid solid");
        near(kernel::volume_precise(&b.shape), want, name);
    }
    let disc = r.bodies.iter().find(|b| b.name == "disc").unwrap();
    near(kernel::area(&disc.shape), pi * 36.0, "disc");
    let bump = r.bodies.iter().find(|b| b.name == "bump_surface").unwrap();
    assert_eq!(kernel::count(&bump.shape, Kind::Face), 1);
    near(kernel::area(&bump.shape), 922.128, "bump_surface");
}

#[test]
fn an_inch_rhino_file_is_read_in_millimetres() {
    let reply = imported("rhino_inch.3dm");
    assert_eq!(reply["name"], json!("inch_box"));
    assert!(reply.get("parts").is_none());
    let r = build(reply);
    assert_eq!(r.bodies.len(), 1);
    near(kernel::volume_precise(&r.bodies[0].shape), 6.0 * 25.4f64.powi(3), "inch_box");
}
