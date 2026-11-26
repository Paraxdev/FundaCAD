//! The numeric rows of a feature and the rules their values follow, as src/document/numFields.ts.

use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Length,
    Angle,
    /// Unitless, a real-valued ratio as well as a whole count (`INT_FIELDS` tells them apart).
    Count,
}

impl Kind {
    pub fn unit(self) -> &'static str {
        match self {
            Kind::Length => "mm",
            Kind::Angle => "°",
            Kind::Count => "",
        }
    }
}

use Kind::{Angle as A, Count as C, Length as L};

type Fields = &'static [(&'static str, &'static str, Kind)];

const MOVE: Fields = &[
    ("dx", "Move X", L),
    ("dy", "Move Y", L),
    ("dz", "Move Z", L),
    ("rx", "Rotate X", A),
    ("ry", "Rotate Y", A),
    ("rz", "Rotate Z", A),
];

/// `FEATURE_NUM_FIELDS`: the application's own feature types, a plugin's fields are whatever its code reads.
fn table(ty: &str) -> Option<Fields> {
    Some(match ty {
        "extrude" => &[
            ("distance", "Distance", L),
            ("taper", "Taper", A),
            ("startOffset", "Start offset", L),
            ("endOffset", "End offset", L),
            ("distance2", "Distance 2", L),
            ("taper2", "Taper 2", A),
            ("endOffset2", "End offset 2", L),
            ("thickness", "Thickness", L),
            ("thickness2", "Thickness 2", L),
        ],
        "fillet" => &[("radius", "Radius", L), ("profile", "Profile", C)],
        "chamfer" => &[("distance", "Distance", L), ("distance2", "Distance 2", L)],
        "press-pull" => &[("distance", "Distance", L), ("taper", "Taper", A), ("upToOffset", "Up to offset", L)],
        "revolve" => &[("angle", "Angle", A), ("pitch", "Pitch", L)],
        "datumPlane" => &[
            ("offset", "Offset", L),
            ("tiltX", "Tilt X", A),
            ("tiltY", "Tilt Y", A),
            ("spin", "Spin", A),
            ("shiftX", "Shift X", L),
            ("shiftY", "Shift Y", L),
        ],
        "box" => &[("length", "Length", L), ("width", "Width", L), ("height", "Height", L)],
        "cylinder" => &[("radius", "Radius", L), ("height", "Height", L)],
        "cone" => &[("bottomRadius", "Bottom radius", L), ("topRadius", "Top radius", L), ("height", "Height", L)],
        "sphere" => &[("radius", "Radius", L)],
        "torus" => &[("majorRadius", "Ring radius", L), ("minorRadius", "Tube radius", L)],
        "shell" => &[("thickness", "Thickness", L)],
        "offsetFace" => &[("distance", "Distance", L)],
        "thicken" => &[("thickness", "Thickness", L)],
        "draft" => &[("angle", "Angle", A)],
        "thread" => &[
            ("pitch", "Pitch", L),
            ("starts", "Starts", C),
            ("offset", "Offset", L),
            ("length", "Length", L),
            ("clearance", "Print clearance", L),
        ],
        "textOnFace" => &[("height", "Height", L), ("depth", "Depth", L), ("angle", "Angle", A)],
        "hole" => &[
            ("diameter", "Diameter", L),
            ("depth", "Depth", L),
            ("cbDiameter", "Counterbore diameter", L),
            ("cbDepth", "Counterbore depth", L),
            ("csDiameter", "Countersink diameter", L),
            ("csAngle", "Countersink angle", A),
            ("leadIn", "Lead-in", L),
        ],
        "patternRect" => &[
            ("countX", "Count X", C),
            ("countY", "Count Y", C),
            ("spacingX", "Spacing X", L),
            ("spacingY", "Spacing Y", L),
        ],
        "patternLinear" => &[("count", "Count", C), ("spacing", "Spacing", L)],
        "patternCircular" => &[("count", "Count", C), ("angle", "Angle", A)],
        "simplifyMesh" => &[("tolerance", "Angle tol", A)],
        "cleanUp" => &[("tolerance", "Tolerance", L)],
        "scale" => &[("factor", "Factor", C), ("sx", "X factor", C), ("sy", "Y factor", C), ("sz", "Z factor", C)],
        "move" | "duplicate" => MOVE,
        "joint" => &[("offset", "Offset", L), ("angle", "Angle", A)],
        "mechanism" => &[("offset", "Drive offset", L), ("angle", "Drive angle", A)],
        _ => return None,
    })
}

/// Only on the datum plane forms that read them: `t` is a 0..1 fraction along the edge, `angle` the turn about it.
const DATUM_REF_FIELDS: Fields = &[("t", "Position", C), ("angle", "Angle", A)];

#[derive(Clone, Debug, PartialEq)]
pub struct NumField {
    /// A key of the feature, or a path through a list of id-carrying entries (`nodes.n3.sx`).
    pub key: String,
    pub label: String,
    pub kind: Kind,
}

impl NumField {
    fn new(key: impl Into<String>, label: impl Into<String>, kind: Kind) -> Self {
        Self { key: key.into(), label: label.into(), kind }
    }
}

