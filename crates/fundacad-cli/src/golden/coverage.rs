//! e2e_coverage.py's explicit checks on this engine, through the same credit gate.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::{body_volume, Ctx, Session};

const DELTA_UNITS: [&str; 7] = [
    "patternRect",
    "patternCircular",
    "patternLinear",
    "scale",
    "move",
    "removeBody",
    "mirror",
];

fn measure_of(kind: &str) -> &'static str {
    match kind {
        "volume" | "delta_volume" => "volume",
        "bbox" | "delta_bbox" => "bbox",
        "pairs_eq" => "pairs",
        _ => "bodies",
    }
}

fn six(v: &Value) -> Option<Vec<f64>> {
    let a = v.as_array()?;
    let out: Vec<f64> = a.iter().filter_map(Value::as_f64).collect();
    (a.len() == 6 && out.len() == 6).then_some(out)
}

/// e2e_coverage._judge: None when the assertion earns credit, else why not.
fn judge(
    unit: &str,
    kind: &str,
    expected: &Value,
    actual: &Value,
    pre: Option<&Value>,
    vol_tol: f64,
    bbox_tol: f64,
) -> Option<String> {
    let is_delta = kind.starts_with("delta_");
    let delta_unit = DELTA_UNITS.contains(&unit);
    if delta_unit && !is_delta {
        return Some(format!(
            "{unit} is a transform/pattern/remove/scale/move unit, needs a delta_* invariant"
        ));
    }
    if is_delta && !delta_unit {
        return Some(format!(
            "{unit} may not claim credit through a delta invariant"
        ));
    }
    match kind {
        "bodies_eq" | "pairs_eq" | "delta_bodies" => {
            let Some(e) = expected.as_i64().filter(|_| expected.is_i64()) else {
                return Some(format!("{kind} expected must be an int, got {expected}"));
            };
            if actual.as_i64() != Some(e) {
                return Some(format!("{kind}: actual {actual} != expected {e}"));
            }
            if kind == "delta_bodies" {
                let Some(p) = pre.and_then(Value::as_i64) else {
                    return Some("delta_bodies needs an int pre-op count".into());
                };
                if p == e {
                    return Some(format!("delta_bodies is a no-op (pre==post=={e})"));
                }
            }
            None
        }
        "volume" | "delta_volume" => {
            let Some(e) = expected.as_f64().filter(|e| *e > 0.0) else {
                return Some(format!(
                    "{kind} expected must be a positive number, got {expected}"
                ));
            };
            let Some(a) = actual.as_f64() else {
                return Some(format!("{kind}: no measured volume"));
            };
            if (a - e).abs() > e * vol_tol {
                return Some(format!("{kind}: actual {a:.4} != expected {e:.4}"));
            }
            if kind == "delta_volume" {
                let Some(p) = pre.and_then(Value::as_f64) else {
                    return Some("delta_volume needs a numeric pre-op volume".into());
                };
                if (a - p).abs() <= p.abs() * vol_tol {
                    return Some(format!(
                        "delta_volume did not move (pre {p:.4} ~ post {a:.4})"
                    ));
                }
            }
            None
        }
        "bbox" | "delta_bbox" => {
            let (Some(e), Some(a)) = (six(expected), six(actual)) else {
                return Some(format!("{kind} expected/actual must be 6-number bboxes"));
            };
            for i in 0..6 {
                if (a[i] - e[i]).abs() > bbox_tol {
                    return Some(format!(
                        "{kind}: component {i} {:.5} != expected {:.5}",
                        a[i], e[i]
                    ));
                }
            }
            if kind == "delta_bbox" {
                let Some(p) = pre.and_then(six) else {
                    return Some("delta_bbox needs a 6-number pre-op bbox".into());
                };
                if (0..6).all(|i| (a[i] - p[i]).abs() <= bbox_tol) {
                    return Some("delta_bbox did not move the bounding box".into());
                }
            }
            None
        }
        other => Some(format!("unknown invariant kind {other:?}")),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
    }
}

fn doc(features: &Value) -> Value {
    json!({"parameters": {}, "features": features})
}

