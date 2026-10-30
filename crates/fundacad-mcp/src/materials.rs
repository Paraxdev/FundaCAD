//! The render materials of the Render workspace, ported from src/document/materials.ts so the MCP repairs a
//! material exactly as the app reads it. tests/vectors/materials.json pins both sides to the same answers.

use std::collections::HashSet;

use serde_json::{json, Map, Number, Value};

/// src/document/materials.ts STARTER_LIBRARY, in normal form: what a document without a library offers.
pub const STARTER: &str = r##"[
{"id":"m-aluminium","name":"Aluminium","color":"#b8bcc0","metalness":0.9,"roughness":0.35},
{"id":"m-steel","name":"Steel","color":"#8f959b","metalness":0.95,"roughness":0.28},
{"id":"m-brass","name":"Brass","color":"#c9a227","metalness":0.9,"roughness":0.3},
{"id":"m-copper","name":"Copper","color":"#b06a3b","metalness":0.95,"roughness":0.25},
{"id":"m-gold","name":"Gold","color":"#d4af37","metalness":1,"roughness":0.22},
{"id":"m-chrome","name":"Chrome","color":"#e8ecf0","metalness":1,"roughness":0.03},
{"id":"m-titanium","name":"Titanium","color":"#9a9ea3","metalness":0.9,"roughness":0.42},
{"id":"m-carpaint","name":"Car paint, red","color":"#a51321","metalness":0.55,"roughness":0.38,"clearcoat":1},
{"id":"m-ceramic","name":"Ceramic, glazed","color":"#eceae4","metalness":0,"roughness":0.32,"clearcoat":1},
{"id":"m-plastic-white","name":"Plastic, white","color":"#e8e8e8","metalness":0.02,"roughness":0.6},
{"id":"m-plastic-black","name":"Plastic, black","color":"#232323","metalness":0.02,"roughness":0.5},
{"id":"m-rubber","name":"Rubber","color":"#1d1f22","metalness":0,"roughness":0.95},
{"id":"m-wood","name":"Wood","color":"#9a6b3f","metalness":0,"roughness":0.8},
{"id":"m-glass","name":"Glass","color":"#cfe4ee","metalness":0,"roughness":0.05,"opacity":0.25},
{"id":"m-glass-frosted","name":"Glass, frosted","color":"#e6eef2","metalness":0,"roughness":0.5,"opacity":0.3},
{"id":"m-glass-tinted","name":"Glass, tinted","color":"#d8efe6","metalness":0,"roughness":0.05,"opacity":0.2,
 "attenuationColor":"#2a8f6a","attenuationDistance":20},
{"id":"m-diamond","name":"Diamond","color":"#f4f8fb","metalness":0,"roughness":0,"opacity":0.1,"ior":2.42,"dispersion":5},
{"id":"m-acrylic","name":"Acrylic, clear","color":"#dfeaf0","metalness":0,"roughness":0.15,"opacity":0.45},
{"id":"m-emitter","name":"Indicator, lit","color":"#42e07a","metalness":0,"roughness":0.4,"emissive":0.8}
]"##;

pub fn starter() -> Vec<Value> {
    serde_json::from_str(STARTER).unwrap_or_default()
}

