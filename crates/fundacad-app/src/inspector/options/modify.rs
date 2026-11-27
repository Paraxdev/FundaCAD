//! The rows the Modify tools add: a split's side to keep and its plane, and Move's Copy switch, which makes it a
//! duplicate.

#[cfg(test)]
mod tests;

use serde_json::{json, Map, Value};

use super::{above, choice, of_type, owned, text, toggle, Choice, ChoiceField, Opt, Patch, ToggleField, PICKED_POINT, PLANES};

const KEEP: &[Opt] = &[("both", "tool.split.both"), ("top", "tool.split.top"), ("bottom", "tool.split.bottom")];

pub const SPLIT: &[ChoiceField] = &[choice("keep", "field.keep", KEEP, "both"), choice("plane", "field.plane", PLANES, "XY")];
pub const COPY: &[ToggleField] = &[toggle("copy", "field.copy", false)];

/// The world planes and the datum planes above the split, with its planeId over its plane, a picked face as such.
pub fn split_plane_choice(f: &Map<String, Value>, features: &[&Map<String, Value>]) -> (Vec<Choice>, String) {
    let earlier = above(features, text(f, "id").unwrap_or_default());
    let mut options: Vec<Choice> = owned(PLANES).into_iter().chain(of_type(earlier, "datumPlane")).collect();
    let current = match (text(f, "planeId").filter(|s| !s.is_empty()), f.get("plane")) {
        (Some(id), _) => id.to_string(),
        (None, Some(Value::String(name))) => name.clone(),
        (None, Some(Value::Object(_))) => {
            options.push(Choice::new(PICKED_POINT, crate::i18n::t("field.option.pickedFace")));
            return (options, PICKED_POINT.into());
        }
        _ => "XY".into(),
    };
    if !options.iter().any(|o| o.value == current) {
        options.push(Choice::new(current.clone(), crate::i18n::tr!("field.option.missing", name = &current)));
    }
    (options, current)
}

/// A world plane is the plane itself, a datum plane goes by id so the cut follows it.
pub fn split_plane_patch(value: &str) -> Option<Patch> {
    match value {
        "" | PICKED_POINT => None,
        v if PLANES.iter().any(|(p, _)| *p == v) => {
            Some(vec![("plane".into(), Some(json!(v))), ("planeId".into(), None), ("offset".into(), None)])
        }
        v => Some(vec![("planeId".into(), Some(json!(v))), ("plane".into(), None), ("offset".into(), None)]),
    }
}

/// A split's offset follows its datum plane's own, so only a world plane or a picked face takes one.
pub fn split_takes_offset(f: &Map<String, Value>) -> bool {
    text(f, "planeId").is_none_or(str::is_empty)
}

fn world_plane(name: &str) -> Option<([f64; 3], [f64; 3])> {
    Some(match name {
        "XY" => ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        "XZ" => ([1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
        "YZ" => ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        _ => return None,
    })
}

fn vec3(v: Option<&Value>) -> Option<[f64; 3]> {
    let a = v?.as_array()?;
    Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
}

/// As FundaCAD 1's offset gizmo, the engine only reads where the plane is, so the offset moves the plane's origin
/// along its normal and a world plane becomes a placed one. False when the plane cannot be read.
pub fn shift_split_plane(f: &mut Map<String, Value>, by: f64) -> bool {
    let (origin, xdir, normal) = match f.get("plane") {
        None => ([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        Some(Value::String(name)) => match world_plane(name) {
            Some((x, n)) => ([0.0; 3], x, n),
            None => return false,
        },
        Some(Value::Object(d)) => match (vec3(d.get("origin")), vec3(d.get("xdir")), vec3(d.get("normal"))) {
            (Some(o), Some(x), Some(n)) => (o, x, n),
            _ => return false,
        },
        Some(_) => return false,
    };
    let len = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
    if len == 0.0 {
        return false;
    }
    let round = |v: f64| (v * 1e6).round() / 1e6;
    let moved: Vec<f64> = (0..3).map(|i| round(origin[i] + normal[i] / len * by)).collect();
    f.insert("plane".into(), json!({"origin": moved, "normal": normal, "xdir": xdir}));
    true
}

pub fn is_copy(f: &Map<String, Value>) -> bool {
    text(f, "type") == Some("duplicate")
}

pub fn copy_patch(on: bool) -> Patch {
    vec![("type".into(), Some(json!(if on { "duplicate" } else { "move" })))]
}
