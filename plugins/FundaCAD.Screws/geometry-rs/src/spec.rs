//! scr_spec.py: checking a fastener spec and bringing it to millimetres.
//!
//! The required fields come from catalogue/fields.json, the same file the
//! window's form and its check (spec.ts) read. `sanity` mirrors spec.ts
//! `sanityProblems`.

use std::sync::OnceLock;

use serde_json::{Map, Value};

const INCH: f64 = 25.4;

fn fields() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!("../../catalogue/fields.json")).expect("fields.json parses")
    })
}

fn part_label(part: &str) -> &str {
    part
}

fn get<'a>(obj: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = obj;
    for k in path.split('.') {
        cur = cur.as_object()?.get(k)?;
    }
    Some(cur)
}

/// `_positive`: an int or float, never a bool, finite and above zero.
pub fn positive(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Number(n)) if n.as_f64().is_some_and(|x| x.is_finite() && x > 0.0))
}

fn field_phrase(part: &str, label: &str) -> String {
    let text = label.to_lowercase();
    if text.contains(part_label(part)) {
        text
    } else {
        format!("{} {text}", part_label(part))
    }
}

fn pairs(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let p = p.as_array()?;
                    Some((p.first()?.as_str()?.to_string(), p.get(1)?.as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn missing_fields(spec: &Value) -> Vec<String> {
    let Some(obj) = spec.as_object() else {
        return vec!["the whole spec".into()];
    };
    let f = fields();
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .and_then(|k| f["kinds"].get(k));
    let Some(kind) = kind else {
        return vec!["the fastener kind".into()];
    };
    let mut out = Vec::new();
    let units = strs(f.get("units"));
    if !obj.get("units").and_then(Value::as_str).is_some_and(|u| units.iter().any(|x| x == u)) {
        out.push("the units (mm or in)".into());
    }
    let name_ok = match obj.get("name") {
        None | Some(Value::Null) => false,
        Some(v) => !crate::py_str(v).trim().is_empty() && crate::truthy(v),
    };
    if !name_ok {
        out.push("a name".into());
    }
    for part_name in strs(kind.get("parts")) {
        let types = &f["parts"][&part_name];
        let part = obj.get(&part_name);
        let ptype = part.and_then(|p| p.as_object()).and_then(|p| p.get("type"));
        let t = ptype.and_then(Value::as_str).and_then(|t| types.get(t));
        let (Some(part), Some(t)) = (part.filter(|p| p.is_object()), t) else {
            out.push(format!("{} type", part_label(&part_name)));
            continue;
        };
        for (field, label) in pairs(t.get("fields")) {
            if !positive(part.get(&field)) {
                out.push(field_phrase(&part_name, &label));
            }
        }
    }
    for (path, label) in pairs(kind.get("fields")) {
        if !positive(get(spec, &path)) {
            out.push(label.to_lowercase());
        }
    }
    if let Some(Value::Object(thread)) = obj.get("thread") {
        let hands = strs(f.get("hands"));
        match thread.get("hand") {
            None | Some(Value::Null) => {}
            Some(Value::String(h)) if hands.iter().any(|x| x == h) => {}
            _ => out.push("thread hand (right or left)".into()),
        }
    }
    out
}

/// `_n`: the number when it is positive, NaN otherwise.
fn n(v: Option<&Value>) -> f64 {
    if positive(v) {
        v.and_then(Value::as_f64).unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn sanity(spec: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let empty = Value::Object(Map::new());
    let t = spec.get("thread").filter(|t| crate::truthy(t)).unwrap_or(&empty);
    let d = n(t.get("diameter"));
    let kind = spec["kind"].as_str().unwrap_or("");
    if crate::truthy(t) && !(n(t.get("pitch")) * 0.6134 < d / 2.0 * 0.8) {
        out.push("the pitch is too coarse for the thread diameter".into());
    }
    if kind == "screw" || kind == "shoulderScrew" {
        let head = &spec["head"];
        let drive = &spec["drive"];
        let length = n(spec.get("length"));
        let shank = if kind == "shoulderScrew" {
            n(spec.get("shoulder").and_then(|s| s.get("diameter")))
        } else {
            d
        };
        if kind == "shoulderScrew" && !(shank > d) {
            out.push("the shoulder must be wider than the thread".into());
        }
        let htype = head["type"].as_str().unwrap_or("");
        let across = if htype == "hex" || htype == "hexFlange" {
            n(head.get("acrossFlats"))
        } else {
            n(head.get("diameter"))
        };
        if htype != "none" && !(across > shank) {
            out.push("the head must be wider than the shank".into());
        }
        if htype == "hexFlange" {
            if !(n(head.get("flangeDiameter")) > n(head.get("acrossFlats"))) {
                out.push("the flange must be wider than the hex".into());
            }
            if !(n(head.get("flangeThickness")) < n(head.get("height"))) {
                out.push("the flange must be thinner than the head".into());
            }
        }
        if htype == "knurled" {
            let c = n(head.get("collarDiameter"));
            if !(shank < c && c <= n(head.get("diameter"))) {
                out.push("the collar must be wider than the shank and no wider than the knurl".into());
            }
            if !(n(head.get("collarHeight")) < n(head.get("height"))) {
                out.push("the collar must be lower than the head".into());
            }
        }
        let sunk = if htype == "countersunk" { n(head.get("height")) } else { 0.0 };
        // `if sunk and ...`: NaN is truthy in Python, only 0.0 is not.
        if sunk != 0.0 && !(sunk < length) {
            out.push("the countersunk head must be shorter than the overall length".into());
        }
        if kind == "screw" && n(t.get("length")) > length - sunk + 1e-9 {
            out.push("the thread cannot be longer than the shank".into());
        }
        let dtype = drive["type"].as_str().unwrap_or("");
        if dtype != "none" {
            let size = n(drive.get("size"));
            let room = if htype != "none" { across } else { d };
            let reach = match dtype {
                "hex" => size * 1.1547,
                "square" => size * 1.4142,
                _ => size,
            };
            let fits = if dtype == "slot" { size < room / 2.0 } else { reach < room };
            if !fits {
                out.push("the drive does not fit in the head".into());
            }
            let allowed = if htype != "none" {
                n(head.get("height")) + d / 2.0
            } else {
                length * 0.6
            };
            if !(n(drive.get("depth")) < allowed) {
                out.push("the drive recess is too deep".into());
            }
        }
        let point = spec.get("point").filter(|p| crate::truthy(p)).unwrap_or(&empty);
        let ptype = point.get("type").and_then(Value::as_str);
        if matches!(ptype, Some("flat") | Some("cup")) && !(n(point.get("diameter")) < d) {
            out.push("the point diameter must be smaller than the thread".into());
        }
    }
    if kind == "nut" {
        let nut = &spec["nut"];
        let nt = nut["type"].as_str().unwrap_or("");
        if !(n(nut.get("acrossFlats")) > d * 1.05) {
            out.push("the nut must be wider than its thread".into());
        }
        if nt == "nyloc" && !(n(nut.get("hexHeight")) < n(nut.get("height"))) {
            out.push("the hex must be lower than the whole nut".into());
        }
        if nt == "flange" {
            if !(n(nut.get("flangeDiameter")) > n(nut.get("acrossFlats"))) {
                out.push("the flange must be wider than the hex".into());
            }
            if !(n(nut.get("flangeThickness")) < n(nut.get("height"))) {
                out.push("the flange must be thinner than the nut".into());
            }
        }
    }
    if kind == "washer" {
        let w = &spec["washer"];
        if !(n(w.get("outer")) > n(w.get("inner"))) {
            out.push("the outer diameter must be larger than the inner".into());
        }
    }
    if kind == "insert" && !(n(spec["insert"].get("outer")) > d * 1.1) {
        out.push("the insert must be wider than its thread".into());
    }
    out
}

const LENGTH_KEYS: [&str; 15] = [
    "diameter",
    "height",
    "acrossFlats",
    "flangeDiameter",
    "flangeThickness",
    "collarDiameter",
    "collarHeight",
    "size",
    "depth",
    "pitch",
    "length",
    "hexHeight",
    "inner",
    "outer",
    "thickness",
];

fn to_mm(part: &Value, scale: f64) -> Value {
    let mut out = part.as_object().cloned().unwrap_or_default();
    for (k, v) in out.iter_mut() {
        if LENGTH_KEYS.contains(&k.as_str()) && positive(Some(v)) {
            *v = Value::from(v.as_f64().unwrap_or(0.0) * scale);
        }
    }
    Value::Object(out)
}

/// `checked`: the spec in millimetres, or an error naming everything wrong.
pub fn checked(spec: &Value) -> Result<Value, String> {
    let missing = missing_fields(spec);
    if !missing.is_empty() {
        return Err(format!("Fastener: missing {}", missing.join(", ")));
    }
    let problems = sanity(spec);
    if !problems.is_empty() {
        return Err(format!("Fastener: {}", problems.join("; ")));
    }
    let scale = if spec["units"] == "in" { INCH } else { 1.0 };
    let kind = spec["kind"].as_str().unwrap_or("");
    let mut out = Map::new();
    out.insert("kind".into(), spec["kind"].clone());
    out.insert("name".into(), spec["name"].clone());
    if positive(spec.get("length")) {
        out.insert("length".into(), Value::from(spec["length"].as_f64().unwrap_or(0.0) * scale));
    }
    for part in strs(fields()["kinds"][kind].get("parts")) {
        out.insert(part.clone(), to_mm(&spec[&part], scale));
    }
    if let Some(Value::Object(thread)) = out.get_mut("thread") {
        let hand = thread.get("hand").filter(|h| crate::truthy(h)).cloned();
        thread.insert("hand".into(), hand.unwrap_or_else(|| Value::from("right")));
        let modelled = thread.get("modelled").is_some_and(crate::truthy);
        thread.insert("modelled".into(), Value::Bool(modelled));
    }
    Ok(Value::Object(out))
}
