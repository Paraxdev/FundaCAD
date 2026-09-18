//! The JSON Schema each tool advertises for its arguments.
//!
//! Written out rather than derived from a Rust struct, and for the reason the
//! Python server wrote them out: the descriptions ARE the tool. An agent that
//! has never clicked on anything decides what to send from these sentences, so
//! they are carried over word for word from the Python MCP server's `server.py`
//! and the shapes stay the ones a host already knows.

use rmcp::model::JsonObject;
use serde_json::{json, Value};

use crate::upload::IMPORT_FORMATS;

fn object(properties: Value, required: &[&str]) -> JsonObject {
    let mut schema = serde_json::Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), properties);
    schema.insert("required".into(), json!(required));
    schema
}

pub fn schema_tool() -> JsonObject {
    object(
        json!({"type": {"type": "string", "description": "a feature type, e.g. \"revolve\""}}),
        &[],
    )
}

pub fn doc_new() -> JsonObject {
    object(json!({}), &[])
}

pub fn doc_open() -> JsonObject {
    object(json!({"path": {"type": "string"}}), &["path"])
}

pub fn doc_import() -> JsonObject {
    object(
        json!({
            "path": {"type": "string",
                     "description": "a file on the machine FundaCAD runs on"},
            "content": {"type": "string",
                        "description": "the file itself, base64, when there is no path to give. \
                                        One piece of it if `part` says so"},
            "encoding": {"type": "string", "enum": ["base64", "text"],
                         "description": "how `content` is encoded, base64 by default. A text \
                                         format (STEP, OBJ, ASCII STL) can be sent as \"text\""},
            "compression": {"type": "string", "enum": ["gzip", "zip", "none"],
                            "description": "what `content` is wrapped in, before encoding. \
                                            Implied by a name ending .gz, .zip or .stpz, and \
                                            gzip is recognised on sight"},
            "name": {"type": "string",
                     "description": "what the file is called, e.g. \"bracket.step\" or \
                                     \"bracket.step.gz\", which is where `content` gets its \
                                     format and the body its name"},
            "part": {"type": "integer",
                     "description": "which piece this is, counting from 1"},
            "parts": {"type": "integer",
                      "description": "how many pieces there are altogether"},
            "upload": {"type": "string",
                       "description": "the id the first piece's reply gave you, required on \
                                       every piece after it"},
            "format": {"type": "string", "enum": IMPORT_FORMATS,
                       "description": "override what the extension says"},
            "at": {"type": "integer",
                   "description": "timeline position, appended by default"}
        }),
        &[],
    )
}

pub fn doc_save() -> JsonObject {
    object(json!({"path": {"type": "string"}}), &[])
}

pub fn doc_get() -> JsonObject {
    object(
        json!({"features_only": {"type": "boolean",
                                 "description": "omit the parameter table"}}),
        &[],
    )
}

pub fn doc_set() -> JsonObject {
    object(json!({"document": {"type": "object"}}), &["document"])
}

pub fn param_set() -> JsonObject {
    object(
        json!({
            "name": {"type": "string"},
            "expr": {"type": ["string", "number"]},
            "unit": {"type": "string", "enum": ["mm", "deg", "count"]},
            "comment": {"type": "string"}
        }),
        &["name", "expr"],
    )
}

pub fn param_remove() -> JsonObject {
    object(json!({"name": {"type": "string"}}), &["name"])
}

pub fn feature_add() -> JsonObject {
    object(
        json!({
            "feature": {"type": "object",
                        "description": "the feature JSON, needs at least `type`"},
            "at": {"type": "integer", "description": "insert position; append if omitted"}
        }),
        &["feature"],
    )
}

pub fn feature_update() -> JsonObject {
    object(
        json!({
            "id": {"type": "string"},
            "patch": {"type": "object"},
            "replace": {"type": "boolean"}
        }),
        &["id", "patch"],
    )
}

pub fn feature_remove() -> JsonObject {
    object(json!({"id": {"type": "string"}}), &["id"])
}

pub fn feature_move() -> JsonObject {
    object(
        json!({"id": {"type": "string"}, "to": {"type": "integer"}}),
        &["id", "to"],
    )
}

pub fn build() -> JsonObject {
    object(json!({}), &[])
}

pub fn inspect() -> JsonObject {
    object(
        json!({
            "body": {"type": "string", "description": "one body id; all of them if omitted"},
            "detail": {"type": "boolean",
                       "description": "list every face and edge (default: summary only)"},
            "selectors": {"type": "boolean",
                          "description": "include the raw selector JSON for each face and edge"},
            "faces": {"type": "array", "items": {"type": "integer"},
                      "description": "only these face indices"},
            "edges": {"type": "array", "items": {"type": "integer"},
                      "description": "only these edge indices"}
        }),
        &[],
    )
}

pub fn view() -> JsonObject {
    object(
        json!({
            "view": {"type": "string",
                     "enum": ["iso", "front", "back", "left", "right", "top", "bottom"]},
            "azimuth": {"type": "number", "description": "degrees anticlockwise from +X"},
            "elevation": {"type": "number", "description": "degrees above the XY plane"},
            "width": {"type": "integer"},
            "height": {"type": "integer"},
            "bodies": {"type": "array", "items": {"type": "string"},
                       "description": "only draw these body ids"},
            "section": {"type": "object",
                        "description": "cut the model open to see inside: {axis: X|Y|Z, at: mm \
                                        (default: the middle), keep: which half survives, \
                                        below|min|near or above|max|far (default below). \
                                        Anything else is refused rather than guessed at.}"},
            "focus": {"type": "object",
                      "description": "look closer: {at: [x,y,z], size: mm} frames a window that \
                                      many mm across around that point"},
            "highlight_body": {"type": "string"},
            "highlight_faces": {"type": "array", "items": {"type": "integer"},
                                "description": "face indices to paint orange"}
        }),
        &[],
    )
}

pub fn export() -> JsonObject {
    object(
        json!({
            "path": {"type": "string"},
            "format": {"type": "string", "enum": ["step", "stl", "3mf", "obj", "brep"]}
        }),
        &["path", "format"],
    )
}
