//! diff_plugin_ops.py against a golden: `exportWith` replies and their zip
//! entries, `generateShape` replies, preview meshes and stored blobs.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};

use super::{body_volume, fx, ivec_rows, sha256_hex, table, verdict, Ctx, Session};

fn substitute(v: &Value, token: &str, value: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(token, value)),
        Value::Array(a) => Value::Array(a.iter().map(|x| substitute(x, token, value)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), substitute(x, token, value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// diff_plugin_ops.prepare_export: the data folder written, the placeholders filled.
fn prepare_export(ctx: &Ctx, e: &Value, i: usize) -> Result<Value, String> {
    let mut e = e.clone();
    if let Some(files) = e.get("datadir").and_then(Value::as_object).cloned() {
        let root = ctx
            .work
            .join(format!("datadir{i}"))
            .join("user")
            .join("app-data");
        for (rel, content) in files {
            let path = rel.split('/').fold(root.clone(), |acc, p| acc.join(p));
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            let text = match content {
                Value::String(s) => s,
                other => python_json(&other),
            };
            std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        e = substitute(&e, "$DATADIR", &root.to_string_lossy());
    }
    Ok(substitute(
        &e,
        "$MISSING",
        &ctx.work.join("no-such-folder").to_string_lossy(),
    ))
}

/// `json.dump` with its default separators, so a plugin reads the bytes the
/// Python tool wrote.
fn python_json(v: &Value) -> String {
    match v {
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(python_json).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(m) => format!(
            "{{{}}}",
            m.iter()
                .map(|(k, x)| format!(
                    "{}: {}",
                    ascii_json(&Value::String(k.clone())),
                    python_json(x)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => ascii_json(other),
    }
}

fn ascii_json(v: &Value) -> String {
    let s = v.to_string();
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for u in c.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out
}

fn blocks<'a>(text: &'a str, open: &str, close: &str) -> Vec<(usize, usize, &'a str)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = text[from..].find(open) {
        let start = from + i;
        let body = start + open.len();
        let Some(j) = text[body..].find(close) else {
            break;
        };
        out.push((start, body + j + close.len(), &text[body..body + j]));
        from = body + j + close.len();
    }
    out
}

/// `TRIANGLES.sub("<triangles/>", text)`.
fn skeleton(text: &str) -> String {
    let mut out = String::new();
    let mut last = 0;
    for (s, e, _) in blocks(text, "<triangles>", "</triangles>") {
        out.push_str(&text[last..s]);
        out.push_str("<triangles/>");
        last = e;
    }
    out.push_str(&text[last..]);
    out
}

/// The quoted values of `a="..." b="..." c="..."` runs, as the tool's regexes read them.
fn attr_runs<'a>(text: &'a str, names: [&str; 3], digits_only: bool) -> Vec<[&'a str; 3]> {
    let mut out = Vec::new();
    let first = format!("{}=\"", names[0]);
    let mut from = 0;
    'outer: while let Some(i) = text[from..].find(&first) {
        let start = from + i;
        from = start + 1;
        let mut pos = start;
        let mut vals = [""; 3];
        for (k, name) in names.iter().enumerate() {
            let lead = if k == 0 {
                format!("{name}=\"")
            } else {
                format!("\" {name}=\"")
            };
            if !text[pos..].starts_with(&lead) {
                continue 'outer;
            }
            pos += lead.len();
            let end = match text[pos..].find('"') {
                Some(e) => pos + e,
                None => continue 'outer,
            };
            let v = &text[pos..end];
            if v.is_empty() || (digits_only && !v.bytes().all(|b| b.is_ascii_digit())) {
                continue 'outer;
            }
            vals[k] = v;
            pos = end;
        }
        out.push(vals);
        from = pos;
    }
    out
}

/// diff_plugin_ops._mesh_measure: area, signed volume and the free edges.
fn mesh_measure(vertex_xml: &str, triangle_xml: &str) -> (f64, f64, BTreeSet<(u64, u64)>) {
    let v: Vec<[f64; 3]> = attr_runs(vertex_xml, ["x", "y", "z"], false)
        .iter()
        .map(|t| [0, 1, 2].map(|k| t[k].parse::<f64>().unwrap_or(f64::NAN)))
        .collect();
    let (mut area, mut vol) = (0.0, 0.0);
    let mut edges: std::collections::BTreeMap<(u64, u64), usize> = Default::default();
    for t in attr_runs(triangle_xml, ["v1", "v2", "v3"], true) {
        let ids = t.map(|s| s.parse::<u64>().unwrap_or(0));
        let [a, b, c] = ids.map(|i| v.get(i as usize).copied().unwrap_or([f64::NAN; 3]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * w[2] - u[2] * w[1],
            u[2] * w[0] - u[0] * w[2],
            u[0] * w[1] - u[1] * w[0],
        ];
        area += (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() / 2.0;
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.0;
        for (i, j) in [(ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])] {
            *edges.entry((i.min(j), i.max(j))).or_default() += 1;
        }
    }
    let boundary = edges
        .into_iter()
        .filter(|(_, n)| *n == 1)
        .map(|(k, _)| k)
        .collect();
    (area, vol, boundary)
}

/// compare_model with the golden's per object record standing in for python's text.
fn compare_model(text: &str, want: &Value, name: &str) -> (Vec<String>, Vec<String>) {
    if sha256_hex(skeleton(text).as_bytes()) != want["skeletonSha256"].as_str().unwrap_or("") {
        return (
            vec![format!(
                "{name}: the model differs outside its triangle lists"
            )],
            vec![],
        );
    }
    let tris = blocks(text, "<triangles>", "</triangles>");
    let verts = blocks(text, "<vertices>", "</vertices>");
    let objects = want["objects"].as_array().cloned().unwrap_or_default();
    if tris.len() != objects.len() {
        return (
            vec![format!("model: {} meshes vs {}", tris.len(), objects.len())],
            vec![],
        );
    }
    let mut moved = 0;
    for (k, ((_, _, t), o)) in tris.iter().zip(&objects).enumerate() {
        if sha256_hex(t.as_bytes()) == o["trianglesSha256"].as_str().unwrap_or("") {
            continue;
        }
        let count = t.matches("<triangle").count() as u64;
        let want_count = o["triangles"].as_u64().unwrap_or(0);
        if count != want_count {
            return (
                vec![format!(
                    "model object {k}: {count} triangles vs {want_count}"
                )],
                vec![],
            );
        }
        let (area, vol, free) = mesh_measure(verts.get(k).map_or("", |v| v.2), t);
        let (pa, pv) = (
            o["area"].as_f64().unwrap_or(0.0),
            o["volume"].as_f64().unwrap_or(0.0),
        );
        let pfree: BTreeSet<(u64, u64)> = o["freeEdges"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| (e[0].as_u64().unwrap_or(0), e[1].as_u64().unwrap_or(0)))
            .collect();
        if (pa - area).abs() > 1e-9 * pa.max(1.0)
            || (pv - vol).abs() > 1e-9 * pv.abs().max(1.0)
            || free != pfree
        {
            return (
                vec![format!(
                    "model object {k}: area {area:.9e} volume {vol:.9e} vs {pa:.9e} {pv:.9e}"
                )],
                vec![],
            );
        }
        moved += 1;
    }
    let notes = if moved > 0 {
        vec![format!("{moved} object(s) triangulated across other diagonals by the host mesher, same nodes, area, volume and free edges")]
    } else {
        vec![]
    };
    (vec![], notes)
}

fn basename(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or("").to_owned()
}

fn compare_export(ctx: &Ctx, py: &Value, path: &Path, reply: &Value) -> (Vec<String>, Vec<String>) {
    let (mut diffs, mut notes) = (Vec::new(), Vec::new());
    let ok = reply["ok"] == true;
    let error = ctx.normalise_all(&reply["error"]);
    if py["ok"].as_bool() != Some(ok) {
        return (
            vec![format!(
                "ok {ok} vs {}: {error} vs {}",
                py["ok"], py["error"]
            )],
            notes,
        );
    }
    if !ok {
        if error != py["error"] {
            diffs.push(format!("error {error} vs {}", py["error"]));
        }
        return (diffs, notes);
    }
    let res = &reply["result"];
    for key in ["info", "warnings"] {
        let got = ctx.normalise_all(&res[key]);
        if got != py[key] {
            diffs.push(format!("{key} {got} vs {}", py[key]));
        }
    }
    if basename(res["path"].as_str().unwrap_or("")) != basename(&path.to_string_lossy()) {
        diffs.push(format!(
            "path {} vs the requested {}",
            res["path"],
            path.display()
        ));
    }
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return (vec![format!("no file written: {e}")], notes),
    };
    let mut zip = match zip::ZipArchive::new(file) {
        Ok(z) => z,
        Err(e) => return (vec![format!("not a zip: {e}")], notes),
    };
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_owned()))
        .collect();
    let entries = py["entries"].as_array().cloned().unwrap_or_default();
    let want: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap_or(""))
        .collect();
    if names != want {
        diffs.push(format!("entries {names:?} vs {want:?}"));
        return (diffs, notes);
    }
    for (i, e) in entries.iter().enumerate() {
        let mut data = Vec::new();
        let read = zip
            .by_index(i)
            .and_then(|mut f| f.read_to_end(&mut data).map_err(Into::into));
        if read.is_err() {
            diffs.push("a corrupt zip entry".into());
            continue;
        }
        if sha256_hex(&data) == e["sha256"].as_str().unwrap_or("") {
            continue;
        }
        let name = &names[i];
        if name.ends_with(".model") {
            let (d, n) = compare_model(&String::from_utf8_lossy(&data), e, name);
            diffs.extend(d);
            notes.extend(n);
        } else {
            diffs.push(format!(
                "{name}: {} bytes, not the {} python wrote",
                data.len(),
                e["bytes"]
            ));
        }
    }
    (diffs, notes)
}

