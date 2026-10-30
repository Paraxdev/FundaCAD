//! Render material edits on the document map, made the way the Render workspace makes them (src/document/store.ts
//! addMaterial, updateMaterial, removeMaterials, setBodiesMaterial and setFacesMaterial).

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value};

use crate::materials::{self, Field, FIELDS, KNOWN_KEYS, NODE_TYPES, SURFACE_KINDS};
use crate::model::{Doc, DocumentError};

pub type Material = Map<String, Value>;

/// The colour addMaterial gives a material made without one.
const NEW_COLOR: &str = "#9aa7b4";

fn err<T>(message: impl Into<String>) -> Result<T, DocumentError> {
    Err(DocumentError(message.into()))
}

fn own(doc: &Doc) -> Vec<Material> {
    let rows = doc.get("materials").and_then(Value::as_array);
    rows.into_iter().flatten().enumerate().filter_map(|(i, m)| materials::normalize_material(m, i)).collect()
}

fn starter_rows() -> Vec<Material> {
    materials::starter().into_iter().filter_map(|m| m.as_object().cloned()).collect()
}

/// As readProjectState reads it: a missing or empty library is the starter library.
pub fn library(doc: &Doc) -> Vec<Material> {
    let rows = own(doc);
    if rows.is_empty() {
        starter_rows()
    } else {
        rows
    }
}

fn texts<'a>(doc: &'a Doc, key: &str) -> impl Iterator<Item = (&'a String, &'a str)> {
    doc.get(key).and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| Some((k, v.as_str()?)))
}

/// Like toObject: the library is saved once it differs from the starter or anything wears a material.
fn write_library(doc: &mut Doc, lib: Vec<Material>) {
    let rows: Vec<Value> = lib.into_iter().map(Value::Object).collect();
    let worn = texts(doc, "bodyMaterial").next().is_some() || texts(doc, "faceMaterials").next().is_some();
    if worn || rows != materials::starter() {
        doc.insert("materials".into(), Value::Array(rows));
    } else {
        doc.remove("materials");
    }
}

/// An overlay map is only saved when it holds something.
fn edit_map(doc: &mut Doc, key: &str, edit: impl FnOnce(&mut Map<String, Value>)) {
    let mut map = doc.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
    edit(&mut map);
    if map.is_empty() {
        doc.remove(key);
    } else {
        doc.insert(key.into(), Value::Object(map));
    }
}

pub fn face_key(body: &str, face: u64) -> String {
    format!("{body}#{face}")
}

/// parseFaceKey: a key it cannot read is skipped, as the app skips it.
pub fn parse_face_key(key: &str) -> Option<(&str, u64)> {
    let (body, tail) = key.rsplit_once('#')?;
    if body.is_empty() || tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    tail.parse::<u64>().ok().filter(|f| *f <= 9_007_199_254_740_991).map(|f| (body, f))
}

#[derive(Debug, Default, PartialEq)]
pub struct Uses {
    pub bodies: Vec<String>,
    pub faces: Vec<(String, u64)>,
}

/// Material id to what wears it, in saved order.
pub fn uses(doc: &Doc) -> BTreeMap<String, Uses> {
    let mut out: BTreeMap<String, Uses> = BTreeMap::new();
    for (body, id) in texts(doc, "bodyMaterial") {
        out.entry(id.into()).or_default().bodies.push(body.clone());
    }
    for (key, id) in texts(doc, "faceMaterials") {
        if let Some((body, face)) = parse_face_key(key) {
            out.entry(id.into()).or_default().faces.push((body.into(), face));
        }
    }
    out
}

fn wearers(u: &Uses) -> String {
    let mut bits = vec![];
    if !u.bodies.is_empty() {
        bits.push(format!("bodies {}", u.bodies.join(", ")));
    }
    if !u.faces.is_empty() {
        let faces: Vec<String> = u.faces.iter().map(|(b, f)| format!("{b} F{f}")).collect();
        bits.push(format!("faces {}", faces.join(", ")));
    }
    bits.join("; ")
}

