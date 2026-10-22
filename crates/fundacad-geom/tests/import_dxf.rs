//! DXF, tests/fixtures written by tests/dxf/gen_dxf.py.

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
        let dir = std::env::temp_dir().join(format!("fundacad-import-dxf-{}", std::process::id()));
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
    import::import_geometry(&fixture(name).to_string_lossy(), "dxf", &store).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn sketch<'a>(reply: &'a Map<String, Value>, layer: &str) -> &'a Value {
    reply["sketches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == layer)
        .unwrap_or_else(|| panic!("no sketch {layer}"))
}

fn rebuild(doc: Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

/// The layer's sketch extruded 5 mm, as a user would after the import.
fn extruded(reply: &Map<String, Value>, layer: &str) -> Rebuild {
    let s = sketch(reply, layer);
    rebuild(json!({"version": 6, "parameters": {}, "features": [
        {"id": "f1", "type": "sketch", "name": layer, "plane": "XY", "entities": s["entities"]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 5, "operation": "new"},
    ]}))
}

fn near(got: f64, want: f64, rel: f64, what: &str) {
    assert!((got - want).abs() <= want.abs() * rel, "{what}: {got}, want {want}");
}

fn notes(reply: &Map<String, Value>) -> Vec<String> {
    reply
        .get("notes")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|n| n.as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}

const PLATE_AREA: f64 = 6000.0 - (4.0 - std::f64::consts::PI) * 25.0;

#[test]
fn a_dxf_becomes_one_sketch_per_layer() {
    let r = imported("dxf_shapes.dxf");
    let names: Vec<&str> = r["sketches"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        ["Plate", "Cam", "Mirror", "Curves", "Spline", "Knots", "Double", "Open", "Half"],
        "no Notes or Paper layer"
    );
    assert!(r.get("geom").is_none());
    assert_eq!(r["unit"], "mm");
    let n = notes(&r);
    let skipped = n.iter().find(|n| n.starts_with("skipped")).unwrap_or_else(|| panic!("{n:?}"));
    for kind in ["1 TEXT", "1 DIMENSION", "1 HATCH"] {
        assert!(skipped.contains(kind), "{skipped}");
    }
    assert!(n.iter().any(|n| n == "2 ellipses became B-splines"), "{n:?}");
    assert!(!n.iter().any(|n| n.contains("open end")), "{n:?}");
    let plate = sketch(&r, "Plate")["entities"].as_array().unwrap();
    assert_eq!(plate.len(), 11, "8 outline segments, a circle and two block circles");
    let ids: Vec<&str> = plate.iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids[..3], ["e1", "e2", "e3"]);
    let rotated = &plate[10];
    assert_eq!(rotated["type"], "circle");
    near(rotated["x"].as_f64().unwrap(), 80.0, 1e-12, "the block base point is subtracted");
    near(rotated["y"].as_f64().unwrap(), 30.0, 1e-12, "the block base point is subtracted");
    near(rotated["radius"].as_f64().unwrap(), 3.0, 1e-12, "radius");
}

#[test]
fn every_layer_extrudes_to_the_area_it_was_drawn_with() {
    let r = imported("dxf_shapes.dxf");
    let pi = std::f64::consts::PI;
    // Green's theorem over the Cam outline gen_dxf.py draws: arcs about (0,100)
    // r15 and (40,100) r8 joined at +-t1 by two lines.
    let t1 = pi / 2.0 + (7.0f64 / 40.0).asin();
    let arc = |cx: f64, r: f64, u0: f64, u1: f64| {
        0.5 * (r * r * (u1 - u0) + r * (cx * (u1.sin() - u0.sin()) - 100.0 * (u1.cos() - u0.cos())))
    };
    let at = |cx: f64, r: f64, t: f64| (cx + r * t.cos(), 100.0 + r * t.sin());
    let line = |p: (f64, f64), q: (f64, f64)| 0.5 * (p.0 * q.1 - q.0 * p.1);
    let cam = arc(40.0, 8.0, -t1, t1)
        + line(at(40.0, 8.0, t1), at(0.0, 15.0, t1))
        + arc(0.0, 15.0, t1, 2.0 * pi - t1)
        + line(at(0.0, 15.0, -t1), at(40.0, 8.0, -t1));
    let want = [
        ("Plate", PLATE_AREA),
        ("Cam", cam),
        ("Mirror", pi * 50.0),
        ("Curves", pi * 200.0),
        ("Spline", 577.5),
        ("Knots", 1027.469_128),
        ("Double", 896.249_996),
        ("Open", 384.513_888),
        ("Half", pi * 100.0),
    ];
    for (layer, area) in want {
        let b = extruded(&r, layer);
        assert_eq!(b.bodies.len(), 1, "{layer}");
        assert_eq!(kernel::count(&b.bodies[0].shape, Kind::Solid), 1, "{layer}");
        // Note: volume_precise reads 5090.9 for Knots where the face is 1027.47 mm2,
        // so the quick integration is the one that holds on these spline prisms.
        near(kernel::volume(&b.bodies[0].shape), area * 5.0, 5e-4, layer);
    }
    let mirror = sketch(&r, "Mirror")["entities"].as_array().unwrap();
    let xs: Vec<f64> = mirror.iter().flat_map(|e| ["x1", "x2"].map(|k| e[k].as_f64().unwrap())).collect();
    assert!(xs.iter().all(|&x| x <= -119.999), "an arc with extrusion 0,0,-1 lands at negative x: {xs:?}");
}