fn sorted_points(mesh: &Value) -> Vec<[f64; 3]> {
    let p = super::floats(&mesh["positions"]);
    let mut pts: Vec<[f64; 3]> = p.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    pts
}

fn compare_shape(
    ctx: &Ctx,
    py: &Value,
    reply: &Value,
    rebuilt: Option<&Value>,
) -> Result<Vec<String>, String> {
    let mut diffs = Vec::new();
    let ok = reply["ok"] == true;
    let error = ctx.normalise_all(&reply["error"]);
    if py["ok"].as_bool() != Some(ok) {
        return Ok(vec![format!(
            "ok {ok} vs {}: {error} vs {}",
            py["ok"], py["error"]
        )]);
    }
    if ok {
        let r = &reply["result"];
        for key in ["solid", "solids", "valid", "faces"] {
            let got = r.get(key).cloned().unwrap_or(Value::Null);
            if !super::evals::same_number_or_value(&got, &py[key]) {
                diffs.push(format!("{key} {got} vs {}", py[key]));
            }
        }
        let (rv, pv) = (
            r["volume"].as_f64().unwrap_or(f64::NAN),
            py["volume"].as_f64().unwrap_or(f64::NAN),
        );
        if !((rv - pv).abs() <= ctx.tol("volumeRel") * pv.abs().max(1e-9)) {
            diffs.push(format!("volume {rv:.9e} vs {pv:.9e}"));
        }
        for corner in ["min", "max"] {
            for i in 0..3 {
                let (a, b) = (
                    r["bbox"][corner][i].as_f64().unwrap_or(f64::NAN),
                    py["bbox"][corner][i].as_f64().unwrap_or(f64::NAN),
                );
                if !((a - b).abs() <= ctx.tol("bboxAbs")) {
                    diffs.push(format!("bbox {corner}[{i}] {} vs {}", fx(a, 6), fx(b, 6)));
                }
            }
        }
        if let Some(pm) = py.get("mesh") {
            let rm = r.get("mesh").cloned().unwrap_or(json!({}));
            let rtris = rm["indices"].as_array().map_or(0, Vec::len) / 3;
            let ptris = pm["triangles"].as_u64().unwrap_or(0) as usize;
            if rtris != ptris {
                diffs.push(format!("triangles {rtris} vs {ptris}"));
            } else {
                let q = ctx.header()["pointQuantum"].as_f64().unwrap_or(1e-5);
                let pp = ivec_rows(&pm["points"], q)?;
                let rp = sorted_points(&rm);
                if pp.len() != rp.len() {
                    diffs.push(format!("vertices {} vs {}", rp.len(), pp.len()));
                } else {
                    let worst = pp
                        .iter()
                        .zip(&rp)
                        .map(|(x, y)| (0..3).map(|k| (x[k] - y[k]).abs()).fold(0.0, f64::max))
                        .fold(0.0, f64::max);
                    if worst > ctx.tol("meshAbs") {
                        diffs.push(format!("vertex positions off by {worst:.3e}"));
                    }
                }
            }
            let rn = rm["normals"].as_array().is_some_and(|a| !a.is_empty());
            if pm["normals"].as_bool() != Some(rn) {
                diffs.push("normals present on one engine only".into());
            }
        }
    } else if error != py["error"] {
        diffs.push(format!("error {error} vs {}", py["error"]));
    }
    let prebuilt = py.get("rebuilt");
    if prebuilt.is_some() || rebuilt.is_some() {
        let (rv, rn) = rebuilt.map_or((0.0, 0), |r| {
            let bodies = r["result"]["bodies"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            (bodies.iter().map(body_volume).sum::<f64>(), bodies.len())
        });
        let (pv, pn) = prebuilt.map_or((0.0, 0), |p| {
            (
                p["volume"].as_f64().unwrap_or(0.0),
                p["bodies"].as_u64().unwrap_or(0) as usize,
            )
        });
        if pn != rn || (pv - rv).abs() > ctx.tol("importVolumeRel") * pv.max(1e-9) {
            diffs.push(format!(
                "stored blob rebuilt to {rn} bodies {} vs {pn} bodies {}",
                fx(rv, 4),
                fx(pv, 4)
            ));
        }
    }
    Ok(diffs)
}

fn run_export(
    ctx: &Ctx,
    session: &mut Session,
    e: &Value,
    i: usize,
) -> Result<(std::path::PathBuf, Value), String> {
    let e = prepare_export(ctx, e, i)?;
    let suffix = e["suffix"].as_str().unwrap_or(".3mf");
    let path = ctx.work.join(format!("rs-{i}{suffix}"));
    let options = e
        .get("options")
        .filter(|o| !o.is_null())
        .cloned()
        .unwrap_or(json!({}));
    let reply = session.call(
        "exportWith",
        json!({"document": e["document"], "path": path.to_string_lossy(),
               "exporter": e["exporter"], "options": options}),
    );
    Ok((path, reply))
}

/// generateShape, and for a stored shape its blob rebuilt as an import.
fn run_shape(session: &mut Session, s: &Value) -> (Value, Option<Value>) {
    let output = s["output"].as_str().unwrap_or("mesh");
    let reply = session.call(
        "generateShape",
        json!({"generator": s["generator"], "params": s.get("params").cloned().unwrap_or(Value::Null),
               "output": output, "placement": s.get("placement").cloned().unwrap_or(Value::Null)}),
    );
    let rebuilt = (output == "store" && reply["ok"] == true).then(|| {
        let doc = json!({"parameters": {}, "features": [{
            "id": "f1", "type": "import", "format": "brep", "name": "generated",
            "geom": reply["result"]["geom"], "solid": true}]});
        session.call(
            "rebuild",
            json!({"document": doc, "tolerance": 0.1, "binary": false}),
        )
    });
    (reply, rebuilt)
}

/// freeze_goldens.zip_entry on this engine's file.
fn zip_entry(name: &str, data: &[u8]) -> Value {
    use super::record::object;
    let mut entry = object(vec![
        ("bytes", json!(data.len())),
        ("name", json!(name)),
        ("sha256", json!(sha256_hex(data))),
    ]);
    if name.ends_with(".model") {
        let text = String::from_utf8_lossy(data);
        let verts = blocks(&text, "<vertices>", "</vertices>");
        let objects: Vec<Value> = blocks(&text, "<triangles>", "</triangles>")
            .iter()
            .zip(&verts)
            .map(|((_, _, t), (_, _, v))| {
                let (area, volume, free) = mesh_measure(v, t);
                // The Python tool sorted the edges as pairs of strings.
                let mut free: Vec<(u64, u64)> = free.into_iter().collect();
                free.sort_by_key(|(i, j)| (i.to_string(), j.to_string()));
                json!({"area": area, "volume": volume,
                       "freeEdges": free.iter().map(|(i, j)| json!([i, j])).collect::<Vec<_>>(),
                       "triangles": t.matches("<triangle").count(),
                       "trianglesSha256": sha256_hex(t.as_bytes())})
            })
            .collect();
        entry["skeletonSha256"] = json!(sha256_hex(skeleton(&text).as_bytes()));
        entry["objects"] = Value::Array(objects);
    }
    entry
}

/// A case's golden from this engine, as freeze_goldens.freeze_plugin_ops writes it.
pub fn record_case(ctx: &Ctx, name: &str) -> Result<Value, String> {
    use super::record::{fixed, quantised_columns, sig};
    let mut session = Session::start();
    let exports = ctx.corpus["exports"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some((i, e)) = exports.iter().enumerate().find(|(_, e)| e["name"] == name) {
        let (path, reply) = run_export(ctx, &mut session, e, i)?;
        let mut case = json!({"op": "exportWith", "ok": reply["ok"] == true});
        if reply["ok"] != true {
            case["error"] = ctx.normalise_all(&reply["error"]);
            return Ok(case);
        }
        case["info"] = ctx.normalise_all(&reply["result"]["info"]);
        case["warnings"] = ctx.normalise_all(&reply["result"]["warnings"]);
        let file = std::fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for k in 0..zip.len() {
            let mut f = zip.by_index(k).map_err(|e| e.to_string())?;
            let mut data = Vec::new();
            f.read_to_end(&mut data).map_err(|e| e.to_string())?;
            entries.push(zip_entry(f.name(), &data));
        }
        case["entries"] = Value::Array(entries);
        return Ok(case);
    }
    let shapes = ctx.corpus["shapes"].as_array().cloned().unwrap_or_default();
    let s = shapes
        .iter()
        .find(|s| s["name"] == name)
        .ok_or_else(|| format!("the corpus has no case {name}"))?;
    let (reply, rebuilt) = run_shape(&mut session, s);
    let mut case = json!({"op": "generateShape", "ok": reply["ok"] == true});
    if reply["ok"] != true {
        case["error"] = ctx.normalise_all(&reply["error"]);
    } else {
        let r = &reply["result"];
        for key in ["solid", "solids", "valid", "faces"] {
            case[key] = r.get(key).cloned().unwrap_or(Value::Null);
        }
        case["volume"] = sig(r["volume"].as_f64().unwrap_or(0.0), 15);
        let corner = |c: &str| {
            Value::Array(
                (0..3)
                    .map(|i| fixed(r["bbox"][c][i].as_f64().unwrap_or(0.0), 9))
                    .collect(),
            )
        };
        case["bbox"] = json!({"max": corner("max"), "min": corner("min")});
        if let Some(m) = r.get("mesh") {
            let points = sorted_points(m);
            let q = ctx.header()["pointQuantum"].as_f64().unwrap_or(1e-5);
            case["mesh"] = json!({
                "normals": m["normals"].as_array().is_some_and(|a| !a.is_empty()),
                "points": if points.is_empty() { String::new() } else { quantised_columns(&points, q) },
                "triangles": m["indices"].as_array().map_or(0, Vec::len) / 3,
                "vertices": points.len()});
        }
    }
    if let Some(r) = rebuilt {
        let bodies = r["result"]["bodies"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let volume: f64 = bodies.iter().map(body_volume).sum();
        case["rebuilt"] = json!({"bodies": bodies.len(), "volume": sig(volume, 10)});
    }
    Ok(case)
}

pub fn check(ctx: &Ctx) -> Result<bool, String> {
    let exports = ctx.corpus["exports"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let shapes = ctx.corpus["shapes"].as_array().cloned().unwrap_or_default();
    let cases = ctx.cases().as_object().ok_or("the golden has no cases")?;
    let mut session = Session::start();
    let mut rows = Vec::new();
    let mut bad = 0;
    for (i, e) in exports.iter().enumerate() {
        let name = e["name"].as_str().unwrap_or("");
        let py = cases
            .get(name)
            .ok_or_else(|| format!("the golden has no case {name}"))?;
        let (path, reply) = run_export(ctx, &mut session, e, i)?;
        let (diffs, notes) = compare_export(ctx, py, &path, &reply);
        bad += usize::from(!diffs.is_empty());
        rows.push(vec![
            "exportWith".into(),
            name.into(),
            if diffs.is_empty() {
                "match"
            } else {
                "MISMATCH"
            }
            .into(),
            if diffs.is_empty() {
                notes.join("; ")
            } else {
                diffs.join("; ")
            },
        ]);
    }
    for s in &shapes {
        let name = s["name"].as_str().unwrap_or("");
        let py = cases
            .get(name)
            .ok_or_else(|| format!("the golden has no case {name}"))?;
        let (reply, rebuilt) = run_shape(&mut session, s);
        let diffs = compare_shape(ctx, py, &reply, rebuilt.as_ref())?;
        bad += usize::from(!diffs.is_empty());
        rows.push(vec![
            "generateShape".into(),
            name.into(),
            if diffs.is_empty() {
                "match"
            } else {
                "MISMATCH"
            }
            .into(),
            diffs.join("; "),
        ]);
    }
    if rows.len() != cases.len() {
        return Err(format!(
            "the golden has {} cases, the corpus {}",
            cases.len(),
            rows.len()
        ));
    }
    table(&rows, &["op", "case", "status", "detail"]);
    Ok(verdict(bad, rows.len()))
}