pub fn list(doc: &Doc) -> String {
    let lib = library(doc);
    let worn = uses(doc);
    let mut lines = vec![if own(doc).is_empty() {
        format!("This document has no materials of its own yet, so it offers the {} starter materials:", lib.len())
    } else {
        format!("{} render materials in this document:", lib.len())
    }];
    for m in &lib {
        let mut line = serde_json::to_string(m).unwrap_or_default();
        if let Some(u) = m.get("id").and_then(Value::as_str).and_then(|id| worn.get(id)) {
            line.push_str(&format!(" worn by {}", wearers(u)));
        }
        lines.push(line);
    }
    let known: HashSet<&str> = lib.iter().filter_map(|m| m.get("id").and_then(Value::as_str)).collect();
    for (id, u) in worn.iter().filter(|(id, _)| !known.contains(id.as_str())) {
        lines.push(format!("{id} is not in the library, so {} show the default grey.", wearers(u)));
    }
    lines.push("A field that is not shown is at its default.".into());
    if !own(doc).is_empty() {
        let names: Vec<String> = starter_rows()
            .iter()
            .map(|m| format!("{} ({})", m["id"].as_str().unwrap_or_default(), m["name"].as_str().unwrap_or_default()))
            .collect();
        lines.push(format!("Starter materials to copy with `from`: {}.", names.join(", ")));
    }
    lines.join("\n")
}

fn field_of(key: &str) -> Option<Field> {
    FIELDS.into_iter().find(|f| match f {
        Field::Num { key: k, .. } | Field::Hex(k) => *k == key,
    })
}

/// Refuses what the app would silently drop, so a typo is not lost. Returns the notes for clamped numbers.
fn check(key: &str, v: &Value) -> Result<Option<String>, DocumentError> {
    if v.is_null() {
        return match key {
            "name" | "color" => err(format!("`{key}` cannot be cleared, every material has one.")),
            _ => Ok(None),
        };
    }
    match (key, field_of(key)) {
        ("name", _) => match v.as_str().map(str::trim) {
            Some(s) if !s.is_empty() => Ok(None),
            _ => err("`name` must be some text."),
        },
        ("color", _) | (_, Some(Field::Hex(_))) => match materials::as_hex(v) {
            Some(_) => Ok(None),
            None => err(format!("`{key}` must be a colour like \"#a51321\", got {v}.")),
        },
        (_, Some(Field::Num { lo, hi, .. })) => match v.as_f64().filter(|x| x.is_finite()) {
            Some(x) if x < lo || x > hi => Ok(Some(format!(
                "{key} {x} is outside {} to {}, so it is {}.",
                materials::num(lo),
                materials::num(hi),
                materials::num(x.clamp(lo, hi))
            ))),
            Some(_) => Ok(None),
            None => err(format!("`{key}` takes a number from {} to {}.", materials::num(lo), materials::num(hi))),
        },
        ("castsLight", _) => match v.is_boolean() {
            true => Ok(None),
            false => err("`castsLight` is true or false."),
        },
        ("surface", _) => match materials::normalize_surface(v) {
            Some(s) if &s == v => Ok(None),
            Some(s) => Ok(Some(format!("The surface was repaired to {s}."))),
            None => err(format!(
                "`surface` needs a `kind` ({}), a `scale` above 0 and an `amount` from 0 to 1.",
                SURFACE_KINDS.join(", ")
            )),
        },
        ("surfaceGraph", _) => match materials::normalize_graph(v) {
            Some(g) => match graph_fault(&g) {
                Some(why) => err(format!("`surfaceGraph` is refused: {why}.")),
                None => Ok(dropped_nodes(v, &g)),
            },
            None => err(format!(
                "`surfaceGraph` needs `nodes` and an `output` naming one of them. Node types: {}.",
                NODE_TYPES.join(", ")
            )),
        },
        _ => Ok(None),
    }
}

