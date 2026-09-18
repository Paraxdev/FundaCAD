//! diff_engines.py against a golden: body count and ids, per body mesh volume,
//! the document bbox and the ordered (feature id, error class) pairs.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::{absolute_image_paths, body_volume, fx, table, verdict, Ctx, Session};

pub struct Outcome {
    pub bodies: usize,
    pub volumes: BTreeMap<String, f64>,
    pub bbox: Option<Value>,
    pub errors: Vec<(Value, String)>,
}

/// diff_engines.outcome on this engine's reply.
pub fn outcome(ctx: &Ctx, reply: &Value) -> Outcome {
    let class = |m: &str| super::error_class(&ctx.normalise(m));
    if reply["ok"] != true {
        let err = &reply["error"];
        let message = match err {
            Value::Object(_) => err["message"].as_str().unwrap_or("").to_owned(),
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        return Outcome {
            bodies: 0,
            volumes: BTreeMap::new(),
            bbox: None,
            errors: vec![(
                err.get("feature_id").cloned().unwrap_or(Value::Null),
                class(&message),
            )],
        };
    }
    let result = &reply["result"];
    let bodies = result["bodies"].as_array().cloned().unwrap_or_default();
    let volumes = bodies
        .iter()
        .map(|b| (b["id"].as_str().unwrap_or("").to_owned(), body_volume(b)))
        .collect();
    let errors = result["featureErrors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| {
            (
                e.get("feature_id").cloned().unwrap_or(Value::Null),
                class(e["message"].as_str().unwrap_or("")),
            )
        })
        .collect();
    Outcome {
        bodies: bodies.len(),
        volumes,
        bbox: result.get("bbox").filter(|b| !b.is_null()).cloned(),
        errors,
    }
}

fn diagonal(bbox: &Value) -> f64 {
    (0..3)
        .map(|i| {
            let d = bbox["max"][i].as_f64().unwrap_or(0.0) - bbox["min"][i].as_f64().unwrap_or(0.0);
            d * d
        })
        .sum::<f64>()
        .sqrt()
}

fn errors_text(errors: &[(Value, String)]) -> String {
    let parts: Vec<String> = errors
        .iter()
        .map(|(f, c)| {
            format!(
                "({}, {c:?})",
                if f.is_null() {
                    "None".into()
                } else {
                    f.to_string()
                }
            )
        })
        .collect();
    format!("[{}]", parts.join(", "))
}

/// diff_engines.compare with the golden as the reference.
pub fn compare(ctx: &Ctx, py: &Value, rs: &Outcome) -> Vec<String> {
    let vol_tol = ctx.tol("volumeRel");
    let floor = ctx.tol("volumeFloor");
    let bbox_abs = ctx.tol("bboxAbs");
    let bbox_rel = ctx.tol("bboxRelOfDiagonal");
    let mut diffs = Vec::new();
    let py_bodies = py["bodies"].as_u64().unwrap_or(0) as usize;
    if py_bodies != rs.bodies {
        diffs.push(format!("bodies {} vs {py_bodies}", rs.bodies));
    }
    let py_vol: BTreeMap<String, f64> = py["volumes"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
                .collect()
        })
        .unwrap_or_default();
    if py_vol.keys().ne(rs.volumes.keys()) {
        diffs.push(format!(
            "body ids {:?} vs {:?}",
            rs.volumes.keys().collect::<Vec<_>>(),
            py_vol.keys().collect::<Vec<_>>()
        ));
    }
    for (bid, pv) in &py_vol {
        if let Some(rv) = rs.volumes.get(bid) {
            if (rv - pv).abs() > (pv.abs() * vol_tol).max(floor) {
                diffs.push(format!("{bid} volume {} vs {}", fx(*rv, 4), fx(*pv, 4)));
            }
        }
    }
    let pb = py.get("bbox").filter(|b| !b.is_null());
    match (pb, &rs.bbox) {
        (None, None) => {}
        (Some(_), None) => diffs.push("bbox missing".into()),
        (None, Some(_)) => diffs.push("bbox where the reference has none".into()),
        (Some(pb), Some(rb)) => {
            let tol = bbox_abs.max(bbox_rel * diagonal(pb));
            for corner in ["min", "max"] {
                for i in 0..3 {
                    let (r, p) = (
                        rb[corner][i].as_f64().unwrap_or(f64::NAN),
                        pb[corner][i].as_f64().unwrap_or(f64::NAN),
                    );
                    if !((r - p).abs() <= tol) {
                        diffs.push(format!("bbox {corner}[{i}] {} vs {}", fx(r, 6), fx(p, 6)));
                    }
                }
            }
        }
    }
    let py_errors: Vec<(Value, String)> = py["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| (e[0].clone(), e[1].as_str().unwrap_or("").to_owned()))
        .collect();
    if py_errors != rs.errors {
        diffs.push(format!(
            "errors {} vs {}",
            errors_text(&rs.errors),
            errors_text(&py_errors)
        ));
    }
    diffs
}

