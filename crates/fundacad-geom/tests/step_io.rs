//! STEP import against the Python engine's reading of tests/fixtures/asm_*.step
//! (tests/step/gen.py on the legacy branch), and STEP export read back through the same reader.

use fundacad_geom::export::{step, ExportBody};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use opencascade::xcaf;
use serde_json::{json, Value};
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-step-io-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn hex(c: Option<[u8; 3]>) -> Value {
    c.map_or(Value::Null, |c| json!(format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])))
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn step_import_matches_python() {
    let oracle: Value =
        serde_json::from_str(&std::fs::read_to_string(root().join("tests/step/oracle.json")).unwrap()).unwrap();
    let store = BlobStore::open(scratch("blobs")).unwrap();
    let mut failures = Vec::new();
    for (name, want) in oracle.as_object().unwrap() {
        let path = root().join(format!("../../tests/fixtures/{name}.step"));
        let mut fail = |what: String| failures.push(format!("{name}: {what}"));
        let asm = xcaf::read_step_assembly(&path).unwrap();
        if json!(asm.is_assembly) != want["isAssembly"] {
            fail(format!("isAssembly {}", asm.is_assembly));
        }
        if json!(asm.roots.len()) != want["roots"] {
            fail(format!("roots {}", asm.roots.len()));
        }
        let leaves = want["leaves"].as_array().unwrap();
        if asm.leaves.len() != leaves.len() {
            fail(format!("{} leaves, want {}", asm.leaves.len(), leaves.len()));
        }
        for (i, (got, w)) in asm.leaves.iter().zip(leaves).enumerate() {
            if json!(got.node) != w["node"] {
                fail(format!("leaf {i} node {}", got.node));
            }
            if json!(kernel::count(&got.shape, Kind::Face)) != w["faces"]
                || json!(kernel::count(&got.shape, Kind::Solid)) != w["solids"]
            {
                fail(format!("leaf {i} topology"));
            }
            let vol = kernel::volume(&got.shape);
            if !close(vol, w["volume"].as_f64().unwrap(), 1e-6 * vol.abs().max(1.0)) {
                fail(format!("leaf {i} volume {vol} want {}", w["volume"]));
            }
            let bb = kernel::bbox(&got.shape).unwrap();
            for (k, v) in w["bbox"].as_array().unwrap().iter().enumerate() {
                if !close(bb[k], v.as_f64().unwrap(), 1e-3) {
                    fail(format!("leaf {i} bbox {bb:?} want {}", w["bbox"]));
                    break;
                }
            }
            let faces = got
                .face_colors
                .as_ref()
                .map_or(Value::Null, |c| Value::Array(c.iter().map(|&x| hex(x)).collect()));
            if faces != w["faceColors"] {
                fail(format!("leaf {i} face colours {faces}"));
            }
            if hex(got.solid_color) != w["solidColor"] {
                fail(format!("leaf {i} solid colour {}", hex(got.solid_color)));
            }
        }
        for (i, (got, w)) in asm.nodes.iter().zip(want["nodes"].as_array().unwrap()).enumerate() {
            if hex(got.color) != w["color"] || json!(got.parent) != w["parent"] {
                fail(format!("node {i} colour or parent"));
            }
        }

        let mut reply = import::import_geometry(path.to_str().unwrap(), "step", &store).unwrap();
        let geom = reply.remove("geom").unwrap();
        if Value::Object(reply.clone()) != want["reply"] {
            fail(format!("reply {}\nwant  {}", Value::Object(reply), want["reply"]));
        }
        let bytes = store.get_bytes(geom.as_str().unwrap()).expect("the blob is stored");
        let back = xcaf::from_bin(&bytes).unwrap();
        if json!(kernel::count(&back, Kind::Face)) != want["reply"]["faces"] {
            fail("the blob reads back with another face count".into());
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn import_refuses_what_it_cannot_read() {
    let store = BlobStore::open(scratch("refuse")).unwrap();
    let dir = scratch("refuse-files");
    let junk = dir.join("junk.step");
    std::fs::write(&junk, "not a step file").unwrap();
    assert_eq!(
        import::import_geometry(junk.to_str().unwrap(), "step", &store).unwrap_err(),
        "could not read the STEP file (it may be truncated or not STEP)"
    );
    assert_eq!(
        import::import_geometry(junk.to_str().unwrap(), "dwg", &store).unwrap_err(),
        "unsupported import format: dwg"
    );
}

#[test]
fn brep_import_stores_a_readable_blob() {
    let store = BlobStore::open(scratch("brep")).unwrap();
    let path = root().join("tests/mesh_oracle/box_minus_cylinder.brep");
    let reply = import::import_geometry(path.to_str().unwrap(), "brep", &store).unwrap();
    assert_eq!(
        reply.keys().collect::<Vec<_>>(),
        ["geom", "solid", "faces", "name"]
    );
    assert_eq!(reply["solid"], true);
    assert_eq!(reply["faces"], 7);
    assert_eq!(reply["name"], "box_minus_cylinder");
    let shape = xcaf::from_bin(&store.get_bytes(reply["geom"].as_str().unwrap()).unwrap()).unwrap();
    let want = 4000.0 - std::f64::consts::PI * 9.0 * 10.0;
    assert!(close(kernel::volume(&shape), want, 1e-3));
}

fn body<'a>(id: &'a str, name: &'a str, shape: &'a Shape, node_ref: Option<&'a str>) -> ExportBody<'a> {
    ExportBody { id, name, shape, node_ref, mesh_passes: &[] }
}

#[test]
fn step_export_keeps_names_colours_and_placement() {
    let dir = scratch("export");
    let a = kernel::make_box(10.0, 10.0, 10.0).unwrap();
    let b = kernel::translated(&kernel::make_sphere(5.0).unwrap(), [30.0, 0.0, 0.0]).unwrap();

    let path = dir.join("single.step");
    let doc = json!({"features": []});
    let bodies = [body("body1", "Bracket (left)", &a, None)];
    step::write_tree(&step::build_export_tree(&doc, &bodies, "single").unwrap(), &path).unwrap();
    let back = xcaf::read_step_assembly(&path).unwrap();
    assert_eq!(back.nodes.len(), 1);
    assert_eq!(back.nodes[0].name, "Bracket (left)");
    assert!(close(kernel::volume(&back.leaves[0].shape), 1000.0, 1e-6));

    let path = dir.join("flat.step");
    let bodies = [body("body1", "Cube", &a, None), body("body2", "", &b, None)];
    step::write_tree(&step::build_export_tree(&doc, &bodies, "flat").unwrap(), &path).unwrap();
    let back = xcaf::read_step_assembly(&path).unwrap();
    let names: Vec<&str> = back.nodes.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, ["flat", "Cube", "body2"]);
    assert_eq!(back.leaves.len(), 2);
    let bb = kernel::bbox(&back.leaves[1].shape).unwrap();
    assert!(close(bb[0], 25.0, 1e-3) && close(bb[3], 35.0, 1e-3), "{bb:?}");

    let path = dir.join("asm.step");
    let doc = json!({"features": [{"id": "imp", "type": "import", "nodes": [
        {"name": "Top", "parent": null},
        {"name": "Red Part", "parent": 0, "color": "#e51919"},
        {"name": "Plain", "parent": 0},
    ]}]});
    let c = kernel::make_box(2.0, 2.0, 2.0).unwrap();
    // one TShape is one STEP product, so a shape shared by two bodies would share a name
    let d = kernel::make_box(2.0, 2.0, 2.0).unwrap();
    let bodies = [
        body("b1", "Red Part", &a, Some("imp/1")),
        body("b2", "Plain 1", &b, Some("imp/2")),
        body("b3", "Plain 2", &c, Some("imp/2")),
        body("b4", "Loose", &d, Some("nowhere/0")),    ];
    step::write_tree(&step::build_export_tree(&doc, &bodies, "asm").unwrap(), &path).unwrap();
    let back = xcaf::read_step_assembly(&path).unwrap();
    let names: Vec<(&str, Option<usize>, Value)> =
        back.nodes.iter().map(|n| (n.name.as_str(), n.parent, hex(n.color))).collect();
    assert_eq!(
        names,
        [
            ("asm", None, Value::Null),
            ("Top", Some(0), Value::Null),
            ("Red Part", Some(1), json!("#e51919")),
            ("Plain", Some(1), Value::Null),
            ("Plain 1", Some(3), Value::Null),
            ("Plain 2", Some(3), Value::Null),
            ("Loose", Some(0), Value::Null),
        ]
    );
    assert_eq!(back.leaves.len(), 4);
}
