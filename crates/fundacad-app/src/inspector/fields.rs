//! The numeric rows of a feature and the rules their values follow, as src/document/numFields.ts.

use serde_json::{Map, Value};

use crate::i18n::{t, tr};

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
    ("dx", "field.moveX", L),
    ("dy", "field.moveY", L),
    ("dz", "field.moveZ", L),
    ("rx", "field.rotateX", A),
    ("ry", "field.rotateY", A),
    ("rz", "field.rotateZ", A),
];

/// `FEATURE_NUM_FIELDS`: the application's own feature types, a plugin's fields are whatever its code reads.
fn table(ty: &str) -> Option<Fields> {
    Some(match ty {
        "extrude" => &[
            ("distance", "field.distance", L),
            ("taper", "field.taper", A),
            ("startOffset", "field.startOffset", L),
            ("endOffset", "field.endOffset", L),
            ("distance2", "field.distance2", L),
            ("taper2", "field.taper2", A),
            ("endOffset2", "field.endOffset2", L),
            ("thickness", "field.thickness", L),
            ("thickness2", "field.thickness2", L),
        ],
        "fillet" => &[("radius", "field.radius", L), ("profile", "field.profile", C)],
        "chamfer" => &[("distance", "field.distance", L), ("distance2", "field.distance2", L)],
        "press-pull" => {
            &[("distance", "field.distance", L), ("taper", "field.taper", A), ("upToOffset", "field.upToOffset", L)]
        }
        "revolve" => &[("angle", "field.angle", A), ("pitch", "field.pitch", L)],
        "datumPlane" => &[
            ("offset", "field.offset", L),
            ("tiltX", "field.tiltX", A),
            ("tiltY", "field.tiltY", A),
            ("spin", "field.spin", A),
            ("shiftX", "field.shiftX", L),
            ("shiftY", "field.shiftY", L),
        ],
        "box" => &[("length", "field.length", L), ("width", "field.width", L), ("height", "field.height", L)],
        "cylinder" => &[("radius", "field.radius", L), ("height", "field.height", L)],
        "cone" => &[
            ("bottomRadius", "field.bottomRadius", L),
            ("topRadius", "field.topRadius", L),
            ("height", "field.height", L),
        ],
        "sphere" => &[("radius", "field.radius", L)],
        "torus" => &[("majorRadius", "field.ringRadius", L), ("minorRadius", "field.tubeRadius", L)],
        "shell" => &[("thickness", "field.thickness", L)],
        "offsetFace" => &[("distance", "field.distance", L)],
        "thicken" => &[("thickness", "field.thickness", L)],
        "draft" => &[("angle", "field.angle", A)],
        "thread" => &[
            ("pitch", "field.pitch", L),
            ("starts", "field.starts", C),
            ("offset", "field.offset", L),
            ("length", "field.length", L),
            ("clearance", "field.printClearance", L),
        ],
        "textOnFace" => &[("height", "field.height", L), ("depth", "field.depth", L), ("angle", "field.angle", A)],
        "hole" => &[
            ("diameter", "field.diameter", L),
            ("depth", "field.depth", L),
            ("cbDiameter", "field.counterboreDiameter", L),
            ("cbDepth", "field.counterboreDepth", L),
            ("csDiameter", "field.countersinkDiameter", L),
            ("csAngle", "field.countersinkAngle", A),
            ("leadIn", "field.leadIn", L),
        ],
        "patternRect" => &[
            ("countX", "field.countX", C),
            ("countY", "field.countY", C),
            ("spacingX", "field.spacingX", L),
            ("spacingY", "field.spacingY", L),
        ],
        "patternLinear" => &[("count", "field.count", C), ("spacing", "field.spacing", L)],
        "patternCircular" => &[("count", "field.count", C), ("angle", "field.angle", A)],
        "simplifyMesh" => &[("tolerance", "field.angleTol", A)],
        "cleanUp" => &[("tolerance", "field.tolerance", L)],
        "scale" => &[
            ("factor", "field.factor", C),
            ("sx", "field.xFactor", C),
            ("sy", "field.yFactor", C),
            ("sz", "field.zFactor", C),
        ],
        "move" | "duplicate" => MOVE,
        "joint" => &[("offset", "field.offset", L), ("angle", "field.angle", A)],
        "mechanism" => &[("offset", "field.driveOffset", L), ("angle", "field.driveAngle", A)],
        _ => return None,
    })
}

/// Only on the datum plane forms that read them: `t` is a 0..1 fraction along the edge, `angle` the turn about it.
const DATUM_REF_FIELDS: Fields = &[("t", "field.position", C), ("angle", "field.angle", A)];

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
        return crate::sketch::dims::feature_dims(values)
            .into_iter()
            .map(|d| NumField::new(d.key, d.label, kind(d.angle)))
            .collect();
    }
    let spoken = |&(k, key, kind): &(&str, &str, Kind)| NumField::new(k, t(key), kind);
    let mut out: Vec<NumField> = match table(ty) {
        Some(own) => own.iter().map(spoken).collect(),
        None => raw_num_fields(values),
    };
    if ty == "datumPlane" {
        out.extend(DATUM_REF_FIELDS.iter().filter(|(k, ..)| values.contains_key(*k)).map(spoken));
    }
    // The build skips a feature while `activeWhen` is 0. Listed only when present, so "Remove condition" stays removed.
    if values.contains_key("activeWhen") {
        out.push(NumField::new("activeWhen", t("field.activeWhen"), C));
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
        return Some(tr!("field.problem.whole", label = label));
    }
    if rule.positive && !(v > 0.) {
        return Some(tr!("field.problem.positive", label = label));
    }
    match rule.at_least {
        Some(min) if v < min => Some(tr!("field.problem.atLeast", label = label, min = min)),
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