/// A document's import fixture through this engine's import op, merged into its
/// feature as diff_engines.import_all merges the Python reply.
fn seed(
    ctx: &Ctx,
    session: &mut Session,
    doc: &mut Value,
    spec: &Value,
) -> (Vec<String>, Option<String>) {
    let path = ctx.repo.join(spec["fixture"].as_str().unwrap_or(""));
    let reply = session.call(
        "import",
        json!({"path": path.to_string_lossy(), "format": spec["format"]}),
    );
    if reply["ok"] != true {
        return (
            vec![format!(
                "the import op refused {}: {}",
                spec["fixture"], reply["error"]
            )],
            None,
        );
    }
    let mut result = reply["result"].as_object().cloned().unwrap_or_default();
    let mut rest = result.clone();
    let geom = rest.remove("geom");
    let mut diffs = Vec::new();
    let got = ctx.normalise_all(&Value::Object(rest));
    if got != spec["reply"] {
        diffs.push(format!("import reply {got} vs {}", spec["reply"]));
    }
    let same_blob = geom.as_ref() == Some(&spec["pythonGeom"]);
    for f in doc["features"].as_array_mut().into_iter().flatten() {
        if f["id"] == spec["feature"] {
            for (k, v) in f.as_object().cloned().unwrap_or_default() {
                result.insert(k, v);
            }
            *f = Value::Object(result.clone());
        }
    }
    let note = if same_blob {
        "the python blob hash".to_owned()
    } else {
        format!(
            "imported here as blob {}, python stored {}",
            geom.and_then(|g| g.as_str().map(str::to_owned))
                .unwrap_or_default(),
            spec["pythonGeom"].as_str().unwrap_or("")
        )
    };
    (diffs, Some(note))
}

pub fn check(ctx: &Ctx) -> Result<bool, String> {
    let docs = ctx.corpus["documents"]
        .as_array()
        .ok_or("the corpus has no documents")?;
    let tolerance = ctx.header()["rebuildTolerance"].as_f64().unwrap_or(0.1);
    let cases = ctx.cases().as_object().ok_or("the golden has no cases")?;
    let names: Vec<&str> = docs.iter().filter_map(|d| d["name"].as_str()).collect();
    if names.len() != cases.len() || names.iter().any(|n| !cases.contains_key(*n)) {
        return Err("the golden's cases are not the corpus's documents".into());
    }
    let mut prepared = Vec::new();
    let mut seeding = Session::start();
    for d in docs {
        let name = d["name"].as_str().unwrap_or("");
        let mut doc = d["document"].clone();
        absolute_image_paths(&mut doc, &ctx.repo);
        let (diffs, note) = match cases[name].get("import") {
            Some(spec) => seed(ctx, &mut seeding, &mut doc, spec),
            None => (Vec::new(), None),
        };
        prepared.push((name, doc, diffs, note));
    }
    drop(seeding);

    let mut session = Session::start();
    let mut rows = Vec::new();
    let mut bad = 0;
    let mut notes = Vec::new();
    for (name, doc, mut diffs, note) in prepared {
        let reply = session.call(
            "rebuild",
            json!({"document": doc, "tolerance": tolerance, "binary": false}),
        );
        let rs = outcome(ctx, &reply);
        let py = &cases[name];
        diffs.extend(compare(ctx, py, &rs));
        if let Some(n) = note {
            notes.push(format!("  {name}: {n}"));
        }
        bad += usize::from(!diffs.is_empty());
        rows.push(vec![
            name.to_owned(),
            py["bodies"].to_string(),
            rs.bodies.to_string(),
            if diffs.is_empty() {
                "match"
            } else {
                "MISMATCH"
            }
            .to_owned(),
            diffs.join("; "),
        ]);
    }
    table(
        &rows,
        &["document", "py bodies", "rust bodies", "status", "detail"],
    );
    if !notes.is_empty() {
        println!("\nimport fixtures, through this engine's import op:");
        for n in &notes {
            println!("{n}");
        }
    }
    Ok(verdict(bad, rows.len()))
}