/// The ports compileGraph reads, and whether each takes a colour.
fn port_takes_colour(kind: &str, port: &str) -> Option<bool> {
    match (kind, port) {
        ("output", "color") => Some(true),
        ("output", "roughness" | "bump")
        | ("ramp" | "colorramp", "t")
        | ("mix", "a" | "b" | "t")
        | ("math", "a" | "b") => Some(false),
        _ => None,
    }
}

fn stops_read(raw: &str) -> bool {
    let good = raw.split(';').filter(|part| {
        part.split_once(':').is_some_and(|(pos, hex)| {
            let hex = hex.trim();
            pos.trim().parse::<f64>().is_ok_and(f64::is_finite)
                && hex.len() == 7
                && hex.starts_with('#')
                && hex[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    });
    good.count() >= 2
}

fn has_loop<'a>(
    id: &'a str,
    by_id: &BTreeMap<&'a str, &'a Value>,
    path: &mut Vec<&'a str>,
    done: &mut HashSet<&'a str>,
) -> bool {
    if path.contains(&id) {
        return true;
    }
    if !done.insert(id) {
        return false;
    }
    path.push(id);
    let wires = by_id.get(id).and_then(|n| n["in"].as_object());
    let looped = wires.into_iter().flatten().filter_map(|(_, s)| s.as_str()).any(|s| has_loop(s, by_id, path, done));
    path.pop();
    looped
}

/// normalizeGraph only checks the shape, since a saved graph may be partial. compileGraph declares one variable per
/// node, so a wire to nothing, a colour in a number port, a loop or two ids that read alike would not compile.
fn graph_fault(graph: &Value) -> Option<String> {
    let nodes = graph["nodes"].as_array().map_or(&[][..], Vec::as_slice);
    let id_of = |n: &'_ Value| n["id"].as_str().unwrap_or_default().to_string();
    let by_id: BTreeMap<&str, &Value> = nodes.iter().map(|n| (n["id"].as_str().unwrap_or_default(), n)).collect();
    let mut seen = HashSet::new();
    for n in nodes {
        let id = id_of(n);
        let variable: String = id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        if !seen.insert(variable) {
            return Some(format!("node id {id} is used twice or reads like another, use letters and digits"));
        }
        let kind = n["type"].as_str().unwrap_or_default();
        let params = &n["params"];
        for key in ["colorA", "colorB"] {
            if kind == "ramp" && params.get(key).is_some_and(|c| materials::as_hex(c).is_none()) {
                return Some(format!("{id} needs {key} as a colour like \"#a51321\""));
            }
        }
        if kind == "colorramp" && params.get("stops").is_some_and(|s| !s.as_str().is_some_and(stops_read)) {
            return Some(format!("{id} needs stops as \"0:#000000;1:#ffffff\", at least two"));
        }
        for (port, src) in n["in"].as_object().into_iter().flatten() {
            let Some(wants_colour) = port_takes_colour(kind, port) else {
                return Some(format!("a {kind} node has no input {port}"));
            };
            let Some(source) = src.as_str().and_then(|s| by_id.get(s)) else {
                return Some(format!("{id}.{port} is wired to {src}, which is not a node"));
            };
            let source_kind = source["type"].as_str().unwrap_or_default();
            if source_kind == "output" {
                return Some(format!("{id}.{port} is wired to the output node, which gives nothing"));
            }
            if matches!(source_kind, "ramp" | "colorramp") != wants_colour {
                let (takes, gives) = if wants_colour { ("a colour", "a number") } else { ("a number", "a colour") };
                return Some(format!("{id}.{port} takes {takes} but {} gives {gives}", id_of(source)));
            }
        }
    }
    let output = graph["output"].as_str().unwrap_or_default();
    if by_id.get(output).is_none_or(|n| n["type"] != "output") {
        return Some(format!("`output` must name a node of type output, got {output}"));
    }
    has_loop(output, &by_id, &mut vec![], &mut HashSet::new()).then(|| "its wires make a loop".to_string())
}

fn dropped_nodes(given: &Value, kept: &Value) -> Option<String> {
    let ids = |g: &Value| -> Vec<String> {
        let nodes = g.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default();
        nodes
            .iter()
            .map(|n| n.get("id").map_or("(no id)".into(), |id| id.as_str().unwrap_or("?").to_string()))
            .collect()
    };
    let keep = ids(kept);
    let gone: Vec<String> = ids(given).into_iter().filter(|id| !keep.contains(id)).collect();
    (!gone.is_empty()).then(|| {
        format!("Dropped graph nodes {} (no id or an unknown type; types: {}).", gone.join(", "), NODE_TYPES.join(", "))
    })
}

#[derive(Debug)]
pub struct SetOutcome {
    pub id: String,
    pub created: bool,
    pub material: Material,
    pub notes: Vec<String>,
}

fn arg_text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, DocumentError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.trim())),
        Some(_) => err(format!("`{key}` must be a material id like \"m-steel\".")),
    }
}

