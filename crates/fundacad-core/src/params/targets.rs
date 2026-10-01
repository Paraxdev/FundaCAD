//! Writing evaluated parameters into the fields they drive, the Rust twin of
//! `fieldHolder`, `resolveTarget` and `writeTarget` in
//! `src/document/numFields.ts` for `{kind: "feature"}` targets.
//!
//! The app turns a bare parameter name in a numeric field into a number plus a
//! model parameter `dN = {expr, target}` the first time it opens a document,
//! so from then on the field only moves when something writes the parameter's
//! value back into it. A headless editor that skipped this would rebuild the
//! same pose whatever the parameter said.
//!
//! Only feature targets are written. A constraint, entity or pattern target
//! lives in a sketch that the app re-solves after the write; written here
//! without that solve, a dimension would change while its geometry stayed put,
//! and the app, finding the value already in place, would never re-solve it.
//!
//! The document is untyped JSON, as the MCP server holds it: a path may reach
//! into a plugin's feature, whose fields no schema here describes.

use serde_json::{Map, Value};

use super::eval::js_round;
use super::FieldKind;

use FieldKind::{Angle, Count, Length};

/// `FEATURE_NUM_FIELDS`: the numeric fields of each feature type the app owns.
/// tests/vectors/params.json holds the app's table, and both sides are checked
/// against it.
pub const FEATURE_NUM_FIELDS: &[(&str, &[(&str, FieldKind)])] = &[
    ("extrude", &[("distance", Length), ("taper", Angle)]),
    ("fillet", &[("radius", Length), ("profile", Count)]),
    ("chamfer", &[("distance", Length), ("distance2", Length)]),
    ("press-pull", &[("distance", Length), ("taper", Angle)]),
    ("revolve", &[("angle", Angle), ("pitch", Length)]),
    (
        "datumPlane",
        &[
            ("offset", Length),
            ("tiltX", Angle),
            ("tiltY", Angle),
            ("spin", Angle),
            ("shiftX", Length),
            ("shiftY", Length),
        ],
    ),
    (
        "box",
        &[("length", Length), ("width", Length), ("height", Length)],
    ),
    ("cylinder", &[("radius", Length), ("height", Length)]),
    (
        "cone",
        &[
            ("bottomRadius", Length),
            ("topRadius", Length),
            ("height", Length),
        ],
    ),
    ("sphere", &[("radius", Length)]),
    ("torus", &[("majorRadius", Length), ("minorRadius", Length)]),
    ("shell", &[("thickness", Length)]),
    ("offsetFace", &[("distance", Length)]),
    ("thicken", &[("thickness", Length)]),
    ("draft", &[("angle", Angle)]),
    (
        "hole",
        &[
            ("diameter", Length),
            ("depth", Length),
            ("cbDiameter", Length),
            ("cbDepth", Length),
            ("csDiameter", Length),
            ("csAngle", Angle),
            ("leadIn", Length),
        ],
    ),
    (
        "patternRect",
        &[
            ("countX", Count),
            ("countY", Count),
            ("spacingX", Length),
            ("spacingY", Length),
        ],
    ),
    ("patternLinear", &[("count", Count), ("spacing", Length)]),
    ("patternCircular", &[("count", Count), ("angle", Angle)]),
    ("simplifyMesh", &[("tolerance", Angle)]),
    ("cleanUp", &[("tolerance", Length)]),
    (
        "scale",
        &[
            ("factor", Count),
            ("sx", Count),
            ("sy", Count),
            ("sz", Count),
        ],
    ),
    (
        "move",
        &[
            ("dx", Length),
            ("dy", Length),
            ("dz", Length),
            ("rx", Angle),
            ("ry", Angle),
            ("rz", Angle),
        ],
    ),
    ("joint", &[("offset", Length), ("angle", Angle)]),
    (
        "duplicate",
        &[
            ("dx", Length),
            ("dy", Length),
            ("dz", Length),
            ("rx", Angle),
            ("ry", Angle),
            ("rz", Angle),
        ],
    ),
];

/// `COMMON_NUM_FIELDS`: rows any feature may carry, listed only on a feature
/// that has the field, so a removed condition is not written straight back.
pub const COMMON_NUM_FIELDS: &[(&str, FieldKind)] = &[("activeWhen", Count)];

/// `INT_FIELDS`: integer-only fields and their least legal value.
pub const INT_FIELDS: &[(&str, f64)] = &[
    ("sides", 3.0),
    ("count", 1.0),
    ("countX", 1.0),
    ("countY", 1.0),
    ("rings", 1.0),
    ("seed", f64::NEG_INFINITY),
];

/// `featureNumFields`: the field paths of a feature a parameter may drive. A
/// type the app does not describe lists its own numbers, as the app does for a
/// plugin that is not loaded, which is always the case here.
pub fn feature_num_fields(kind: &str, values: &Map<String, Value>) -> Vec<(String, FieldKind)> {
    let mut rows: Vec<(String, FieldKind)> =
        match FEATURE_NUM_FIELDS.iter().find(|(k, _)| *k == kind) {
            Some((_, own)) => own.iter().map(|(f, k)| ((*f).to_owned(), *k)).collect(),
            None => raw_num_fields(values),
        };
    for (field, k) in COMMON_NUM_FIELDS {
        if values.contains_key(*field) {
            rows.push(((*field).to_owned(), *k));
        }
    }
    rows
}