/// A finish field as normalizeMaterial reads it, in the order it writes them.
#[derive(Clone, Copy, Debug)]
pub enum Field {
    /// Clamped to `lo..=hi`, omitted when it equals `default` (never omitted when that is None).
    Num {
        key: &'static str,
        lo: f64,
        hi: f64,
        default: Option<f64>,
    },
    Hex(&'static str),
}

const fn num_field(key: &'static str, lo: f64, hi: f64, default: f64) -> Field {
    Field::Num { key, lo, hi, default: Some(default) }
}

pub const FIELDS: [Field; 17] = [
    num_field("metalness", 0.0, 1.0, 0.1),
    num_field("roughness", 0.0, 1.0, 0.55),
    num_field("opacity", 0.0, 1.0, 1.0),
    num_field("emissive", 0.0, 1.0, 0.0),
    num_field("clearcoat", 0.0, 1.0, 0.0),
    num_field("ior", 1.0, 2.5, 1.5),
    Field::Num { key: "thickness", lo: 0.0, hi: 200.0, default: None },
    Field::Hex("attenuationColor"),
    num_field("attenuationDistance", 0.0, 1000.0, 0.0),
    num_field("dispersion", 0.0, 10.0, 0.0),
    num_field("iridescence", 0.0, 1.0, 0.0),
    Field::Hex("specularColor"),
    num_field("sheen", 0.0, 1.0, 0.0),
    num_field("anisotropy", 0.0, 1.0, 0.0),
    num_field("flakes", 0.0, 1.0, 0.0),
    num_field("flakeSize", 0.01, 5.0, 0.1),
    num_field("scatterDistance", 0.0, 100.0, 0.0),
];

/// Every key normalizeMaterial reads; any other key in a stored material rides through untouched.
pub const KNOWN_KEYS: [&str; 25] = [
    "id",
    "name",
    "color",
    "colour",
    "hex",
    "metalness",
    "roughness",
    "opacity",
    "emissive",
    "clearcoat",
    "ior",
    "thickness",
    "attenuationColor",
    "attenuationDistance",
    "dispersion",
    "iridescence",
    "specularColor",
    "surface",
    "surfaceGraph",
    "sheen",
    "anisotropy",
    "flakes",
    "flakeSize",
    "scatterDistance",
    "castsLight",
];

pub const SURFACE_KINDS: [&str; 5] = ["noise", "scratches", "brushed", "voronoi", "wave"];

pub const NODE_TYPES: [&str; 11] =
    ["noise", "scratches", "brushed", "voronoi", "wave", "fresnel", "ramp", "colorramp", "mix", "math", "output"];

/// JavaScript's String.prototype.trim set, which differs from char::is_whitespace on U+0085 and U+FEFF.
fn js_space(c: char) -> bool {
    ('\u{2000}'..='\u{200a}').contains(&c)
        || "\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}".contains(c)
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// A whole number is written without a fraction, as JSON.stringify writes it.
pub fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        Value::from(x as i64)
    } else {
        Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

fn clamp(v: Option<&Value>, lo: f64, hi: f64) -> Option<f64> {
    v.and_then(Value::as_f64).map(|x| x.max(lo).min(hi))
}

/// "#rrggbb" in lower case; three digit hex is expanded.
pub fn as_hex(raw: &Value) -> Option<String> {
    let t = js_trim(raw.as_str()?);
    let digits = t.strip_prefix('#').unwrap_or(t);
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match digits.len() {
        3 => Some(format!("#{}", digits.chars().flat_map(|c| [c, c]).collect::<String>().to_ascii_lowercase())),
        6 => Some(format!("#{}", digits.to_ascii_lowercase())),
        _ => None,
    }
}

/// None without a usable colour. Everything else is repaired: clamped, name from id, id from name, and a field at
/// its default omitted, so a library read back is byte identical.
pub fn normalize_material(raw: &Value, index: usize) -> Option<Map<String, Value>> {
    let r = raw.as_object()?;
    let given = |k: &str| r.get(k).filter(|v| !v.is_null());
    let color = as_hex(given("color").or_else(|| given("colour")).or_else(|| given("hex"))?)?;
    let text = |k: &str| r.get(k).and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty());
    let name = text("name").unwrap_or_default();
    let id = match text("id") {
        Some(id) => id.to_string(),
        None if name.is_empty() => slug_id(&format!("material {}", index + 1)),
        None => slug_id(name),
    };
    let mut out = Map::new();
    out.insert("id".into(), Value::from(id.as_str()));
    out.insert("name".into(), Value::from(if name.is_empty() { id.as_str() } else { name }));
    out.insert("color".into(), Value::from(color));
    for field in FIELDS {
        match field {
            Field::Num { key, lo, hi, default } => {
                if let Some(v) = clamp(r.get(key), lo, hi).filter(|v| Some(*v) != default) {
                    out.insert(key.into(), num(v));
                }
            }
            Field::Hex(key) => {
                if let Some(hex) = r.get(key).and_then(as_hex) {
                    out.insert(key.into(), Value::from(hex));
                }
            }
        }
    }
    if r.get("castsLight") == Some(&Value::Bool(false)) {
        out.insert("castsLight".into(), Value::Bool(false));
    }
    if let Some(surface) = r.get("surface").and_then(normalize_surface) {
        out.insert("surface".into(), surface);
    }
    if let Some(graph) = r.get("surfaceGraph").and_then(normalize_graph) {
        out.insert("surfaceGraph".into(), graph);
    }
    for (key, v) in r {
        if !KNOWN_KEYS.contains(&key.as_str()) && key != "__proto__" {
            out.insert(key.clone(), v.clone());
        }
    }
    Some(out)
}

/// A bad kind or a scale that is not above zero drops the surface, so the material reads back plain.
pub fn normalize_surface(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    let kind = r.get("kind").and_then(Value::as_str).filter(|k| SURFACE_KINDS.contains(k))?;
    let scale = r.get("scale").and_then(Value::as_f64).filter(|s| *s > 0.0)?;
    let amount = clamp(r.get("amount"), 0.0, 1.0)?;
    let mut out = Map::new();
    out.insert("kind".into(), Value::from(kind));
    out.insert("scale".into(), num(scale));
    out.insert("amount".into(), num(amount));
    if let Some(angle) = r.get("angle").and_then(Value::as_f64) {
        out.insert("angle".into(), num(angle));
    }
    if let Some(bump) = clamp(r.get("bump"), 0.0, 1.0).filter(|b| *b > 0.0) {
        out.insert("bump".into(), num(bump));
    }
    let tint = r.get("color").and_then(as_hex);
    if let (Some(color), Some(amount)) = (tint, clamp(r.get("colorAmount"), 0.0, 1.0).filter(|a| *a > 0.0)) {
        out.insert("color".into(), Value::from(color));
        out.insert("colorAmount".into(), num(amount));
    }
    Some(Value::Object(out))
}

/// Structural only, like the app: a node without an id or with an unknown type is dropped, and the graph is dropped
/// when its output node is gone. Params and wires ride through as given.
pub fn normalize_graph(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    let list = r.get("nodes")?.as_array()?;
    let output = r.get("output")?.as_str()?;
    let mut nodes = vec![];
    for n in list {
        let Some(o) = n.as_object() else { continue };
        let Some(kind) = o.get("type").and_then(Value::as_str).filter(|t| NODE_TYPES.contains(t)) else { continue };
        let Some(id) = o.get("id").and_then(Value::as_str) else { continue };
        let mut node = Map::new();
        node.insert("id".into(), Value::from(id));
        node.insert("type".into(), Value::from(kind));
        for key in ["params", "in"] {
            if let Some(v) = o.get(key).filter(|v| v.is_object() || v.is_array()) {
                node.insert(key.into(), v.clone());
            }
        }
        for key in ["x", "y"] {
            if let Some(v) = o.get(key).and_then(Value::as_f64) {
                node.insert(key.into(), num(v));
            }
        }
        nodes.push(Value::Object(node));
    }
    if !nodes.iter().any(|n| n["id"] == output) {
        return None;
    }
    Some(json!({ "nodes": nodes, "output": output }))
}

/// Safe in a file name, a URL and a JSON key.
pub fn slug_id(name: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    if slug.is_empty() {
        "m-material".into()
    } else {
        format!("m-{slug}")
    }
}

pub fn unique_id(id: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(id) {
        return id.to_string();
    }
    (2..).map(|n| format!("{id}-{n}")).find(|next| !taken.contains(next)).unwrap_or_default()
}

/// The first of `base`, "`base` 2", ... that no name in `names` matches, ignoring case.
pub fn fresh_name<'a>(names: impl IntoIterator<Item = &'a str>, base: &str) -> String {
    let taken: HashSet<String> = names.into_iter().map(str::to_lowercase).collect();
    if !taken.contains(&base.to_lowercase()) {
        return base.to_string();
    }
    (2..).map(|n| format!("{base} {n}")).find(|name| !taken.contains(&name.to_lowercase())).unwrap_or_default()
}