/// Creates or edits one material. `id` edits it when the library has it and creates it otherwise; `from` starts
/// from a document or starter material; a field sent as null goes back to its default.
pub fn set(doc: &mut Doc, args: &Map<String, Value>) -> Result<SetOutcome, DocumentError> {
    let mut notes = vec![];
    for (key, v) in args {
        if key == "id" || key == "from" {
            continue;
        }
        if !KNOWN_KEYS.contains(&key.as_str()) || key == "colour" || key == "hex" {
            let mut takes: Vec<&str> = KNOWN_KEYS.iter().copied().filter(|k| !["colour", "hex"].contains(k)).collect();
            takes.push("from");
            return err(format!("`{key}` is not a material field. A material takes: {}.", takes.join(", ")));
        }
        notes.extend(check(key, v)?);
    }
    let mut lib = library(doc);
    let id = arg_text(args, "id")?;
    let at = id.and_then(|id| lib.iter().position(|m| m["id"] == id));
    let from = match arg_text(args, "from")? {
        None => None,
        Some(f) => match lib.iter().chain(starter_rows().iter()).find(|m| m["id"] == f) {
            Some(m) => Some(m.clone()),
            None => return err(format!("No material `{f}` to copy from. material_list shows the ids.")),
        },
    };
    let mut base = match (at, &from) {
        (Some(i), Some(f)) => {
            let mut b = f.clone();
            b.insert("id".into(), lib[i]["id"].clone());
            b.insert("name".into(), lib[i]["name"].clone());
            b
        }
        (Some(i), None) => lib[i].clone(),
        (None, Some(f)) => f.clone(),
        (None, None) => Map::new(),
    };
    for (key, v) in args.iter().filter(|(k, _)| *k != "id" && *k != "from") {
        match v {
            Value::Null => base.remove(key),
            Value::String(s) if key == "name" => base.insert(key.clone(), Value::from(s.trim())),
            _ => base.insert(key.clone(), v.clone()),
        };
    }
    if at.is_none() {
        let names: Vec<&str> = lib.iter().filter_map(|m| m.get("name").and_then(Value::as_str)).collect();
        let given = args.get("name").and_then(Value::as_str).map(str::trim);
        let fresh_base = from.as_ref().and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("Material");
        let name = given.map_or_else(|| materials::fresh_name(names, fresh_base), str::to_string);
        let taken: HashSet<String> = lib.iter().filter_map(|m| m.get("id")?.as_str().map(String::from)).collect();
        let new_id = id.map_or_else(|| materials::unique_id(&materials::slug_id(&name), &taken), str::to_string);
        base.insert("id".into(), Value::from(new_id));
        base.insert("name".into(), Value::from(name));
        base.entry("color").or_insert_with(|| Value::from(NEW_COLOR));
    }
    let index = at.unwrap_or(lib.len());
    let Some(material) = materials::normalize_material(&Value::Object(base), index) else {
        return err("A material needs a `color`.");
    };
    let id = material["id"].as_str().unwrap_or_default().to_string();
    match at {
        Some(i) => lib[i] = material.clone(),
        None => lib.push(material.clone()),
    }
    write_library(doc, lib);
    Ok(SetOutcome { id, created: at.is_none(), material, notes })
}

