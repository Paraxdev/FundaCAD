//! Standard hole sizes and the dimensions a hole type and size default to, as src/features/holeStandards.ts, which
//! mirrors the engine's hole tables.

use serde_json::{Map, Value};

use super::options::Patch;

pub const HOLE_SIZES: [&str; 11] = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M16", "M20"];

/// ISO 273 clearance holes: close, normal, loose.
const CLEARANCE: [[f64; 3]; 11] = [
    [2.2, 2.4, 2.6],
    [2.7, 2.9, 3.1],
    [3.2, 3.4, 3.6],
    [4.3, 4.5, 4.8],
    [5.3, 5.5, 5.8],
    [6.4, 6.6, 7.0],
    [8.4, 9.0, 10.0],
    [10.5, 11.0, 12.0],
    [13.0, 13.5, 14.5],
    [17.0, 17.5, 18.5],
    [21.0, 22.0, 24.0],
];
/// Tap drill for the coarse pitch.
const TAP_DRILL: [f64; 11] = [1.6, 2.05, 2.5, 3.3, 4.2, 5.0, 6.8, 8.5, 10.2, 14.0, 17.5];
/// ISO 4762 socket head cap screw: counterbore diameter and depth.
const COUNTERBORE: [[f64; 2]; 11] = [
    [4.4, 2.4],
    [5.5, 2.9],
    [6.5, 3.4],
    [8.0, 4.4],
    [10.0, 5.4],
    [11.0, 6.4],
    [15.0, 8.6],
    [18.0, 10.6],
    [20.0, 12.6],
    [26.0, 16.6],
    [33.0, 20.6],
];
/// ISO 10642 90 degree countersunk head: countersink diameter at the face.
const COUNTERSINK: [f64; 11] = [4.4, 5.5, 6.9, 9.2, 11.5, 13.7, 18.3, 22.7, 27.2, 33.9, 40.6];
/// Brass heat-set inserts, bore diameter and depth, none past M5.
const INSERT: [Option<[f64; 2]>; 11] = [
    Some([3.2, 4.0]),
    Some([3.6, 5.0]),
    Some([4.0, 6.0]),
    Some([5.6, 9.0]),
    Some([6.4, 10.0]),
    None,
    None,
    None,
    None,
    None,
    None,
];
const INSERT_LEAD_IN: f64 = 0.5;
const FITS: [&str; 3] = ["close", "normal", "loose"];

