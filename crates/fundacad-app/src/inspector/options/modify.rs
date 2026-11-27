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
        v if PLANES.iter().any(|(p, _)| *p == v) => Some(vec![("plane".into(), Some(json!(v))), ("planeId".into(), None)]),
        v => Some(vec![("planeId".into(), Some(json!(v))), ("plane".into(), None)]),
    }
}

pub fn is_copy(f: &Map<String, Value>) -> bool {
    text(f, "type") == Some("duplicate")
}

pub fn copy_patch(on: bool) -> Patch {
    vec![("type".into(), Some(json!(if on { "duplicate" } else { "move" })))]
}
