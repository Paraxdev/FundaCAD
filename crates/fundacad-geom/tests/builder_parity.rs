//! The Rust builder against numbers measured on the Python builder
//! (tests/builder/gen_fixtures.py writes tests/builder/fixtures.json).

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use serde_json::Value;

const VOLUME_REL: f64 = 5e-3;
const BBOX_ABS: f64 = 1e-4;

fn close_rel(a: f64, b: f64) -> bool {
    (a - b).abs() <= VOLUME_REL * a.abs().max(b.abs()) + 1e-9
}

fn check_case(name: &str, case: &Value) -> Vec<String> {
    let mut bad = Vec::new();
    let doc = &case["doc"];
    let expect = &case["expect"];
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("fixture document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    if std::env::var("PARITY_VERBOSE").is_ok() {
        let vols: Vec<f64> = r.bodies.iter().map(|b| kernel::volume(&b.shape)).collect();
        eprintln!(
            "{name}: {vols:?} {:?}",
            r.errors.iter().map(|e| &e.message).collect::<Vec<_>>()
        );
    }

    let errors: Vec<Value> = r.errors.iter().map(|e| e.wire()).collect();
    if &Value::Array(errors.clone()) != &expect["errors"] {
        bad.push(format!("{name}: errors {errors:?} != {}", expect["errors"]));
    }

    let want = expect["bodies"].as_array().cloned().unwrap_or_default();
    if want.len() != r.bodies.len() {
        bad.push(format!(
            "{name}: {} bodies, expected {}",
            r.bodies.len(),
            want.len()
        ));
        return bad;
    }
    for (got, want) in r.bodies.iter().zip(&want) {
        if got.id != want["id"] || got.name != want["name"] {
            bad.push(format!(
                "{name}: body {}/{} != {}/{}",
                got.id, got.name, want["id"], want["name"]
            ));
        }
        let vol = kernel::volume(&got.shape);
        let wv = want["volume"].as_f64().unwrap_or(f64::NAN);
        if !close_rel(vol, wv) {
            bad.push(format!("{name}: {} volume {vol} != {wv}", got.id));
        }
        let owners: Vec<Value> = kernel::subshapes(&got.shape, kernel::Kind::Face)
            .iter()
            .map(|f| {
                builder::owners::face_key(f)
                    .and_then(|k| got.owners.get(&k))
                    .map_or(Value::Null, |o| Value::String(o.clone()))
            })
            .collect();
        // As a multiset: OCCT 7.8 and 7.9 may explore a fused body's faces in
        // a different order, and each engine's face ids follow its own order.
        let sorted = |v: &[Value]| {
            let mut s: Vec<String> = v.iter().map(Value::to_string).collect();
            s.sort();
            s
        };
        let want_owners = want["faceOwners"].as_array().cloned().unwrap_or_default();
        if sorted(&owners) != sorted(&want_owners) {
            bad.push(format!(
                "{name}: {} faceOwners {owners:?} != {}",
                got.id, want["faceOwners"]
            ));
        }
        let bb = kernel::bbox(&got.shape);
        match (bb, want["bbox"].as_array()) {
            (Some(bb), Some(w)) => {
                for k in 0..6 {
                    let wk = w[k].as_f64().unwrap_or(f64::NAN);
                    if (bb[k] - wk).abs() > BBOX_ABS {
                        bad.push(format!("{name}: {} bbox {bb:?} != {w:?}", got.id));
                        break;
                    }
                }
            }
            (None, None) => {}
            (g, w) => bad.push(format!("{name}: {} bbox {g:?} != {w:?}", got.id)),
        }
    }

    let changed = match &typed.body_ids {
        Some(old) => *old != r.body_ids,
        None => true,
    };
    match expect.get("bodyIds") {
        Some(want) => {
            let got = serde_json::to_value(&r.body_ids).unwrap_or(Value::Null);
            if !changed || &got != want {
                bad.push(format!("{name}: bodyIds {got} != {want}"));
            }
        }
        None => {
            if changed {
                bad.push(format!("{name}: bodyIds reported as changed"));
            }
        }
    }

    let planes = serde_json::to_value(&r.datum_planes).unwrap_or(Value::Null);
    let want_planes = expect["datumPlanes"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let got_planes = planes.as_object().cloned().unwrap_or_default();
    if want_planes.len() != got_planes.len() {
        bad.push(format!(
            "{name}: datumPlanes {planes} != {}",
            expect["datumPlanes"]
        ));
    }
    for (id, want) in &want_planes {
        for key in ["origin", "xdir", "normal"] {
            let (g, w) = (&got_planes.get(id).map(|p| &p[key]), &want[key]);
            let ok = g
                .and_then(Value::as_array)
                .zip(w.as_array())
                .is_some_and(|(g, w)| {
                    g.iter().zip(w).all(|(a, b)| {
                        (a.as_f64().unwrap_or(f64::NAN) - b.as_f64().unwrap_or(f64::NAN)).abs()
                            < 1e-9
                    })
                });
            if !ok {
                bad.push(format!("{name}: datum {id}.{key} {g:?} != {w}"));
            }
        }
    }

    let kinds = |v: &[Value]| -> Vec<(Value, Value)> {
        v.iter()
            .map(|d| (d["feature_id"].clone(), d["kind"].clone()))
            .collect()
    };
    let want_diag = expect["diagnostics"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if kinds(&r.diagnostics) != kinds(&want_diag) {
        bad.push(format!(
            "{name}: diagnostics {:?} != {:?}",
            kinds(&r.diagnostics),
            kinds(&want_diag)
        ));
    }
    bad
}

#[test]
fn builder_matches_the_python_engine() {
    let text = include_str!("builder/fixtures.json");
    let fixtures: serde_json::Map<String, Value> =
        serde_json::from_str(text).expect("fixtures parse");
    let only = std::env::var("PARITY_CASE").ok();
    let mut bad = Vec::new();
    for (name, case) in &fixtures {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        bad.extend(check_case(name, case));
    }
    assert!(
        bad.is_empty(),
        "{} mismatches:\n{}",
        bad.len(),
        bad.join("\n")
    );
}