/// Hole dimensions by field, in the order the standard defines them.
type Dims = Vec<(&'static str, f64)>;

fn get(d: &Dims, key: &str) -> Option<f64> {
    d.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

fn set(d: &mut Dims, key: &'static str, v: f64) {
    match d.iter_mut().find(|(k, _)| *k == key) {
        Some(slot) => slot.1 = v,
        None => d.push((key, v)),
    }
}

/// What the standard says for these choices. A dimension it does not define (an M8 insert, any custom hole) is absent.
fn standard_dims(hole_type: &str, standard: Option<&str>, size: Option<&str>, fit: Option<&str>) -> Dims {
    let mut out = Dims::new();
    let Some(i) = size.and_then(|s| HOLE_SIZES.iter().position(|h| *h == s)) else {
        if hole_type == "insert" {
            out.push(("leadIn", INSERT_LEAD_IN));
        }
        return out;
    };
    if hole_type == "insert" {
        if let Some([d, depth]) = INSERT[i] {
            out.extend([("diameter", d), ("depth", depth)]);
        }
        out.push(("leadIn", INSERT_LEAD_IN));
        return out;
    }
    match standard {
        Some("tap") => out.push(("diameter", TAP_DRILL[i])),
        None | Some("clearance") => {
            let at = FITS.iter().position(|f| *f == fit.unwrap_or("normal")).unwrap_or(0);
            out.push(("diameter", CLEARANCE[i][at]));
        }
        _ => {}
    }
    match hole_type {
        "counterbore" => out.extend([("cbDiameter", COUNTERBORE[i][0]), ("cbDepth", COUNTERBORE[i][1])]),
        "countersink" => out.extend([("csDiameter", COUNTERSINK[i]), ("csAngle", 90.)]),
        _ => {}
    }
    out
}

fn round2(v: f64) -> f64 {
    (v * 100.).round() / 100.
}

/// Stand-ins for a hole with no standard behind it, scaled off its diameter, so switching a custom hole to a
/// counterbore never leaves a row empty.
fn custom_dims(hole_type: &str, d: f64) -> Dims {
    match hole_type {
        "counterbore" => vec![("cbDiameter", round2(d * 1.9)), ("cbDepth", round2(d))],
        "countersink" => vec![("csDiameter", round2(d * 2.)), ("csAngle", 90.)],
        "insert" => vec![("leadIn", INSERT_LEAD_IN)],
        _ => vec![],
    }
}

/// A size, type or standard rewrites every dimension its standard defines, a fit only the diameter. A stand-in fills
/// only absent dimensions, and one a parameter drives (`bound`) is never touched.
pub fn choice_patch(f: &Map<String, Value>, field: &str, value: &Value, bound: impl Fn(&str) -> bool) -> Patch {
    let mut patch = Map::new();
    patch.insert(field.to_string(), value.clone());
    if !["holeType", "standard", "size", "fit", "extent"].contains(&field) {
        return into_patch(patch);
    }
    let mut next = f.clone();
    next.insert(field.to_string(), value.clone());
    let s = |m: &Map<String, Value>, k: &str| m.get(k).and_then(Value::as_str).map(str::to_string);
    let hole_type = s(&next, "holeType").unwrap_or_else(|| "simple".into());
    if hole_type == "insert" && s(&next, "extent").as_deref() == Some("through") {
        next.insert("extent".into(), "blind".into());
        patch.insert("extent".into(), "blind".into());
    }
    let standard = s(&next, "standard");
    let std = if hole_type == "insert" || standard.as_deref() != Some("custom") {
        standard_dims(&hole_type, standard.as_deref(), s(&next, "size").as_deref(), s(&next, "fit").as_deref())
    } else {
        Dims::new()
    };
    let d = get(&std, "diameter").or(next.get("diameter").and_then(Value::as_f64)).unwrap_or(3.);
    let overwrite: Vec<&str> = match field {
        "fit" => vec!["diameter"],
        "extent" => vec![],
        _ => std.iter().map(|(k, _)| *k).collect(),
    };
    let mut fill = custom_dims(&hole_type, d);
    if s(&next, "extent").as_deref() != Some("through") {
        set(&mut fill, "depth", get(&std, "depth").unwrap_or(round2(2. * d)));
    }
    for k in overwrite {
        if let Some(v) = get(&std, k).filter(|_| !bound(k)) {
            patch.insert(k.into(), crate::document::number(v));
        }
    }
    for (k, v) in fill {
        if !next.contains_key(k) && !patch.contains_key(k) && !bound(k) {
            patch.insert(k.into(), crate::document::number(v));
        }
    }
    into_patch(patch)
}

fn into_patch(m: Map<String, Value>) -> Patch {
    m.into_iter().map(|(k, v)| (k, Some(v))).collect()
}

/// Whether a hole row means anything given the hole's other fields.
pub fn field_applies(field: &str, v: &Map<String, Value>) -> bool {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let hole_type = s("holeType").unwrap_or("simple");
    let insert = hole_type == "insert";
    let blind = insert || s("extent") != Some("through");
    match field {
        "standard" | "extent" => !insert,
        "size" => insert || s("standard") != Some("custom"),
        "fit" => !insert && s("standard").unwrap_or("clearance") == "clearance",
        "depth" => blind,
        "drillPoint" => blind && !insert,
        "tapped" => !insert && s("standard") == Some("tap"),
        "cbDiameter" | "cbDepth" => hole_type == "counterbore",
        "csDiameter" | "csAngle" => hole_type == "countersink",
        "leadIn" => insert,
        _ => true,
    }
}
