//! The plugin host end to end on the PrintToolbox component, with the same
//! documents and analytic volumes as plugins/FundaCAD.PrintToolbox/geometry/tests.
//! Needs `python scripts/build-plugin-wasm.py FundaCAD.PrintToolbox` first;
//! without the component every case is skipped with a note.
#![cfg(feature = "plugins")]

use std::f64::consts::PI;
use std::path::Path;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn component_built() -> bool {
    fundacad_geom::plugins::load();
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/FundaCAD.PrintToolbox/geometry.wasm");
    if !p.is_file() {
        eprintln!("skipped: build the component with scripts/build-plugin-wasm.py");
    }
    p.is_file()
}

fn block(w: f64, d: f64, h: f64) -> Vec<Value> {
    vec![
        json!({"id": "s1", "type": "sketch", "plane": "XY",
               "entities": [{"type": "rectangle", "width": w, "height": d, "x": 0, "y": 0}]}),
        json!({"id": "e1", "type": "extrude", "sketch": "s1", "distance": h, "operation": "new"}),
    ]
}

fn y_hole(r: f64, z: f64) -> Vec<Value> {
    vec![
        json!({"id": "sh", "type": "sketch", "plane": "XZ",
               "entities": [{"type": "circle", "radius": r, "x": 0, "y": z}]}),
        json!({"id": "eh", "type": "extrude", "sketch": "sh", "distance": 100, "symmetric": true,
               "operation": "cut"}),
    ]
}

fn face_at(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p})
}

fn build(features: Vec<Value>) -> Rebuild {
    let doc = json!({"parameters": {}, "features": features});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn one_volume(r: &Rebuild) -> f64 {
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1);
    kernel::volume(&r.bodies[0].shape)
}

const R: f64 = 3.0;
const Z: f64 = 10.0;
const L: f64 = 20.0;

fn base() -> Vec<Value> {
    let mut f = block(30.0, L, 20.0);
    f.extend(y_hole(R, Z));
    f
}

#[test]
fn teardrop_removes_the_analytic_cap() {
    if !component_built() {
        return;
    }
    let before = one_volume(&build(base()));
    for angle in [45.0f64, 30.0, 60.0] {
        let mut f = base();
        f.push(json!({"id": "td", "type": "teardropHole", "faces": face_at([0.0, 0.0, Z + R]), "angle": angle}));
        let after = one_volume(&build(f));
        let th = angle.to_radians();
        let cap = R * R * (1.0 / th.tan() - (PI / 2.0 - th));
        let removed = before - after;
        assert!((removed - cap * L).abs() < 1e-3 * cap * L + 1e-4, "{angle}: {removed} vs {}", cap * L);
    }
}

#[test]
fn roof_bridge_and_ribs_and_errors() {
    if !component_built() {
        return;
    }
    let before = one_volume(&build(base()));
    let mut f = base();
    f.push(json!({"id": "rb", "type": "roofBridge", "faces": face_at([0.0, 0.0, Z + R]), "height": 0.6}));
    let area = 2.0 * R * (R + 0.6) - PI * R * R / 2.0;
    assert!(((before - one_volume(&build(f))) - area * L).abs() < 1e-3 * area * L);

    let mut f = base();
    f.push(json!({"id": "td", "type": "teardropHole", "faces": face_at([0.0, 0.0, 20.0])}));
    let r = build(f);
    assert_eq!(r.errors.len(), 1);
    assert_eq!(r.errors[0].feature_id.as_deref(), Some("td"));
    assert!(r.errors[0].message.contains("not cylindrical"), "{}", r.errors[0].message);

    let mut f = base();
    f.push(json!({"id": "tr", "type": "threadRibs", "faces": face_at([0.0, 0.0, Z + R]), "ribCount": 2}));
    let r = build(f);
    assert_eq!(
        r.errors[0].message,
        "Thread-forming ribs: the rib count must be a whole number from 3 to 8 (got 2)"
    );
}

#[test]
fn an_unknown_type_still_reads_unknown() {
    let r = build(vec![json!({"id": "x", "type": "noSuchFeature"})]);
    assert_eq!(r.errors[0].message, "unknown feature type: noSuchFeature");
}

fn built(name: &str) -> bool {
    fundacad_geom::plugins::load();
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../plugins/{name}/geometry.wasm"));
    if !p.is_file() {
        assert!(std::env::var_os("CI").is_none(), "CI builds {name}'s geometry.wasm before the tests, it is missing");
        eprintln!("skipped: build {name} with scripts/build-plugin-wasm.py");
    }
    p.is_file()
}

fn job(r: fundacad_protocol::JobResult) -> serde_json::Map<String, Value> {
    match r {
        fundacad_protocol::JobResult::Json(m) => m,
        _ => panic!("a json reply"),
    }
}

