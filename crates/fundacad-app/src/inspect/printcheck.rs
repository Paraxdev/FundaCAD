//! Printability, FundaCAD.PrintToolbox's panel: the `printability` reply as findings per body, each with its tint,
//! its face and how high above the bed it sits, and the settings the check takes.

use serde_json::{json, Map, Value};

use super::spell;
use crate::i18n::{t, tr};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub nozzle: f64,
    pub layer: f64,
    pub overhang: f64,
    pub min_gap: f64,
    pub max_bridge: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { nozzle: 0.4, layer: 0.2, overhang: 45.0, min_gap: 0.2, max_bridge: 10.0 }
    }
}

impl Settings {
    pub fn fields(&self, bodies: &[String]) -> Map<String, Value> {
        let v = json!({
            "nozzle": self.nozzle, "layer": self.layer, "overhang": self.overhang,
            "minGap": self.min_gap, "maxBridge": self.max_bridge, "bodies": bodies,
        });
        v.as_object().cloned().unwrap_or_default()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub body: String,
    pub face: u32,
    pub title: String,
    pub place: String,
    pub rgb: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    /// Per body in the reply's order: its name and its findings.
    pub bodies: Vec<(String, Vec<Finding>)>,
    /// "Name: why" for each body that is not a sound solid.
    pub faults: Vec<String>,
}

/// The kinds a check can find, with the words and the tint the legend gives them.
pub const KINDS: &[(&str, &str, u32)] = &[
    ("overhang", "tool.overhang", 0xe24a3b),
    ("wall", "inspect.finding.wall", 0xe2963b),
    ("floor", "inspect.finding.floor", 0xe2c23b),
    ("gap", "inspect.finding.gap", 0xa45ee2),
    ("fused", "inspect.finding.fused", 0xd25ec4),
    ("bridge", "inspect.finding.bridge", 0x3bb6e2),
    ("meshHole", "inspect.finding.meshHole", 0x8a8f98),
    ("flatTriangle", "inspect.finding.flatTriangle", 0x8a8f98),
];

fn num(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn finding(f: &Value, bed: f64, name_of: &dyn Fn(&str) -> String) -> Finding {
    let kind = text(f, "kind");
    let (label, rgb) = KINDS.iter().find(|k| k.0 == kind).map_or((kind.to_string(), 0x8a8f98), |k| (t(k.1), k.2));
    let size = match kind {
        "overhang" => Some(format!("{}°, {} mm²", spell(num(f, "value")), spell(num(f, "area")))),
        "wall" | "floor" | "gap" | "fused" | "bridge" => Some(format!("{} mm", spell(num(f, "value")))),
        _ => None,
    };
    let title = match size {
        Some(s) => format!("{label}, {s}"),
        None => label,
    };
    let face = num(f, "face") as u32;
    let other = f.get("other").filter(|o| o.is_object());
    let faces = match (other.and_then(|o| o.get("face")).and_then(Value::as_u64), other.map(|o| text(o, "body"))) {
        (Some(o), Some(b)) if !b.is_empty() && b != text(f, "body") => tr!("inspect.finding.facesOn", face = face.to_string(), other = o.to_string(), body = name_of(b)),
        (Some(o), _) => tr!("inspect.finding.faces", face = face.to_string(), other = o.to_string()),
        (None, _) => tr!("inspect.finding.face", face = face.to_string()),
    };
    let z = f.get("at").and_then(Value::as_array).and_then(|a| a.get(2)).and_then(Value::as_f64).unwrap_or(bed);
    let height = if kind == "overhang" { num(f, "low") } else { z - bed };
    let mut place = tr!("inspect.finding.place", faces = faces, height = spell(height));
    if !text(f, "note").is_empty() {
        place = format!("{place}. {}", text(f, "note"));
    }
    Finding { body: text(f, "body").into(), face, title, place, rgb }
}

pub fn read(reply: &Map<String, Value>) -> Report {
    let list = |k: &str| reply.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let bodies = list("bodies");
    let findings = list("findings");
    let name_of = |id: &str| {
        let b = bodies.iter().find(|b| text(b, "id") == id);
        b.map(|b| text(b, "name")).filter(|n| !n.is_empty()).unwrap_or(id).to_string()
    };
    let mut out = Report::default();
    for b in &bodies {
        let id = text(b, "id");
        let name = if text(b, "name").is_empty() { id } else { text(b, "name") };
        let bed = num(b, "bed");
        let mine: Vec<Finding> = findings.iter().filter(|f| text(f, "body") == id).map(|f| finding(f, bed, &name_of)).collect();
        if let Some(why) = b.get("fault").and_then(Value::as_str) {
            out.faults.push(format!("{name}: {why}"));
        }
        if !mine.is_empty() {
            out.bodies.push((name.to_string(), mine));
        }
    }
    out
}

pub fn summary(r: &Report) -> String {
    let n: usize = r.bodies.iter().map(|(_, f)| f.len()).sum::<usize>() + r.faults.len();
    tr!("inspect.print.summary", n = n)
}
