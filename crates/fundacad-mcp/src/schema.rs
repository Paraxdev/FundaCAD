//! The feature reference an agent reads before it authors JSON, served as an MCP resource and by `schema`.
//! The entries in `schema.json` are the Python server's tables verbatim; `tests/schema.rs` holds them to the core.

use std::sync::OnceLock;

use serde_json::Value;

const SOURCE: &str = include_str!("schema.json");

fn tables() -> &'static Value {
    static TABLES: OnceLock<Value> = OnceLock::new();
    TABLES.get_or_init(|| serde_json::from_str(SOURCE).expect("schema.json is this crate's own"))
}

fn table(key: &str) -> &'static serde_json::Map<String, Value> {
    static EMPTY: OnceLock<serde_json::Map<String, Value>> = OnceLock::new();
    tables().get(key).and_then(Value::as_object).unwrap_or_else(|| EMPTY.get_or_init(serde_json::Map::new))
}

/// type -> {summary, fields, example, notes}. `fields` is ordered and the
/// required ones come first, because that is the order somebody writes them in.
pub fn features() -> &'static serde_json::Map<String, Value> {
    table("features")
}

/// Shared vocabulary, quoted once and referenced from the entries.
pub fn common() -> &'static serde_json::Map<String, Value> {
    table("common")
}

pub fn sketch_entities() -> &'static serde_json::Map<String, Value> {
    table("sketchEntities")
}

pub fn sketch_notes() -> &'static str {
    tables().get("sketchNotes").and_then(Value::as_str).unwrap_or_default()
}

/// The working order the host puts in front of the model.
pub fn how_to() -> &'static str {
    tables().get("howTo").and_then(Value::as_str).unwrap_or_default()
}

pub fn describe_feature(kind: &str) -> Option<&'static Value> {
    features().get(kind)
}

fn text_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A field worded exactly as a shared entry keeps its first line and any line naming this type, and points to the
/// overview for the rest, so each type's reply does not repeat the shared notes in full.
pub fn field_text(kind: &str, field: &str, text: &str) -> String {
    if common().get(field).and_then(Value::as_str) != Some(text) || !text.contains('\n') {
        return text.to_string();
    }
    let names_kind = |line: &str| line.split(|c: char| !c.is_alphanumeric()).any(|w| w == kind);
    let mut lines = text.lines();
    let mut kept: Vec<&str> = lines.next().into_iter().collect();
    kept.extend(lines.filter(|l| names_kind(l)));
    format!("{} The rest of `{field}` is under Shared types in `schema` with no type.", kept.join("\n"))
}

/// What `material_set`'s tool entry leaves out, so every session does not pay for it on each tools/list.
const MATERIAL: &str = r##"## material
The finer fields of `material_set` and its surface patterns. Each takes null to go back to its default.

Fields:
  castsLight: false when a glowing part should not light its neighbours
  thickness: mm light travels through see-through material, left out is measured from the body
  attenuationColor: "#rrggbb" that light turns into inside see-through material, for tinted glass
  attenuationDistance: mm until light has fully taken that colour, 0 is never
  dispersion: 0 to 10, the rainbow fire of a cut gem, needs some thickness
  scatterDistance: mm until light inside has scattered, for frosted or milky material, 0 is clear
  iridescence: 0 to 1, thin film rainbow like an oil slick
  specularColor: "#rrggbb" tint of a non-metal's highlight, white when left out
  sheen: 0 to 1, soft rim at grazing angles, velvet or cloth
  anisotropy: 0 to 1, highlights stretched one way, brushed metal or print layer lines
  flakes: 0 to 1, glitter or metal flake density, as in metallic car paint
  flakeSize: mm per flake
  surface: a simple pattern, {kind: noise, scratches, brushed, voronoi or wave; scale: feature size in mm, above 0; amount: 0 to 1, how much it pushes roughness; angle: radians, the direction of scratches, brushed and wave; bump: 0 to 1, relief; color: "#rrggbb" tint; colorAmount: 0 to 1}
  surfaceGraph: a node graph as the node editor saves it, wins over `surface`, {nodes: [{id, type, params, in}], output: the output node's id}. `in` maps an input to the id of the node feeding it.

Node types:
  noise (params scale, detail, roughness, distortion), scratches, brushed, voronoi, wave (params scale, angle), fresnel (param power, rises at grazing angles) give a number.
  ramp (params colorA, colorB, input t), colorramp (param stops "0:#000000;1:#ffffff", input t) turn a number into a colour.
  mix (inputs a, b, t), math (inputs a, b, param op: add, subtract, multiply, min, max, pow) combine numbers.
  output (inputs roughness, bump, color; params roughAmount, bumpAmount, colorAmount, 0 to 1) is the one sink.

Example:
{"id": "m-worn", "name": "Worn", "color": "#808890", "surfaceGraph": {"nodes": [{"id": "n", "type": "noise", "params": {"scale": 2}}, {"id": "o", "type": "output", "params": {"roughAmount": 0.5}, "in": {"roughness": "n"}}], "output": "o"}}"##;

/// Text rather than JSON: a language model reads it, and the notes are what save it a failed build.
pub fn schema_text(kind: Option<&str>) -> String {
    if let Some(kind) = kind.filter(|k| !k.is_empty()) {
        if kind == "material" {
            return MATERIAL.to_string();
        }
        if let Some(e) = features().get(kind) {
            let mut out = vec![format!("## {kind}\n{}\n", text_of(e.get("summary"))), "Fields:".to_string()];
            for (k, v) in e.get("fields").and_then(Value::as_object).into_iter().flatten() {
                out.push(format!("  {k}: {}", field_text(kind, k, &text_of(Some(v)))));
            }
            if let Some(example) = e.get("example").filter(|v| !v.is_null()) {
                out.push(format!("\nExample:\n{}", serde_json::to_string_pretty(example).unwrap_or_default()));
            }
            let notes = text_of(e.get("notes"));
            if !notes.is_empty() {
                out.push(format!("\nNotes: {notes}"));
            }
            return out.join("\n");
        }
        let mut known: Vec<&String> = features().keys().collect();
        known.sort();
        return format!(
            "No feature type '{kind}'. Known types: {}",
            known.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", ")
        );
    }

    let mut out =
        vec!["# FundaCAD document schema\n".to_string(), how_to().to_string(), "\n## Shared types\n".to_string()];
    for (k, v) in common() {
        out.push(format!("{k}: {}\n", text_of(Some(v))));
    }
    out.push("\n## Feature types\n".into());
    let mut kinds: Vec<&String> = features().keys().collect();
    kinds.sort();
    for k in kinds {
        out.push(format!("- {k}: {}", text_of(features()[k].get("summary"))));
    }
    out.push("\nCall schema(type) for the fields, an example and the notes of one type.\n".into());
    out.push("\n## Sketch entities\n".into());
    for (k, v) in sketch_entities() {
        let fields: Vec<String> =
            v.as_object().into_iter().flatten().map(|(a, b)| format!("{a} ({})", text_of(Some(b)))).collect();
        out.push(format!("- {k}: {}", fields.join(", ")));
    }
    out.push(format!("\n{}", sketch_notes()));
    out.join("\n")
}
