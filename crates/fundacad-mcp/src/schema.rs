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

/// Text rather than JSON: a language model reads it, and the notes are what save it a failed build.
pub fn schema_text(kind: Option<&str>) -> String {
    if let Some(kind) = kind.filter(|k| !k.is_empty()) {
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
