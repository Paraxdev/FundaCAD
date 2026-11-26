//! What an import asks and the features its reply adds.

use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// The units glTF, VRML and X3D files may be in. The specs say metres but writers rarely mean it, so each import
/// asks and the last answer is the next default.
pub const IMPORT_UNITS: [&str; 4] = ["mm", "cm", "m", "inch"];
pub const SPEC_UNIT: &str = "m";

pub fn asks_for_unit(format: &str) -> bool {
    matches!(format, "glb" | "gltf" | "vrml" | "x3d")
}

pub fn as_import_unit(v: &str) -> Option<&'static str> {
    IMPORT_UNITS.iter().find(|u| **u == v).copied()
}

/// The unit choices with the last one used first.
pub fn unit_choices(last: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = IMPORT_UNITS.iter().filter(|u| **u == last).copied().collect();
    out.extend(IMPORT_UNITS.iter().filter(|u| **u != last));
    out
}

/// The fields of an `import` request. `unit` only for a format that [`asks_for_unit`].
pub fn import_fields(path: &str, format: &str, unit: Option<&str>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("path".into(), json!(path));
    m.insert("format".into(), json!(format));
    if let Some(u) = unit.filter(|_| asks_for_unit(format)) {
        m.insert("unit".into(), json!(u));
    }
    m
}

/// `count` ids of the `f<n>` form that `taken` does not hold, the series the document's next id walks, for
/// features added together before any of them exists.
pub fn free_ids<'a>(taken: impl IntoIterator<Item = &'a str>, count: usize) -> Vec<String> {
    let mut ids: HashSet<String> = taken.into_iter().map(str::to_owned).collect();
    let mut out = Vec::with_capacity(count);
    let mut n = ids.len() + 1;
    while out.len() < count {
        while ids.contains(&format!("f{n}")) {
            n += 1;
        }
        let id = format!("f{n}");
        ids.insert(id.clone());
        out.push(id);
    }
    out
}

/// The ids a document's features hold.
pub fn feature_ids(doc: &Map<String, Value>) -> Vec<&str> {
    doc.get("features")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| f.get("id").and_then(Value::as_str))
        .collect()
}

/// The features an import reply adds: a plain sketch on XY for every layer of a drawing (DXF, SVG), then the
/// `import` feature when the file had 3D geometry.
pub fn import_features(reply: &Map<String, Value>, format: &str, source: &str, taken: &[&str]) -> Vec<Value> {
    let sketches = reply.get("sketches").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let geom = reply.get("geom");
    let mut ids = free_ids(taken.iter().copied(), sketches.len() + usize::from(geom.is_some())).into_iter();
    let mut out: Vec<Value> = sketches
        .iter()
        .map(|s| {
            let mut f = Map::new();
            f.insert("id".into(), json!(ids.next()));
            f.insert("type".into(), json!("sketch"));
            f.insert("plane".into(), json!("XY"));
            f.insert("name".into(), s.get("name").cloned().unwrap_or(Value::Null));
            f.insert("entities".into(), s.get("entities").cloned().unwrap_or(json!([])));
            if let Some(r) = s.get("fillRule") {
                f.insert("fillRule".into(), r.clone());
            }
            Value::Object(f)
        })
        .collect();
    if let Some(geom) = geom {
        let mut f = Map::new();
        f.insert("id".into(), json!(ids.next()));
        f.insert("type".into(), json!("import"));
        f.insert("format".into(), json!(format));
        f.insert("name".into(), reply.get("name").cloned().unwrap_or(Value::Null));
        f.insert("geom".into(), geom.clone());
        f.insert("source".into(), json!(source));
        f.insert("solid".into(), reply.get("solid").cloned().unwrap_or(json!(true)));
        // Copied only when present, so an import without them is the feature it always was.
        for k in ["color", "nodes", "parts", "notes", "unit"] {
            if let Some(v) = reply.get(k) {
                f.insert(k.into(), v.clone());
            }
        }
        if reply.get("scan").and_then(Value::as_bool) == Some(true) {
            f.insert("scan".into(), json!(true));
        }
        out.push(Value::Object(f));
    }
    out
}
