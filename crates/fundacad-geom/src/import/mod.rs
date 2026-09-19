//! The `import` op, replaces `import_geometry`, `_assembly_payload` and
//! `_import_size_cap` of the Python engine's `mesh_import.py`, with the product tree walk
//! of `step_assembly.py` in the vendored bindings (`opencascade::xcaf`).
//!
//! Not here yet: the free memory guard.

pub mod blobstore;
pub mod canonical;
pub mod gltf;
pub mod mesh;

use std::collections::HashMap;
use std::path::Path;

use fundacad_core::face_colors;
use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use opencascade::primitives::Shape;
use opencascade::xcaf::{self, StepAssembly};
use serde_json::{json, Map, Value};

use crate::kernel::{self, Kind};
use blobstore::BlobStore;

pub const MAX_IMPORT_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_IMPORT_BREP_FILE_BYTES: u64 = 1024 * 1024 * 1024;

pub fn import_size_cap(fmt: &str) -> u64 {
    if matches!(fmt, "step" | "stp" | "brep") {
        MAX_IMPORT_BREP_FILE_BYTES
    } else {
        MAX_IMPORT_FILE_BYTES
    }
}

fn hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// `step_assembly._clean`: control and format characters out, ends trimmed.
fn clean(name: &str) -> String {
    name.chars()
        .filter(|&c| {
            !c.is_control()
                && !matches!(c, '\u{ad}' | '\u{600}'..='\u{605}' | '\u{61c}' | '\u{6dd}' | '\u{70f}'
                    | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
                    | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}'
                    | '\u{fff9}'..='\u{fffb}' | '\u{e000}'..='\u{f8ff}')
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// The imported shape and the manifest fields that go beside it.
pub struct Imported {
    pub shape: Shape,
    pub fields: Map<String, Value>,
}

/// `_assembly_payload`: the leaves in order as one flat compound, their
/// products as `nodes`, and one `parts` row per leaf.
pub fn assembly_payload(asm: &StepAssembly) -> Imported {
    let nodes: Vec<Value> = asm
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let name = Some(clean(&n.name))
                .filter(|s| !s.is_empty())
                .or_else(|| Some(clean(&n.instance_name)).filter(|s| !s.is_empty()))
                .unwrap_or_else(|| format!("Part {}", i + 1));
            let mut m = Map::new();
            m.insert("name".into(), json!(name));
            m.insert("parent".into(), n.parent.map_or(Value::Null, |p| json!(p)));
            if let Some(c) = n.color {
                m.insert("color".into(), json!(hex(c)));
            }
            Value::Object(m)
        })
        .collect();
    type Colors = Option<Vec<Option<[u8; 3]>>>;
    // per product solid, so a part placed two hundred times is rewritten once
    let mut canonical_of: HashMap<String, Option<(Shape, Colors)>> = HashMap::new();
    let mut leaves: Vec<Option<Shape>> = Vec::with_capacity(asm.leaves.len());
    let mut parts = Vec::with_capacity(asm.leaves.len());
    for (i, leaf) in asm.leaves.iter().enumerate() {
        let mut colors = leaf.face_colors.clone();
        let mut placed = None;
        match &leaf.product {
            Some((key, local)) => {
                let done = canonical_of.entry(key.clone()).or_insert_with(|| {
                    crate::bench::phase("canonicalize", || canonical::canonicalize(local)).map(|result| {
                        let realigned = match &colors {
                            Some(c) => canonical::realign_face_colors(local, &result, c),
                            None => None,
                        };
                        (result, realigned)
                    })
                });
                if let Some((result, realigned)) = done {
                    if let Ok(moved) = asm.place(i, result) {
                        placed = Some(moved);
                        colors = realigned.clone();
                    }
                }
            }
            None if kernel::count(&leaf.shape, Kind::Solid) > 0 => {
                if let Some(result) = canonical::canonicalize(&leaf.shape) {
                    if let Some(c) = &colors {
                        colors = canonical::realign_face_colors(&leaf.shape, &result, c);
                    }
                    placed = Some(result);
                }
            }
            None => {}
        }
        let shape = placed.as_ref().unwrap_or(&leaf.shape);
        let mut part = Map::new();
        part.insert("node".into(), json!(leaf.node));
        part.insert("faces".into(), json!(kernel::count(shape, Kind::Face)));
        if let Some(colors) = &colors {
            let hexed: Vec<Option<String>> = colors.iter().map(|c| c.map(hex)).collect();
            if let Some(packed) = face_colors::encode(&hexed) {
                part.insert("faceColors".into(), json!(packed));
            }
        }
        if let Some(c) = leaf.solid_color {
            part.insert("color".into(), json!(hex(c)));
        }
        parts.push(Value::Object(part));
        leaves.push(placed);
    }
    let shape = kernel::compound(asm.leaves.iter().zip(&leaves).map(|(l, p)| p.as_ref().unwrap_or(&l.shape)));
    let mut fields = Map::new();
    fields.insert("nodes".into(), Value::Array(nodes));
    fields.insert("parts".into(), Value::Array(parts));
    Imported { shape, fields }
}

