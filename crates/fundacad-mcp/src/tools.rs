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
    object(
        json!({"full": {"type": "boolean",
                        "description": "list every body, not only the ones that changed since \
                                        the last build"}}),
        &[],
    )
}

pub fn edit() -> JsonObject {
    object(
        json!({
            "ops": {"type": "array",
                    "description": "the edits, applied in order. Each is an object with `op` \
                                    and that tool's own arguments: \
                                    {op:\"add\", feature, at?}, \
                                    {op:\"update\", id, patch, replace?}, \
                                    {op:\"remove\", id}, {op:\"move\", id, to}, \
                                    {op:\"param\", name, expr, unit?, comment?}, \
                                    {op:\"param_remove\", name}",
                    "items": {"type": "object"}},
            "build": {"type": "boolean",
                      "description": "build once after the last edit and report it as `build` \
                                      does"}
        }),
        &["ops"],
    )
}

pub fn section() -> JsonObject {
    object(
        json!({
            "axis": {"type": "string", "enum": ["X", "Y", "Z"],
                     "description": "cut across this axis, at `at`"},
            "at": {"type": "number", "description": "where along the axis, in mm"},
            "origin": {"type": "array", "items": {"type": "number"},
                       "description": "a point on a plane at any angle, with `normal`"},
            "normal": {"type": "array", "items": {"type": "number"}},
            "bodies": {"type": "array", "items": {"type": "string"},
                       "description": "only these bodies, by id or name; every body the \
                                       plane crosses if omitted"},
            "outline": {"type": "boolean",
                        "description": "include each loop's points (default true)"}
        }),
        &[],
    )
}

pub fn printability() -> JsonObject {
    object(
        json!({
            "bodies": {"type": "array", "items": {"type": "string"},
                       "description": "only these bodies, by id or name; every body if omitted"},
            "nozzle": {"type": "number", "description": "nozzle width in mm (default 0.4)"},
            "layer": {"type": "number", "description": "layer height in mm (default 0.2)"},
            "overhang": {"type": "number",
                         "description": "the largest lean from vertical that prints without \
                                         support, in degrees (default 45)"},
            "minGap": {"type": "number",
                       "description": "the narrowest air gap that stays open, in mm (default 0.2)"},
            "maxBridge": {"type": "number",
                          "description": "the longest flat span bridged without support, in mm \
                                          (default 10)"},
            "checks": {"type": "array",
                       "items": {"type": "string", "enum": ["overhang", "wall", "gap", "bridge", "open"]},
                       "description": "only these checks; all of them if omitted"},
            "up": {"type": "string", "enum": ["+Z", "-Z", "+X", "-X", "+Y", "-Y"],
                   "description": "the build direction, the parts as modelled (default +Z)"},
            "layFlat": {"description": "check each part the way `export` lays it flat: true for \
                                        its largest flat face down, or {body: face index}"},
            "all": {"type": "boolean",
                    "description": "list every finding rather than the first 5 of each kind a body"}
        }),
        &[],
    )
}

pub fn interference() -> JsonObject {
    object(
        json!({
            "bodies": {"type": "array", "items": {"type": "string"},
                       "description": "only check these bodies against each other, by id or \
                                       name; every body if omitted"},
            "clearance": {"type": "number",
                          "description": "also report pairs that do not touch but are closer \
                                          than this many mm (default 1). 0 reports overlaps only"},
            "sweep": {"type": "object",
                      "description": "check at each value of a parameter: {param, from, to, \
                                      steps} (steps counts the values, ends included) or \
                                      {param, values:[...]}. The document is not changed"}
        }),
        &[],
    )
}