pub fn require_known(doc: &Doc, id: &str) -> Result<(), DocumentError> {
    if library(doc).iter().any(|m| m["id"] == id) {
        Ok(())
    } else {
        err(format!("No material `{id}` in this document. material_list shows the ids."))
    }
}

/// Bodies and faces wearing a removed material go back to their default look, as in the app.
pub fn remove(doc: &mut Doc, ids: &[String]) -> Result<Uses, DocumentError> {
    for id in ids {
        require_known(doc, id)?;
    }
    let gone: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut dropped = Uses::default();
    let mut keys = vec![];
    edit_map(doc, "bodyMaterial", |m| {
        m.retain(|body, held| {
            let wears = held.as_str().is_some_and(|h| gone.contains(h));
            if wears {
                dropped.bodies.push(body.clone());
            }
            !wears
        })
    });
    edit_map(doc, "faceMaterials", |m| {
        m.retain(|key, held| {
            let wears = held.as_str().is_some_and(|h| gone.contains(h));
            if wears {
                if let Some((body, face)) = parse_face_key(key) {
                    dropped.faces.push((body.into(), face));
                }
                keys.push(key.clone());
            }
            !wears
        })
    });
    edit_map(doc, "facePrints", |m| m.retain(|key, _| !keys.contains(key)));
    let lib = library(doc).into_iter().filter(|m| !m["id"].as_str().is_some_and(|id| gone.contains(id))).collect();
    write_library(doc, lib);
    Ok(dropped)
}

/// The MCP builds the whole timeline, so its face numbers are not those the app shows while part of it is switched off.
pub fn faces_unreliable(doc: &Doc) -> Option<String> {
    let off = doc.get("rollback").is_some_and(|r| !r.is_null())
        || doc.get("suppressed").and_then(Value::as_array).is_some_and(|s| !s.is_empty());
    off.then(|| {
        "A material cannot go on a face while the timeline is rolled back or has suppressed features, since the face \
         numbers here would not be the ones the app shows. Assign the body, or roll forward and turn them back on first."
            .to_string()
    })
}

/// `material` None clears. A face is written without a print, so the app finds it by its index on the next build.
pub fn assign(
    doc: &mut Doc,
    material: Option<&str>,
    bodies: &[String],
    faces: &[(String, u64)],
) -> Result<(), DocumentError> {
    if let Some(id) = material {
        require_known(doc, id)?;
    }
    let lib = library(doc);
    let put = |m: &mut Map<String, Value>, key: String| match material {
        Some(id) => m.insert(key, Value::from(id)),
        None => m.remove(&key),
    };
    edit_map(doc, "bodyMaterial", |m| bodies.iter().for_each(|b| _ = put(m, b.clone())));
    let keys: Vec<String> = faces.iter().map(|(b, f)| face_key(b, *f)).collect();
    edit_map(doc, "faceMaterials", |m| keys.iter().for_each(|k| _ = put(m, k.clone())));
    edit_map(doc, "facePrints", |m| m.retain(|key, _| !keys.contains(key)));
    write_library(doc, lib);
    Ok(())
}

/// Saves each assigned face's print beside its key, the form `savedFaceRefs` writes.
pub fn write_prints(doc: &mut Doc, prints: Vec<(String, Value)>) {
    edit_map(doc, "facePrints", |m| m.extend(prints));
}