fn rebuild(
    s: &mut Session,
    features: &Value,
    op: &str,
    extra: &Value,
    fine: f64,
) -> Result<Value, String> {
    let mut req = json!({"document": doc(features), "tolerance": fine});
    if let Some(m) = extra.as_object() {
        for (k, v) in m {
            req[k] = v.clone();
        }
    }
    let reply = s.call(op, req);
    if reply["ok"] != true {
        return Err(format!("{op} not ok: {}", reply["error"]));
    }
    let r = &reply["result"];
    let bodies = r["bodies"].as_array().cloned().unwrap_or_default();
    let volume: f64 = bodies
        .iter()
        .filter(|b| b["positions"].as_array().is_some_and(|p| !p.is_empty()))
        .map(body_volume)
        .sum();
    let bbox = match r.get("bbox").filter(|b| !b.is_null()) {
        Some(bb) => json!([
            bb["min"][0],
            bb["min"][1],
            bb["min"][2],
            bb["max"][0],
            bb["max"][1],
            bb["max"][2]
        ]),
        None => Value::Null,
    };
    Ok(json!({"volume": volume, "bodies": bodies.len(), "bbox": bbox}))
}

/// One measure as freeze_goldens.coverage_measure takes it on the Python engine.
fn measure(ctx: &Ctx, s: &mut Session, m: &Value, fine: f64) -> Result<Value, String> {
    let features = &m["features"];
    match m["proc"].as_str().unwrap_or("") {
        "rebuild" => rebuild(
            s,
            features,
            m["op"].as_str().unwrap_or("rebuild"),
            &m["extra"],
            fine,
        ),
        "interference" => {
            let reply = s.call("interference", json!({"document": doc(features)}));
            if reply["ok"] != true {
                return Err(format!("interference not ok: {}", reply["error"]));
            }
            Ok(json!({"pairs": reply["result"]["pairs"].as_array().map_or(0, Vec::len)}))
        }
        "exportReimport" => {
            let dir = ctx.work.join("coverage-export");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join("box.stl");
            let exp = s.call(
                "export",
                json!({"document": doc(features), "format": "stl", "path": path.to_string_lossy()}),
            );
            if exp["ok"] != true {
                return Err(format!("export not ok: {}", exp["error"]));
            }
            let imp = s.call(
                "import",
                json!({"path": path.to_string_lossy(), "format": "stl"}),
            );
            if imp["ok"] != true {
                return Err(format!("reimport not ok: {}", imp["error"]));
            }
            let mut feats = vec![
                json!({"id": "im", "type": "import", "format": "stl", "name": "box", "geom": imp["result"]["geom"]}),
            ];
            feats.extend(m["then"].as_array().cloned().unwrap_or_default());
            let _ = std::fs::remove_dir_all(&dir);
            rebuild(s, &Value::Array(feats), "rebuild", &Value::Null, fine)
        }
        "projectBbox" => {
            let reply = s.call(
                "projectGeometry",
                json!({"document": doc(features), "plane": m["plane"], "sources": m["sources"]}),
            );
            if reply["ok"] != true {
                return Err(format!("projectGeometry not ok: {}", reply["error"]));
            }
            let res = &reply["result"]["results"];
            if res[0]["ok"] != true {
                return Err(format!("source not ok: {res}"));
            }
            let curves: Vec<Value> = res[0]["curves"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| e["curve"].clone())
                .collect();
            if curves.is_empty() || curves.iter().any(|c| c["kind"] != "line") {
                return Err(format!("expected lines, got {curves:?}"));
            }
            let get = |keys: [&str; 2]| -> Vec<f64> {
                curves
                    .iter()
                    .flat_map(|c| keys.map(|k| c[k].as_f64().unwrap_or(f64::NAN)))
                    .collect()
            };
            let (xs, ys) = (get(["x1", "x2"]), get(["y1", "y2"]));
            let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
            let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            Ok(json!({"bbox": [min(&xs), min(&ys), 0, max(&xs), max(&ys), 0]}))
        }
        "migrate" => {
            let reply = s.call(
                "migrateGeometry",
                json!({"items": [{"id": "legacy1", "brep": m["brep"]}]}),
            );
            let r = &reply["result"];
            if reply["ok"] != true
                || truthy(&r["failed"])
                || r["items"].as_array().is_none_or(Vec::is_empty)
            {
                return Err(format!("migrateGeometry not ok: {reply}"));
            }
            let feats = json!([{"id": "im", "type": "import", "format": "brep", "name": "legacy", "geom": r["items"][0]["geom"]}]);
            rebuild(s, &feats, "rebuild", &Value::Null, fine)
        }
        "inspectVolume" => {
            let reply = s.call("inspect", json!({"document": doc(features)}));
            if reply["ok"] != true {
                return Err(format!("inspect not ok: {}", reply["error"]));
            }
            let bodies = reply["result"]["bodies"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if bodies.len() != 1 {
                return Err(format!("{} bodies, expected 1", bodies.len()));
            }
            Ok(json!({"volume": bodies[0]["volume"]}))
        }
        "shapeVolume" => {
            let reply = s.call(
                "generateShape",
                json!({"generator": m["generator"], "params": m["params"], "output": m["output"]}),
            );
            if reply["ok"] != true {
                return Err(format!("generateShape not ok: {}", reply["error"]));
            }
            Ok(json!({"volume": reply["result"]["volume"]}))
        }
        other => Err(format!("no measure procedure {other}")),
    }
}

pub fn check(ctx: &Ctx) -> Result<bool, String> {
    let header = ctx.header();
    let fine = header["fineTolerance"].as_f64().unwrap_or(0.005);
    let (vol_tol, bbox_tol) = (ctx.tol("volumeRel"), ctx.tol("bboxAbs"));
    let universe: BTreeSet<String> = header["universe"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u.as_str().map(str::to_owned))
        .collect();
    let py_covered: BTreeSet<String> = header["pythonCovered"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u.as_str().map(str::to_owned))
        .collect();
    let mut checks: Vec<(&String, &Value)> = ctx
        .cases()
        .as_object()
        .ok_or("the golden has no cases")?
        .iter()
        .collect();
    checks.sort_by_key(|(_, c)| c["order"].as_u64().unwrap_or(0));
    let mut s = Session::start();
    let mut covered = BTreeSet::new();
    println!("-- explicit checks --");
    for (name, c) in checks {
        let run = |s: &mut Session| -> Result<(Value, Option<Value>), String> {
            let pre = match c["pre"].is_null() {
                true => None,
                false => Some(measure(ctx, s, &c["pre"], fine)?),
            };
            Ok((measure(ctx, s, &c["measure"], fine)?, pre))
        };
        let (got, pre) = match run(&mut s) {
            Ok(v) => v,
            Err(e) => {
                println!("  REFUSE check_{name}: op raised {e}");
                continue;
            }
        };
        for a in c["asserts"].as_array().into_iter().flatten() {
            let (unit, kind) = (
                a["unit"].as_str().unwrap_or(""),
                a["kind"].as_str().unwrap_or(""),
            );
            let key = measure_of(kind);
            let p = pre.as_ref().map(|p| p[key].clone());
            let expected = match a["expected"].get("timesPre") {
                Some(k) => json!(
                    k.as_f64().unwrap_or(0.0)
                        * p.as_ref().and_then(Value::as_f64).unwrap_or(f64::NAN)
                ),
                None => a["expected"].clone(),
            };
            match judge(
                unit,
                kind,
                &expected,
                &got[key],
                p.as_ref(),
                vol_tol,
                bbox_tol,
            ) {
                None => {
                    covered.insert(unit.to_owned());
                    println!(
                        "  COVER {unit:16} {kind:13} expected={expected} actual={}",
                        got[key]
                    );
                }
                Some(why) => println!("  REFUSE {unit:16} {kind:13} {why}"),
            }
        }
    }
    let covered: BTreeSet<String> = covered.intersection(&universe).cloned().collect();
    let uncovered: Vec<&String> = universe.difference(&covered).collect();
    println!("\ncovered {}/{}", covered.len(), universe.len());
    println!("UNCOVERED {}: {uncovered:?}", uncovered.len());
    let lost: Vec<&String> = py_covered.difference(&covered).collect();
    println!(
        "python covered {}/{}; lost here: {}",
        py_covered.len(),
        universe.len(),
        if lost.is_empty() {
            "none".to_owned()
        } else {
            format!("{lost:?}")
        }
    );
    Ok(lost.is_empty())
}