/// `featureNumFields`. A type the app does not describe lists its raw numeric fields by name, so a plugin's values stay
/// editable and bound parameters keep resolving while the plugin is not running. A sketch's numbers are its entities'.
pub fn num_fields(ty: &str, values: &Map<String, Value>) -> Vec<NumField> {
    if ty == "sketch" {
        let kind = |angle: bool| if angle { Kind::Angle } else { Kind::Length };
        return crate::sketch::dims::feature_dims(values).into_iter().map(|d| NumField::new(d.key, d.label, kind(d.angle))).collect();
    }
    let spoken = |&(k, l, kind): &(&str, &str, Kind)| NumField::new(k, l, kind);
    let mut out: Vec<NumField> = match table(ty) {
        Some(own) => own.iter().map(spoken).collect(),
        None => raw_num_fields(values),
    };
    if ty == "datumPlane" {
        out.extend(DATUM_REF_FIELDS.iter().filter(|(k, ..)| values.contains_key(*k)).map(spoken));
    }
    // The build skips a feature while `activeWhen` is 0. Listed only when present, so "Remove condition" stays removed.
    if values.contains_key("activeWhen") {
        out.push(NumField::new("activeWhen", "Active when", C));
    }
    out
}

/// Ids, the type and geometry selections are skipped: a number box over one would corrupt the feature.
fn raw_num_fields(values: &Map<String, Value>) -> Vec<NumField> {
    let mut out = Vec::new();
    for (k, v) in values {
        if k == "id" || k == "type" || k == "activeWhen" {
            continue;
        }
        if v.is_number() {
            out.push(NumField::new(k, k, C));
        }
        let Some(list) = v.as_array().filter(|l| !l.is_empty()) else { continue };
        let entries: Option<Vec<(&str, &Map<String, Value>)>> =
            list.iter().map(|e| Some((e.get("id")?.as_str()?, e.as_object()?))).collect();
        for (id, e) in entries.into_iter().flatten() {
            for (ek, _) in e.iter().filter(|(ek, ev)| *ek != "id" && ev.is_number()) {
                out.push(NumField::new(format!("{k}.{id}.{ek}"), format!("{k} {id} {ek}"), C));
            }
        }
    }
    out
}

/// The holder of a path and the key in it. The segment after a list names an entry by `id`, so a path survives a
/// reorder.
fn holder<'a>(holder: &'a Map<String, Value>, parts: &[&str]) -> Option<&'a Map<String, Value>> {
    match parts {
        [] => None,
        [_] => Some(holder),
        [head, rest @ ..] => match holder.get(*head)? {
            Value::Array(list) => {
                let (id, rest) = rest.split_first()?;
                if rest.is_empty() {
                    return None;
                }
                let entry = list
                    .iter()
                    .filter_map(Value::as_object)
                    .find(|e| e.get("id").and_then(Value::as_str) == Some(id))?;
                self::holder(entry, rest)
            }
            Value::Object(m) => self::holder(m, rest),
            _ => None,
        },
    }
}

fn holder_mut<'a>(holder: &'a mut Map<String, Value>, parts: &[&str]) -> Option<&'a mut Map<String, Value>> {
    match parts {
        [] => None,
        [_] => Some(holder),
        [head, rest @ ..] => match holder.get_mut(*head)? {
            Value::Array(list) => {
                let (id, rest) = rest.split_first()?;
                if rest.is_empty() {
                    return None;
                }
                let entry = list
                    .iter_mut()
                    .filter_map(Value::as_object_mut)
                    .find(|e| e.get("id").and_then(Value::as_str) == Some(id))?;
                holder_mut(entry, rest)
            }
            Value::Object(m) => holder_mut(m, rest),
            _ => None,
        },
    }
}

pub fn read_field<'a>(root: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let parts: Vec<&str> = path.split('.').collect();
    holder(root, &parts)?.get(*parts.last()?)
}

/// Sets or, with None, removes the value at a path. False when the path leads nowhere.
pub fn write_field(root: &mut Map<String, Value>, path: &str, value: Option<Value>) -> bool {
    let parts: Vec<&str> = path.split('.').collect();
    let Some(key) = parts.last().map(|k| k.to_string()) else { return false };
    let Some(at) = holder_mut(root, &parts) else { return false };
    match value {
        Some(v) => at.insert(key, v),
        None => at.remove(&key),
    };
    true
}

/// The value a field means while it is left out: a fillet's profile is the plain Round, 0, and the Fillet tool leaves
/// it out.
pub fn absent_value(ty: &str, field: &str) -> Option<f64> {
    (ty == "fillet" && field == "profile").then_some(0.)
}

/// `INT_FIELDS`: whole-number fields and their minimum.
fn int_min(field: &str) -> Option<f64> {
    Some(match field {
        "sides" => 3.,
        "count" | "countX" | "countY" | "rings" | "starts" => 1.,
        "seed" => f64::NEG_INFINITY,
        _ => return None,
    })
}

/// A value a field can never take, refused before it reaches the document.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rule {
    /// A radius or a scale: only a value above zero means anything.
    pub positive: bool,
    pub at_least: Option<f64>,
    pub integer: bool,
}

pub fn value_rule(ty: &str, field: &str) -> Rule {
    let positive = matches!(
        (ty, field),
        ("fillet", "radius") | ("chamfer", "distance" | "distance2") | ("scale", "factor" | "sx" | "sy" | "sz")
    );
    let min = int_min(field);
    Rule { positive, integer: min.is_some(), at_least: min.filter(|m| m.is_finite()) }
}

/// Why a value is refused, in the words of `field.problem.*`.
pub fn value_problem(label: &str, rule: Rule, v: f64) -> Option<String> {
    if rule.integer && (v - v.round()).abs() > 1e-9 {
        return Some(format!("{label} must be a whole number"));
    }
    if rule.positive && !(v > 0.) {
        return Some(format!("{label} must be more than 0"));
    }
    match rule.at_least {
        Some(min) if v < min => Some(format!("{label} must be at least {min}")),
        _ => None,
    }
}

/// A whole-number field is written rounded and at least its minimum.
pub fn coerce(field: &str, v: f64) -> f64 {
    match int_min(field) {
        Some(min) => v.round().max(min),
        None => v,
    }
}