pub fn stress() -> JsonObject {
    let faces = |what: &str| {
        json!({"anyOf": [{"type": "array", "items": {"type": "object"}}, {"type": "object"}],
               "description": format!(
                   "{what}, as face selectors. Copy each from the face's `selector` in \
                    `inspect` (detail:true, selectors:true), body included. One selector \
                    without a list is taken too. A face index is not a selector")})
    };
    let load = json!({"type": "object", "properties": {
        "faces": faces("the faces this load pushes on"),
        "force": {"type": "array", "items": {"type": "number"},
                  "description": "[x, y, z] in N, the TOTAL force, spread over the faces by \
                                  area: [0, 0, -20] is 20 N (about 2 kg) pushing down"},
        "pressure": {"type": "number",
                     "description": "in MPa (N per square mm), pushing into the faces along \
                                     their inward normal"}
    }});
    object(
        json!({
            "body": {"type": "string",
                     "description": "the body to analyse, by id or name, as `build` lists \
                                     it. One closed solid"},
            "fixed": faces("the faces held still in every direction, at least one, e.g. the \
                            face bolted to the wall"),
            "loads": {"anyOf": [{"type": "array", "items": load.clone()}, load],
                      "description": "what pushes on the part, each {faces, force} or {faces, \
                                      pressure}, never both. One load without a list is taken \
                                      too. A load only on fixed faces does nothing to the part"},
            "material": {"type": ["string", "object"],
                         "description": "a preset by name (default PLA): PLA, PETG, ABS, ASA, \
                                         PA12 nylon, PC, aluminium 6061-T6, steel S235; or \
                                         your own {E, nu, yield, name} with E and yield in \
                                         MPa and nu the Poisson's ratio. Without yield there \
                                         is no safety factor"},
            "size": {"type": "number",
                     "description": "element size in mm (default: chosen from the part's \
                                     volume and thickness). Smaller is finer and slower"},
            "maxElements": {"type": "integer",
                            "description": "the most tetrahedra the mesh may have (default \
                                            30000, at most 80000). A size too fine for it is \
                                            grown, with a warning"},
            "image": {"type": "boolean",
                      "description": "return a PNG of the body coloured by stress, blue low \
                                      to red high, with a colour bar (default true)"},
            "view": {"type": "string",
                     "enum": ["iso", "front", "back", "left", "right", "top", "bottom"],
                     "description": "where the picture looks from, as in `view`"},
            "azimuth": {"type": "number",
                        "description": "degrees anticlockwise from +X, as in `view`; used \
                                        instead of `view`"},
            "elevation": {"type": "number",
                          "description": "degrees above the XY plane, as in `view`"},
            "az": {"type": "number", "description": "short for azimuth"},
            "el": {"type": "number", "description": "short for elevation"},
            "width": {"type": "integer"},
            "height": {"type": "integer"}
        }),
        &["body", "fixed", "loads"],
    )
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
            "azimuth": {"type": "number",
                        "description": "degrees anticlockwise from +X, the side the camera looks \
                                        from: 0 is from +X, -90 from the front (-Y). Given with \
                                        or without elevation, it is used instead of `view`"},
            "elevation": {"type": "number",
                          "description": "degrees above the XY plane: 90 looks straight down"},
            "az": {"type": "number", "description": "short for azimuth"},
            "el": {"type": "number", "description": "short for elevation"},
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
            "format": {"type": "string", "enum": ["step", "stl", "3mf"]},
            "separate": {"type": "boolean",
                         "description": "one file per body, named after the body, in a folder \
                                         named after `path` (parts.stl writes parts/<name>.stl)"},
            "body": {"type": "string", "description": "export only this body, by id or name"},
            "layFlat": {"description": "turn each part for printing: true puts each body's \
                                        largest flat face on the bed, or {body: face index} \
                                        picks the face per body (indices from `inspect`). \
                                        Parts are set side by side at z = 0. The document is \
                                        not changed",
                        "anyOf": [{"type": "boolean"}, {"type": "object"}]},
            "allowPartial": {"type": "boolean",
                             "description": "write the file even if a feature failed to build \
                                             (default: refuse and name the failures)"}
        }),
        &["path", "format"],
    )
}