#[test]
fn a_spline_keeps_its_knots_and_splits_at_a_double_one() {
    let r = imported("dxf_shapes.dxf");
    let knots = &sketch(&r, "Knots")["entities"][0];
    assert_eq!(knots["type"], "bspline");
    assert_eq!(knots["knots"], json!([0.0, 1.0, 3.0, 4.0]));
    let double = sketch(&r, "Double")["entities"].as_array().unwrap();
    let pieces: Vec<&Value> = double.iter().filter(|e| e["type"] == "bspline").collect();
    assert_eq!(pieces.len(), 2);
    let poles = |e: &Value| e["poles"].as_array().unwrap().clone();
    assert_eq!(poles(pieces[0]).last(), poles(pieces[1]).first(), "the two pieces share the break point");
    let open = &sketch(&r, "Open")["entities"][0];
    assert_eq!(open["knots"], json!([3.0, 4.0, 5.0, 6.0]), "the unclamped spline is clamped to its own domain");
}

#[test]
fn binary_dxf_reads_like_ascii() {
    let a = imported("dxf_shapes.dxf");
    let b = imported("dxf_shapes_bin.dxf");
    assert_eq!(a["sketches"], b["sketches"]);
    assert_eq!(notes(&a), notes(&b));
}

#[test]
fn insunits_scale_the_drawing_to_millimetres() {
    let r = imported("dxf_inch.dxf");
    assert_eq!(r["unit"], "in");
    let b = extruded(&r, "Inch");
    let bb = kernel::bbox(&b.bodies[0].shape).unwrap();
    near(bb[3] - bb[0], 25.4, 1e-9, "width");
    near(bb[4] - bb[1], 50.8, 1e-9, "height");
}

#[test]
fn an_r12_polyline_with_bulges_reads() {
    let r = imported("dxf_r12.dxf");
    assert!(notes(&r).iter().any(|n| n.contains("names no unit")), "{:?}", notes(&r));
    let b = extruded(&r, "Outline");
    near(kernel::volume_precise(&b.bodies[0].shape), PLATE_AREA * 5.0, 1e-6, "Outline");
}

#[test]
fn faces_become_bodies_and_acis_solids_are_named() {
    let reply = imported("dxf_mesh.dxf");
    assert!(reply.get("sketches").is_none());
    assert_eq!(reply["solid"], true);
    let names: Vec<&str> = reply["nodes"].as_array().unwrap().iter().map(|n| n["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Cube", "Poly", "Mesh"]);
    assert!(notes(&reply).iter().any(|n| n.starts_with("1 3DSOLID (ACIS) could not be read")), "{:?}", notes(&reply));
    let mut f = reply;
    f.remove("faces");
    f.remove("notes");
    f.remove("unit");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("dxf"));
    let r = rebuild(json!({"version": 6, "parameters": {}, "features": [f]}));
    assert_eq!(r.bodies.len(), 3);
    for b in &r.bodies {
        assert_eq!(kernel::count(&b.shape, Kind::Solid), 1, "{}", b.name);
        near(kernel::volume_precise(&b.shape), 1000.0, 1e-6, &b.name);
    }
}

#[test]
fn a_dxf_with_nothing_to_import_says_so() {
    let dir = blob_dir().join("empty");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("text_only.dxf");
    std::fs::write(&p, "0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\n0\n1\nhello\n0\nENDSEC\n0\nEOF\n").unwrap();
    let store = BlobStore::open(blob_dir()).unwrap();
    let e = import::import_geometry(&p.to_string_lossy(), "dxf", &store).unwrap_err();
    assert!(e.contains("no lines, curves or 3D faces"), "{e}");
}

fn de_boor(knots: &[f64], poles: &[[f64; 2]], p: usize, t: f64) -> [f64; 2] {
    let mut k = p;
    while k < poles.len() - 1 && knots[k + 1] <= t {
        k += 1;
    }
    let mut d: Vec<[f64; 2]> = (0..=p).map(|j| poles[j + k - p]).collect();
    for r in 1..=p {
        for j in (r..=p).rev() {
            let i = j + k - p;
            let a = (t - knots[i]) / (knots[i + p + 1 - r] - knots[i]);
            d[j] = [(1.0 - a) * d[j - 1][0] + a * d[j][0], (1.0 - a) * d[j - 1][1] + a * d[j][1]];
        }
    }
    d[p]
}

#[test]
fn the_built_spline_edge_is_the_curve_the_dxf_describes() {
    let poles = [[0.0, -50.0], [5.0, -30.0], [20.0, -25.0], [35.0, -40.0], [45.0, -20.0], [60.0, -50.0]];
    let knots = [0.0, 0.0, 0.0, 0.0, 1.0, 3.0, 4.0, 4.0, 4.0, 4.0];
    let r = imported("dxf_shapes.dxf");
    let e = &sketch(&r, "Knots")["entities"][0];
    let got: Vec<[f64; 2]> =
        e["poles"].as_array().unwrap().iter().map(|p| [p["x"].as_f64().unwrap(), p["y"].as_f64().unwrap()]).collect();
    let stored: Vec<f64> = e["knots"].as_array().unwrap().iter().map(|k| k.as_f64().unwrap()).collect();
    let edge = kernel::edge_bspline(&got, Some(3.0), false, Some(&stored)).unwrap();
    for t in [0.5, 1.0, 2.0, 2.5, 3.5] {
        let (p, range) = kernel::edge_eval(&edge, t).unwrap();
        let want = de_boor(&knots, &poles, 3, t);
        assert!((p[0] - want[0]).hypot(p[1] - want[1]) < 1e-9, "t {t}: {p:?}, want {want:?}, range {range:?}");
    }
}