/// `rawNumFields`: every number on the feature, and every number in a list of
/// entries that carry string ids, by `list.<id>.field`.
fn raw_num_fields(values: &Map<String, Value>) -> Vec<(String, FieldKind)> {
    let mut out = Vec::new();
    for (k, v) in values {
        if k == "id" || k == "type" || COMMON_NUM_FIELDS.iter().any(|(f, _)| f == k) {
            continue;
        }
        if v.is_number() {
            out.push((k.clone(), Count));
        }
        let Some(list) = v.as_array() else { continue };
        if list.is_empty()
            || !list
                .iter()
                .all(|e| e.get("id").is_some_and(Value::is_string))
        {
            continue;
        }
        for e in list.iter().filter_map(Value::as_object) {
            let id = e["id"].as_str().unwrap_or_default();
            for (ek, ev) in e {
                if ek != "id" && ev.is_number() {
                    out.push((format!("{k}.{id}.{ek}"), Count));
                }
            }
        }
    }
    out
}

/// `fieldHolder`: the object a field path lands in and the key within it. A
/// segment after a list names the list's entry by its `id`, so `nodes.n3.sx`
/// stays the same node however the list is reordered.
pub fn field_holder<'a, 'p>(
    root: &'a Map<String, Value>,
    path: &'p str,
) -> Option<(&'a Map<String, Value>, &'p str)> {
    let parts: Vec<&str> = path.split('.').collect();
    let n = parts.len();
    let mut holder = root;
    let mut i = 0;
    while i + 1 < n {
        holder = match holder.get(parts[i])? {
            Value::Array(list) => {
                i += 1;
                let id = parts[i];
                list.iter()
                    .filter_map(Value::as_object)
                    .find(|e| e.get("id").and_then(Value::as_str) == Some(id))?
            }
            Value::Object(next) => next,
            _ => return None,
        };
        if i + 1 == n {
            return None;
        }
        i += 1;
    }
    Some((holder, parts[n - 1]))
}

/// `field_holder`, for writing.
pub fn field_holder_mut<'a, 'p>(
    root: &'a mut Map<String, Value>,
    path: &'p str,
) -> Option<(&'a mut Map<String, Value>, &'p str)> {
    let parts: Vec<&str> = path.split('.').collect();
    let n = parts.len();
    let mut holder = root;
    let mut i = 0;
    while i + 1 < n {
        holder = match holder.get_mut(parts[i])? {
            Value::Array(list) => {
                i += 1;
                let id = parts[i];
                list.iter_mut()
                    .filter_map(Value::as_object_mut)
                    .find(|e| e.get("id").and_then(Value::as_str) == Some(id))?
            }
            Value::Object(next) => next,
            _ => return None,
        };
        if i + 1 == n {
            return None;
        }
        i += 1;
    }
    Some((holder, parts[n - 1]))
}

/// `readField`: the value at a field path, see `field_holder`.
pub fn read_field<'a>(root: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let (holder, key) = field_holder(root, path)?;
    holder.get(key)
}

/// `resolveTarget` for `{kind: "feature", feature, field}`: the feature is
/// there, its type lists `field`, and the path lands. A parameter whose target
/// stops resolving has lost its dimension, and `recompute` drops it.
pub fn feature_target_resolves(features: &[Value], feature: &str, field: &str) -> bool {
    let Some(f) = features
        .iter()
        .find(|f| f.get("id").and_then(Value::as_str) == Some(feature))
        .and_then(Value::as_object)
    else {
        return false;
    };
    let kind = f.get("type").and_then(Value::as_str).unwrap_or_default();
    feature_num_fields(kind, f)
        .iter()
        .any(|(path, _)| path == field)
        && field_holder(f, field).is_some()
}

/// `coerceForField`: integer fields round (halves up, as `Math.round`) and
/// clamp to their least legal value.
pub fn coerce_for_field(field: &str, value: f64) -> f64 {
    match INT_FIELDS.iter().find(|(f, _)| *f == field) {
        Some((_, min)) => js_round(value).max(*min),
        None => value,
    }
}

/// `writeTarget` for `{kind: "feature", feature, field}`. False when the
/// target does not resolve, the value is not finite, or the field already
/// holds it.
pub fn write_feature_target(
    features: &mut [Value],
    feature: &str,
    field: &str,
    value: f64,
) -> bool {
    if !value.is_finite() || !feature_target_resolves(features, feature, field) {
        return false;
    }
    let Some(f) = features
        .iter_mut()
        .find(|f| f.get("id").and_then(Value::as_str) == Some(feature))
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let Some((holder, key)) = field_holder_mut(f, field) else {
        return false;
    };
    let v = coerce_for_field(key, value);
    if holder.get(key).and_then(Value::as_f64) == Some(v) {
        return false;
    }
    holder.insert(key.to_owned(), number(v));
    true
}

/// A whole number is written without a fraction, as the app's JSON is.
fn number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// Every `{kind: "feature"}` target in the document's `paramDefs` given its
/// parameter's cached `value`, in table order, as `recompute` does after it
/// evaluates the table.
pub fn write_targets(doc: &mut Map<String, Value>) {
    let writes: Vec<(String, String, f64)> = doc
        .get("paramDefs")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(_, d)| {
            let (feature, field) = feature_target(d)?;
            Some((
                feature.to_owned(),
                field.to_owned(),
                d.get("value")?.as_f64()?,
            ))
        })
        .collect();
    let Some(features) = doc.get_mut("features").and_then(Value::as_array_mut) else {
        return;
    };
    for (feature, field, value) in writes {
        write_feature_target(features, &feature, &field, value);
    }
}

/// The feature and field a parameter definition targets, when its target is a
/// `{kind: "feature"}` one.
pub fn feature_target(def: &Value) -> Option<(&str, &str)> {
    let t = def.get("target")?;
    if t.get("kind").and_then(Value::as_str) != Some("feature") {
        return None;
    }
    Some((t.get("feature")?.as_str()?, t.get("field")?.as_str()?))
}