/// A texture on the top of a plate: the rebuild stashes its spec, the viewport
/// mesh of that face is displaced (more triangles, raised within its depth,
/// its colour slot on the payload) and the other faces are untouched.
#[test]
fn a_texture_displaces_its_face_and_only_its_face() {
    if !built("FundaCAD.Texture") {
        return;
    }
    let mut f = block(20.0, 20.0, 5.0);
    let plain = build(f.clone());
    f.push(json!({"id": "t", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0, "colorSlot": 1,
                  "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}));
    let r = build(f);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies[0].mesh_passes.len(), 1);
    let mesh = |b: &builder::BuiltBody| {
        let mb = fundacad_geom::mesh::MeshBody {
            id: b.id.clone(),
            name: b.name.clone(),
            shape: Some(&b.shape),
            mesh_passes: b.mesh_passes.clone(),
            ..Default::default()
        };
        let out = fundacad_geom::mesh::mesh_result(&[mb], 0.1, &Default::default());
        match out.bodies.into_iter().next() {
            Some(fundacad_protocol::WireBody::Full(full)) => full,
            _ => panic!("a full body"),
        }
    };
    let (a, b) = (mesh(&plain.bodies[0]), mesh(&r.bodies[0]));
    assert!(b.indices.len() > 10 * a.indices.len(), "{} vs {}", b.indices.len(), a.indices.len());
    let top = b.positions.chunks_exact(3).map(|p| p[2]).fold(f32::MIN, f32::max);
    assert!(top > 5.3 && top <= 5.4 + 1e-4, "{top}");
    assert_eq!(b.fields["faceColorSlots"].as_array().map(|s| s.iter().filter(|v| **v == json!(1)).count()), Some(1));
    assert_ne!(a.fields["etag"], b.fields["etag"]);
    let untouched = |m: &fundacad_protocol::FullBody, face: u32| m.face_ids.iter().filter(|&&f| f == face).count();
    let top_face = b.face_ids.iter().copied().max_by_key(|&f| untouched(&b, f)).unwrap();
    for face in 0..6u32 {
        if face != top_face {
            assert_eq!(untouched(&a, face), untouched(&b, face), "face {face}");
        }
    }
}

fn rebuilt(features: &[Value]) -> fundacad_protocol::MeshResult {
    let doc = json!({"parameters": {}, "features": features});
    match fundacad_geom::jobs::rebuild_result(&doc, 0.1, &Default::default(), &NoWatch) {
        fundacad_protocol::JobResult::Mesh(m) => m,
        _ => panic!("a meshed reply"),
    }
}

fn chamfered_box(distance: f64, texture: Value) -> Vec<Value> {
    let mut f = block(20.0, 20.0, 10.0);
    f.push(json!({"id": "c", "type": "chamfer", "edges": {"kind": "edge", "by": "all"}, "distance": distance}));
    f.push(texture);
    f
}

/// How far the vertices of the most refined face spread along `n`.
fn textured_face_spread(m: &fundacad_protocol::MeshResult, n: [f64; 3]) -> f64 {
    let Some(fundacad_protocol::WireBody::Full(b)) = m.bodies.first() else {
        panic!("a full body");
    };
    let count = |face: u32| b.face_ids.iter().filter(|&&f| f == face).count();
    let face = b.face_ids.iter().copied().max_by_key(|&f| count(f)).expect("triangles");
    let along: Vec<f64> = b
        .face_ids
        .iter()
        .enumerate()
        .filter(|(_, &f)| f == face)
        .flat_map(|(t, _)| b.indices[3 * t..3 * t + 3].iter())
        .map(|&i| {
            let p = &b.positions[3 * i as usize..3 * i as usize + 3];
            f64::from(p[0]) * n[0] + f64::from(p[1]) * n[1] + f64::from(p[2]) * n[2]
        })
        .collect();
    along.iter().copied().fold(f64::MIN, f64::max) - along.iter().copied().fold(f64::MAX, f64::min)
}

/// A knurl on one 1.41 mm wide chamfer face: every row of its lattice landed
/// on a zero line of the pattern and every raised vertex sat on the pinned
/// boundary, so the face stayed flat and nothing said so.
#[test]
fn a_texture_on_a_narrow_chamfer_raises_it() {
    if !built("FundaCAD.Texture") {
        return;
    }
    let m = rebuilt(&chamfered_box(
        1.0,
        json!({"id": "t", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0,
               "faces": face_at([9.5, 0.0, 9.5])}),
    ));
    assert!(m.fields.get("featureErrors").is_none(), "{:?}", m.fields.get("featureErrors"));
    let h = std::f64::consts::FRAC_1_SQRT_2;
    let spread = textured_face_spread(&m, [h, 0.0, h]);
    assert!(spread > 0.1 && spread < 0.4 + 1e-3, "{spread}");
}

/// A 0.42 mm chamfer lies in one flat land of a 2 mm knurl, so no mesh can
/// raise it: the face stays plain and the feature says why, from a cached
/// mesh too, although its rebuild had nothing to report.
#[test]
fn a_texture_that_leaves_its_face_flat_says_so() {
    if !built("FundaCAD.Texture") {
        return;
    }
    let features = chamfered_box(
        0.3,
        json!({"id": "t", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0,
               "faces": face_at([9.85, 0.0, 9.85])}),
    );
    let doc = json!({"parameters": {}, "features": features});
    let mut cache = fundacad_geom::cache::RebuildCache::new(None);
    for pass in ["fresh", "cached"] {
        let m = match fundacad_geom::jobs::rebuild_result_cached(&doc, 0.1, &Default::default(), &NoWatch, &mut cache) {
            fundacad_protocol::JobResult::Mesh(m) => m,
            _ => panic!("a meshed reply"),
        };
        let errors = m.fields.get("featureErrors").and_then(Value::as_array).cloned().unwrap_or_default();
        assert_eq!(errors.len(), 1, "{pass}: {errors:?}");
        assert_eq!(errors[0]["feature_id"], "t", "{pass}");
        assert_eq!(errors[0]["code"], "mesh-pass", "{pass}");
        assert_eq!(
            errors[0]["message"],
            "the knurl pattern at scale 2 mm leaves a face 0.42 mm wide flat, lower the scale or leave this face out",
            "{pass}"
        );
        assert_eq!(m.fields["featureError"]["feature_id"], "t", "{pass}");
        assert!(m.fields.get("passErrors").is_none(), "{pass}");
        let Some(fundacad_protocol::WireBody::Full(b)) = m.bodies.first() else {
            panic!("{pass}: a full body");
        };
        assert!(b.fields.get("passErrors").is_none(), "{pass}");
    }
}

#[test]
fn a_bad_texture_value_is_the_features_error() {
    if !built("FundaCAD.Texture") {
        return;
    }
    let mut f = block(20.0, 20.0, 5.0);
    f.push(json!({"id": "t", "type": "texture", "kind": "glitter", "faces": {"by": "all"}}));
    let r = build(f);
    assert_eq!(r.errors[0].message, "unknown texture kind: 'glitter'");
    assert_eq!(r.errors[0].feature_id.as_deref(), Some("t"));
}

/// generateShape through the fastener generator: a valid solid, and a spec
/// with holes refused with every missing field named.
#[test]
fn a_fastener_is_generated() {
    if !built("FundaCAD.Screws") {
        return;
    }
    let spec = json!({"kind": "washer", "units": "mm", "name": "M4 washer",
                      "washer": {"type": "plain", "inner": 4.3, "outer": 9.0, "thickness": 0.8}});
    let m = job(fundacad_geom::plugins::generate_shape_result(
        &serde_json::from_value(json!({"generator": "fastener", "params": spec, "output": "mesh"})).unwrap(),
        None,
    ));
    assert_eq!(m["valid"], json!(true));
    let want = PI * (4.5f64.powi(2) - 2.15f64.powi(2)) * 0.8;
    assert!((m["volume"].as_f64().unwrap() - want).abs() < 1e-6 * want);
    let m = job(fundacad_geom::plugins::generate_shape_result(
        &serde_json::from_value(json!({"generator": "fastener", "params": {"kind": "washer", "units": "mm", "name": "w"}}))
            .unwrap(),
        None,
    ));
    assert_eq!(m["error"]["message"], json!("Fastener: missing washer type"));
}

/// exportWith through the slicer project exporter: the file lands at the path
/// the host chose and is a zip with the project's five entries.
#[test]
fn a_slicer_project_is_exported() {
    if !built("FundaCAD.Printing") {
        return;
    }
    let dir = std::env::temp_dir().join(format!("fc-plugin-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("proj.3mf");
    let doc = json!({"parameters": {}, "features": block(20.0, 20.0, 5.0)});
    let m = job(fundacad_geom::plugins::export_with_result(
        &serde_json::from_value(json!({"exporter": "print-project-3mf", "path": path.to_string_lossy(), "document": doc,
                                       "options": {"palette": [{"name": "Red", "color": "#e03030"}]}}))
        .unwrap(),
        &NoWatch,
        None,
    ));
    assert_eq!(m["info"], json!({}), "{m:?}");
    let bytes = std::fs::read(&path).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let names: Vec<&str> = ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model", "Metadata/model_settings.config",
        "Metadata/project_settings.config"]
    .to_vec();
    for n in names {
        assert!(bytes.windows(n.len()).any(|w| w == n.as_bytes()), "{n} is in the zip");
    }
    assert_eq!(&bytes[..4], b"PK\x03\x04");
}

#[test]
fn an_op_names_the_plugin_it_cannot_find() {
    use fundacad_protocol::JobResult;
    let JobResult::Json(m) = fundacad_geom::plugins::generate_shape_result(
        &serde_json::from_value(json!({"generator": "nope", "params": {}})).unwrap(),
        None,
    ) else {
        panic!("a json reply")
    };
    assert_eq!(
        m["error"]["message"],
        json!("no plugin that is running offers the shape 'nope'")
    );

    let JobResult::Json(m) = fundacad_geom::plugins::export_with_result(
        &serde_json::from_value(json!({"exporter": "nope", "path": "x.bin", "document": {"features": []}})).unwrap(),
        &NoWatch,
        None,
    ) else {
        panic!("a json reply")
    };
    assert_eq!(
        m["error"]["message"],
        json!("no installed plugin provides the 'nope' export")
    );
}
