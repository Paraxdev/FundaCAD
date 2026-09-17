//! Selector resolution against sidecar/geom_select.py, per `by` kind, on the
//! same B-reps (tests/select/gen.py writes the parts and tests/select/fixtures.json).

use std::collections::HashMap;

use fundacad_geom::builder::Fail;
use fundacad_geom::opencascade::mesh_access;
use fundacad_geom::opencascade::primitives::Shape;
use fundacad_geom::opencascade::select_access::{self as sa, ItemKind};
use fundacad_geom::select::entity::{EdgeEnt, FaceEnt};
use fundacad_geom::select::{edge_fingerprint, face_fingerprint, Resolver};
use serde_json::{json, Value};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/select");

fn close(a: &Value, b: &Value, path: &str, bad: &mut Vec<String>) {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if (x - y).abs() > 1e-6 + 1e-9 * x.abs().max(y.abs()) {
                bad.push(format!("{path}: {x} != {y}"));
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                close(p, q, &format!("{path}[{i}]"), bad);
            }
        }
        (Value::Object(x), Value::Object(y)) => {
            let mut kx: Vec<&String> = x.keys().collect();
            let mut ky: Vec<&String> = y.keys().collect();
            kx.sort();
            ky.sort();
            if kx != ky {
                bad.push(format!("{path}: keys {kx:?} != {ky:?}"));
                return;
            }
            for (k, v) in x {
                close(v, &y[k], &format!("{path}.{k}"), bad);
            }
        }
        _ if a != b => bad.push(format!("{path}: {a} != {b}")),
        _ => {}
    }
}

fn edge_summary(s: &Shape) -> Value {
    let e = EdgeEnt::new(s.clone()).expect("edge measures");
    json!({"type": e.curve_name(), "at": e.mid.to_array(), "size": e.length})
}

fn face_summary(s: &Shape) -> Value {
    let f = FaceEnt::new(s.clone()).expect("face measures");
    json!({"type": f.surface_name(), "at": f.centroid().to_array(), "size": f.area})
}

fn error_json(e: &Fail) -> Value {
    match e {
        Fail::Value { message, code } => json!({"type": "value", "message": message, "code": code}),
        Fail::Missing(key) => json!({"type": "missing", "message": key, "code": null}),
        Fail::Internal(name) => json!({"type": "internal", "message": name, "code": null}),
    }
}

fn run_case(case: &Value, part: &Shape) -> Value {
    let mut diag = Vec::new();
    let sel = &case["selector"];
    let mut out = serde_json::Map::new();
    let mut r = Resolver::new(Some(&mut diag), Some("f1"));
    let index = case["index"].as_u64().unwrap_or(0) as usize;
    let res: Result<Option<Value>, Fail> = match case["fn"].as_str().unwrap_or("") {
        "edges" => r
            .edges(part, sel)
            .map(|v| Some(Value::Array(v.iter().map(edge_summary).collect()))),
        "faces" => r
            .faces(part, sel)
            .map(|v| Some(Value::Array(v.iter().map(face_summary).collect()))),
        "plane" => {
            let n = &case["normal"];
            let normal = [0, 1, 2].map(|i| n[i].as_f64().unwrap_or(0.0));
            let label = case["label"].as_str().unwrap_or("Sketch");
            let f = r.face_on_plane(Some(part), sel, normal, label);
            Ok(Some(Value::Array(f.iter().map(face_summary).collect())))
        }
        "edge_fp" => {
            let e = &sa::items(part, ItemKind::Edge)[index];
            edge_fingerprint(e, part).map(|fp| {
                out.insert("fp".into(), fp);
                None
            })
        }
        "face_fp" => {
            let f = &sa::items(part, ItemKind::Face)[index];
            face_fingerprint(f).map(|fp| {
                out.insert("fp".into(), fp);
                None
            })
        }
        other => panic!("unknown fn {other}"),
    };
    match res {
        Ok(Some(v)) => {
            out.insert("result".into(), v);
        }
        Ok(None) => {}
        Err(e) => {
            out.insert("error".into(), error_json(&e));
        }
    }
    out.insert("diag".into(), Value::Array(diag));
    Value::Object(out)
}

#[test]
fn every_selector_kind_resolves_as_the_python_engine_does() {
    let text = std::fs::read_to_string(format!("{DIR}/fixtures.json")).expect("fixtures");
    let cases: Vec<Value> = serde_json::from_str(&text).expect("fixtures are JSON");
    let mut parts: HashMap<String, Shape> = HashMap::new();
    let mut bad = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap_or("?");
        let part_name = case["part"].as_str().unwrap_or("?").to_owned();
        let part = parts.entry(part_name.clone()).or_insert_with(|| {
            let brep =
                std::fs::read_to_string(format!("{DIR}/{part_name}.brep")).expect("part BREP");
            mesh_access::read_brep_str(&brep).expect("part BREP reads")
        });
        let got = run_case(case, part);
        let mut want = serde_json::Map::new();
        for key in ["result", "error", "fp", "diag"] {
            if let Some(v) = case.get(key) {
                want.insert(key.into(), v.clone());
            }
        }
        let mut diffs = Vec::new();
        close(&got, &Value::Object(want), name, &mut diffs);
        bad.extend(diffs);
    }
    assert!(
        bad.is_empty(),
        "{} mismatches:\n{}",
        bad.len(),
        bad.join("\n")
    );
}