/// The STEP half of `import_geometry`.
pub fn read_step(path: &Path) -> Result<Imported, String> {
    let progress = crate::cancel::progress_beating();
    let asm = crate::bench::phase("step_read", || xcaf::read_step_assembly_with(path, &progress.start()))
        .map_err(|e| occt_message(&e))?;
    if asm.is_assembly {
        return Ok(crate::bench::phase("assembly_payload", || assembly_payload(&asm)));
    }
    let color = asm
        .leaves
        .first()
        .and_then(|l| l.solid_color)
        .or_else(|| asm.nodes.first().and_then(|n| n.color));
    let mut fields = Map::new();
    if let Some(c) = color {
        fields.insert("color".into(), json!(hex(c)));
    }
    let shape = if asm.roots.len() == 1 {
        let root = asm.roots.into_iter().next().unwrap_or_else(Shape::empty);
        canonical::canonicalize(&root).unwrap_or(root)
    } else {
        canonical::canonicalize_roots(&asm.roots)
    };
    Ok(Imported { shape, fields })
}

fn occt_message(e: &opencascade::Error) -> String {
    match e {
        opencascade::Error::Occt(m) => m.clone(),
        other => other.to_string(),
    }
}

/// `import_geometry`: read the file, store its geometry and answer
/// `{geom, solid, faces, name, color?, nodes?, parts?}`.
pub fn import_geometry(path: &str, fmt: &str, store: &BlobStore) -> Result<Map<String, Value>, String> {
    let fmt = fmt.to_lowercase();
    let p = Path::new(path);
    let size = std::fs::metadata(p).map_or(0, |m| m.len());
    let cap = import_size_cap(&fmt);
    if size > cap {
        return Err(format!(
            "file is {:.0} MiB, too large to import (limit {} MiB).",
            size as f64 / (1024.0 * 1024.0),
            cap / (1024 * 1024)
        ));
    }
    fundacad_engine::sysmem::refuse_if_memory_is_short(size, None)?;
    let imported = match fmt.as_str() {
        "step" | "stp" => read_step(p)?,
        "brep" => Imported {
            shape: Shape::read_brep_text(p).map_err(|e| e.to_string())?,
            fields: Map::new(),
        },
        "stl" | "3mf" | "obj" => {
            if let Some(ntri) = mesh::peek_triangle_count(p, &fmt).filter(|&n| n > mesh::MAX_IMPORT_TRIANGLES) {
                return Err(mesh::too_dense_error(ntri));
            }
            let shape = match fmt.as_str() {
                "stl" => mesh::read_stl(p)?,
                "3mf" => mesh::read_3mf(p)?,
                _ => mesh::read_obj(p)?,
            };
            Imported { shape, fields: Map::new() }
        }
        "glb" => {
            let shape = mesh::read_glb(p)?;
            let mut fields = Map::new();
            if let Some(c) = std::fs::read(p).ok().and_then(|d| mesh::glb_dominant_color(&d)) {
                fields.insert("color".into(), json!(c));
            }
            Imported { shape, fields }
        }
        other => return Err(format!("unsupported import format: {other}")),
    };
    let bytes = crate::bench::phase("to_bin", || xcaf::to_bin_v3(&imported.shape)).map_err(|e| {
        format!(
            "could not store the imported geometry ({e}). Check free disk space and permissions on the FundaCAD data directory."
        )
    })?;
    let geom = crate::bench::phase("blob_put", || store.put_bytes(&bytes)).map_err(|e| {
        format!(
            "could not store the imported geometry ({e}). Check free disk space and permissions on the FundaCAD data directory."
        )
    })?;
    let name = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Imported".into());
    let mut out = Map::new();
    out.insert("geom".into(), json!(geom));
    out.insert("solid".into(), json!(kernel::count(&imported.shape, Kind::Solid) > 0));
    out.insert("faces".into(), json!(kernel::count(&imported.shape, Kind::Face)));
    out.insert("name".into(), json!(name));
    for (k, v) in imported.fields {
        out.insert(k, v);
    }
    Ok(out)
}

/// The `import` op.
pub fn import_result(req: &Map<String, Value>) -> JobResult {
    let (Some(path), Some(fmt)) = (
        req.get("path").and_then(Value::as_str),
        req.get("format").and_then(Value::as_str),
    ) else {
        return error_result("import: a request needs a path and a format");
    };
    let result = BlobStore::open(blobstore::default_root())
        .map_err(|e| {
            format!(
                "could not store the imported geometry ({e}). Check free disk space and permissions on the FundaCAD data directory."
            )
        })
        .and_then(|store| import_geometry(path, fmt, &store));
    match result {
        Ok(m) => JobResult::Json(m),
        Err(message) => error_result(&message),
    }
}

/// The `migrateGeometry` op.
pub fn migrate_result(req: &Map<String, Value>) -> JobResult {
    let items = req.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    match BlobStore::open(blobstore::default_root()) {
        Ok(store) => match crate::features::import::migrate_geometry(&items, &store) {
            Value::Object(m) => JobResult::Json(m),
            _ => error_result("migrateGeometry produced no result"),
        },
        Err(e) => error_result(&format!(
            "could not store the imported geometry ({e}). Check free disk space and permissions on the FundaCAD data directory."
        )),
    }
}
