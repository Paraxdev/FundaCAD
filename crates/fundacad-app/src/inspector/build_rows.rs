//! The revolve's Axis row and the sweep's Path row, which list what the document holds above the feature.

#[cfg(test)]
mod tests;

use serde_json::{json, Map, Value};

use super::options::{Choice, Patch};

type Feature = Map<String, Value>;

pub const PLACED: &str = "placed";
pub const SKETCH: &str = "sketch";

fn text<'a>(f: &'a Feature, key: &str) -> Option<&'a str> {
    f.get(key).and_then(Value::as_str)
}

fn choice(value: impl Into<String>, label: impl Into<String>) -> Choice {
    Choice { value: value.into(), label: label.into() }
}

fn above<'a>(all: &'a [&'a Feature], f: &Feature) -> &'a [&'a Feature] {
    let id = text(f, "id");
    all.iter().position(|x| text(x, "id") == id).map_or(all, |at| &all[..at])
}

fn named(f: &Feature) -> String {
    let name = text(f, "name").map(str::trim).filter(|n| !n.is_empty());
    name.or(text(f, "id")).unwrap_or_default().to_string()
}

fn datum_axes<'a>(all: &'a [&'a Feature], f: &Feature) -> impl Iterator<Item = &'a Feature> {
    above(all, f).iter().copied().filter(|x| text(x, "type") == Some("datumAxis"))
}

fn line_of(d: &Feature) -> Value {
    json!({"origin": d.get("origin"), "dir": d.get("dir")})
}

/// X, Y and Z, the sketch's own axis, the datum axes above, and a picked edge or another line as they are.
pub fn revolve_axis_choice(doc: &Feature, f: &Feature, all: &[&Feature]) -> (Vec<Choice>, String) {
    let mut options: Vec<Choice> = ["X", "Y", "Z"].iter().map(|a| choice(*a, *a)).collect();
    let sketch = text(f, "sketch").and_then(|k| crate::tools::build::sketch_axis(doc, k));
    if sketch.is_some() {
        options.push(choice(SKETCH, "Sketch"));
    }
    options.extend(datum_axes(all, f).map(|d| choice(text(d, "id").unwrap_or_default(), named(d))));
    let edge = f.get("axisEdge").is_some_and(|e| !e.is_null());
    let current = match f.get("axis") {
        _ if edge => None,
        Some(Value::String(a)) => Some(a.clone()),
        None | Some(Value::Null) => Some("Z".into()),
        Some(line) if Some(line) == sketch.as_ref() => Some(SKETCH.into()),
        Some(line) => datum_axes(all, f).find(|d| line_of(d) == *line).and_then(|d| text(d, "id")).map(str::to_string),
    };
    let current = current.unwrap_or_else(|| {
        options.push(choice(PLACED, if edge { "Edge" } else { "Line" }));
        PLACED.into()
    });
    if !options.iter().any(|o| o.value == current) {
        options.push(choice(current.clone(), current.clone()));
    }
    (options, current)
}

/// Any axis but the picked edge drops it, so the engine does not keep turning about the edge.
pub fn revolve_axis_patch(doc: &Feature, f: &Feature, all: &[&Feature], value: &str) -> Option<Patch> {
    let axis = match value {
        PLACED => return None,
        "X" | "Y" | "Z" => json!(value),
        SKETCH => crate::tools::build::sketch_axis(doc, text(f, "sketch")?)?,
        id => line_of(datum_axes(all, f).find(|d| text(d, "id") == Some(id))?),
    };
    Some(vec![("axis".into(), Some(axis)), ("axisEdge".into(), None)])
}

/// The sketches above the sweep other than its profile.
pub fn sweep_path_choice(f: &Feature, all: &[&Feature]) -> (Vec<Choice>, String) {
    let profile = text(f, "profile");
    let mut options: Vec<Choice> = above(all, f)
        .iter()
        .filter(|x| text(x, "type") == Some("sketch") && text(x, "id") != profile)
        .map(|x| choice(text(x, "id").unwrap_or_default(), named(x)))
        .collect();
    let current = text(f, "path").unwrap_or_default().to_string();
    if current.is_empty() {
        options.insert(0, choice("", "None"));
    } else if !options.iter().any(|o| o.value == current) {
        options.push(choice(current.clone(), format!("{current} (missing)")));
    }
    (options, current)
}
