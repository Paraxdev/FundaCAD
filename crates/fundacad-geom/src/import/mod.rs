//! The `import` op, replaces `import_geometry`, `_assembly_payload` and
//! `_import_size_cap` of the Python engine's `mesh_import.py`, with the product tree walk
//! of `step_assembly.py` in the vendored bindings (`opencascade::xcaf`).
//!
//! Not here yet: the free memory guard.

pub mod amf;
pub mod blobstore;
pub mod canonical;
pub mod fcstd;
pub mod gltf;
pub mod mesh;
pub mod off;
pub mod packed;
pub mod ply;
pub mod rhino;
pub mod x3d;

use std::collections::HashMap;
use std::path::Path;

use fundacad_core::face_colors;
use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use opencascade::primitives::Shape;
use opencascade::xcaf::{self, StepAssembly, StepNote};
use serde_json::{json, Map, Value};

use crate::kernel::{self, Kind};
use blobstore::BlobStore;
pub use packed::unpack_step;

pub const MAX_IMPORT_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_IMPORT_BREP_FILE_BYTES: u64 = 1024 * 1024 * 1024;

pub fn import_size_cap(fmt: &str) -> u64 {
    if matches!(fmt, "step" | "stp" | "stpz" | "xbf" | "brep" | "iges" | "igs" | "fcstd") {
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

/// What sewing loose faces left to say, each sentence led by the name the
/// build gives the body it is about. `names` is empty for a file that is one
/// body, which the feature names.
fn repair_notes(asm: &StepAssembly, names: &[String], turned: &[StepNote]) -> Vec<Value> {
    let mut owned: HashMap<usize, usize> = HashMap::new();
    for leaf in &asm.leaves {
        *owned.entry(leaf.node).or_default() += 1;
    }
    let mut out: Vec<Value> = Vec::new();
    for note in asm.notes.iter().chain(turned) {
        let text = match names.get(note.node) {
            None => note.text.clone(),
            Some(name) => match note.leaf.filter(|_| owned.get(&note.node).is_some_and(|&n| n > 1)) {
                Some(leaf) => {
                    let nth = asm.leaves[..=leaf.min(asm.leaves.len() - 1)].iter().filter(|l| l.node == note.node).count();
                    format!("{name} {nth}: {}", note.text)
                }
                None => format!("{name}: {}", note.text),
            },
        };
        // a product placed twice says its piece twice
        if !out.iter().any(|v| v.as_str() == Some(text.as_str())) {
            out.push(json!(text));
        }
    }
    out
}

/// What turning `n` inside out solids outward says.
fn turned_text(n: usize) -> String {
    if n == 1 {
        "1 solid was inside out, its faces pointed into the material, so it was turned outward".into()
    } else {
        format!("{n} solids were inside out, their faces pointed into the material, so they were turned outward")
    }
}

/// A mesh or BREP file's shape with its inside out solids turned outward, and
/// what that says. The STEP reader turns a solid outward itself, see
/// `reader_turned`. A document that already holds a shape keeps it as stored,
/// a face selector saved against it carries the normal it had.
fn outward(imported: Imported) -> Imported {
    let (shape, n) = crate::bench::phase("turn_outward", || kernel::turned_outward_where_clean(&imported.shape));
    if n == 0 {
        return imported;
    }
    let mut fields = imported.fields;
    let notes = fields.entry("notes").or_insert_with(|| json!([]));
    if let Some(list) = notes.as_array_mut() {
        list.push(json!(turned_text(n)));
    }
    Imported { shape, fields }
}

/// What the STEP reader turning the solids of `shape` outward says, about the
/// body `node` and `leaf` name.
fn reader_turned(shape: &Shape, node: usize, leaf: Option<usize>) -> Option<StepNote> {
    let n = kernel::reader_turned_solids(shape);
    (n > 0).then(|| StepNote { node, leaf, text: turned_text(n) })
}

/// `_assembly_payload`: the leaves in order as one flat compound, their
/// products as `nodes`, and one `parts` row per leaf.
pub fn assembly_payload(asm: &StepAssembly) -> Imported {
    let names: Vec<String> = asm
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            Some(clean(&n.name))
                .filter(|s| !s.is_empty())
                .or_else(|| Some(clean(&n.instance_name)).filter(|s| !s.is_empty()))
                .unwrap_or_else(|| format!("Part {}", i + 1))
        })
        .collect();
    let nodes: Vec<Value> = asm
        .nodes
        .iter()
        .zip(&names)
        .map(|(n, name)| {
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
    let mut turned: Vec<StepNote> = Vec::new();
    for (i, leaf) in asm.leaves.iter().enumerate() {
        turned.extend(reader_turned(&leaf.shape, leaf.node, Some(i)));
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
    let notes = repair_notes(asm, &names, &turned);
    if !notes.is_empty() {
        fields.insert("notes".into(), Value::Array(notes));
    }
    Imported { shape, fields }
}

/// The STEP half of `import_geometry`.
pub fn read_step(path: &Path) -> Result<Imported, String> {
    let progress = crate::cancel::progress_beating();
    let asm = crate::bench::phase("step_read", || xcaf::read_step_assembly_with(path, &progress.start()))
        .map_err(|e| occt_message(&e))?;
    Ok(from_assembly(asm))
}

/// IGES, read like STEP with each free root a product.
pub fn read_iges(path: &Path) -> Result<Imported, String> {
    let progress = crate::cancel::progress_beating();
    let asm = crate::bench::phase("iges_read", || xcaf::read_iges_assembly_with(path, &progress.start()))
        .map_err(|e| occt_message(&e))?;
    Ok(from_assembly(asm))
}

/// An OCCT binary XCAF document, read like STEP, in millimetres.
pub fn read_xbf(path: &Path) -> Result<Imported, String> {
    const UNREADABLE: &str = "could not read the XBF file (it may be truncated or not an OCCT XBF document)";
    let mut magic = [0u8; 7];
    let mut opened = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if std::io::Read::read_exact(&mut opened, &mut magic).is_err() || &magic != b"BINFILE" {
        return Err(UNREADABLE.into());
    }
    drop(opened);
    let progress = crate::cancel::progress_beating();
    let asm = crate::bench::phase("xbf_read", || xcaf::read_xbf_assembly_with(path, &progress.start())).map_err(|e| {
        // OCCT can fail on a damaged file with something that is neither a
        // Standard_Failure nor a std::exception, which the bridge can only call unknown.
        match occt_message(&e) {
            m if m == "unknown C++ exception" => UNREADABLE.to_string(),
            m => m,
        }
    })?;
    Ok(from_assembly(asm))
}

fn from_assembly(asm: StepAssembly) -> Imported {
    if asm.is_assembly {
        return crate::bench::phase("assembly_payload", || assembly_payload(&asm));
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
    let n: usize = asm.roots.iter().map(kernel::reader_turned_solids).sum();
    let turned: Vec<StepNote> = (n > 0).then(|| StepNote { node: 0, leaf: None, text: turned_text(n) }).into_iter().collect();
    let notes = repair_notes(&asm, &[], &turned);
    if !notes.is_empty() {
        fields.insert("notes".into(), Value::Array(notes));
    }
    let shape = if asm.roots.len() == 1 {
        let root = asm.roots.into_iter().next().unwrap_or_else(Shape::empty);
        canonical::canonicalize(&root).unwrap_or(root)
    } else {
        canonical::canonicalize_roots(&asm.roots)
    };
    Imported { shape, fields }
}

/// A text file as read, or unpacked when it is gzip (.wrz, .x3dz), capped at
/// the import size limit.
fn is_gzip(p: &Path) -> bool {
    let mut magic = [0u8; 2];
    std::fs::File::open(p).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic)).is_ok() && magic == [0x1f, 0x8b]
}

fn text_maybe_gzipped(data: Vec<u8>) -> Result<String, String> {
    use std::io::Read;
    if !data.starts_with(&[0x1f, 0x8b]) {
        return Ok(String::from_utf8_lossy(&data).into_owned());
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data.as_slice())
        .take(MAX_IMPORT_FILE_BYTES + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("couldn't unpack this gzip file ({e})"))?;
    if out.len() as u64 > MAX_IMPORT_FILE_BYTES {
        return Err(format!("the file unpacks past {} MiB, too large to import", MAX_IMPORT_FILE_BYTES / (1024 * 1024)));
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn occt_message(e: &opencascade::Error) -> String {
    match e {
        opencascade::Error::Occt(m) => m.clone(),
        other => other.to_string(),
    }
}

/// `import_geometry`: read the file, store its geometry and answer
/// `{geom, solid, faces, name, color?, nodes?, parts?, notes?}`.
pub fn import_geometry(path: &str, fmt: &str, store: &BlobStore) -> Result<Map<String, Value>, String> {
    import_geometry_in(path, fmt, store, None)
}

/// `import_geometry` with the unit the user said a glTF, VRML or X3D file is
/// in, `mm`, `cm`, `m` or `inch`. Without one those read as metres, the spec.
pub fn import_geometry_in(path: &str, fmt: &str, store: &BlobStore, unit: Option<&str>) -> Result<Map<String, Value>, String> {
    let mm_per_unit = unit.map(mesh::mm_per_unit_name).transpose()?;
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
    if !matches!(fmt.as_str(), "step" | "stp" | "stpz" | "vrml" | "x3d") && is_gzip(p) {
        return Err(format!(
            "this {} file is gzip compressed, only STEP, VRML and X3D import compressed. Unpack it and import the file inside.",
            fmt.to_uppercase()
        ));
    }
    let imported = match fmt.as_str() {
        "step" | "stp" | "stpz" => match unpack_step(p, MAX_IMPORT_BREP_FILE_BYTES)? {
            Some(unpacked) => {
                let size = std::fs::metadata(unpacked.path()).map_or(0, |m| m.len());
                fundacad_engine::sysmem::refuse_if_memory_is_short(size, None)?;
                read_step(unpacked.path())?
            }
            None => read_step(p)?,
        },
        "xbf" => read_xbf(p)?,
        "iges" | "igs" => read_iges(p)?,
        "fcstd" => fcstd::read_fcstd(p)?,
        "3dm" => outward(rhino::read_3dm(p)?),
        "brep" => outward(Imported {
            shape: Shape::read_brep_text(p).map_err(|e| e.to_string())?,
            fields: Map::new(),
        }),
        "stl" | "3mf" | "obj" => {
            if let Some(ntri) = mesh::peek_triangle_count(p, &fmt).filter(|&n| n > mesh::MAX_IMPORT_TRIANGLES) {
                return Err(mesh::too_dense_error(ntri));
            }
            let shape = match fmt.as_str() {
                "stl" => mesh::read_stl(p)?,
                "3mf" => mesh::read_3mf(p)?,
                _ => mesh::read_obj(p)?,
            };
            outward(Imported { shape, fields: Map::new() })
        }
        "glb" => {
            let shape = mesh::read_glb(p, mm_per_unit)?;
            let mut fields = Map::new();
            if let Some(c) = std::fs::read(p).ok().and_then(|d| mesh::glb_dominant_color(&d)) {
                fields.insert("color".into(), json!(c));
            }
            outward(Imported { shape, fields })
        }
        "gltf" => {
            let (shape, color) = mesh::read_gltf(p, mm_per_unit)?;
            let mut fields = Map::new();
            if let Some(c) = color {
                fields.insert("color".into(), json!(c));
            }
            outward(Imported { shape, fields })
        }
        "ply" | "off" => {
            let data = std::fs::read(p).map_err(|e| e.to_string())?;
            let obj = if fmt == "ply" { ply::read_ply(&data)? } else { off::read_off(&String::from_utf8_lossy(&data))? };
            outward(mesh::finish_objects(vec![obj])?)
        }
        "vrml" | "x3d" => {
            let text = text_maybe_gzipped(std::fs::read(p).map_err(|e| e.to_string())?)?;
            let (objs, notes) = if fmt == "vrml" { x3d::read_vrml(&text, mm_per_unit)? } else { x3d::read_x3d(&text, mm_per_unit)? };
            let mut imported = mesh::finish_objects(objs)?;
            if !notes.is_empty() {
                imported.fields.insert("notes".into(), json!(notes));
            }
            outward(imported)
        }
        "amf" => {
            let (objs, notes) = amf::read_amf(std::fs::read(p).map_err(|e| e.to_string())?)?;
            let mut imported = mesh::finish_objects(objs)?;
            if !notes.is_empty() {
                imported.fields.insert("notes".into(), json!(notes));
            }
            outward(imported)
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
    let name = body_name(p);
    let mut out = Map::new();
    out.insert("geom".into(), json!(geom));
    out.insert("solid".into(), json!(kernel::count(&imported.shape, Kind::Solid) > 0));
    out.insert("faces".into(), json!(kernel::count(&imported.shape, Kind::Face)));
    out.insert("name".into(), json!(name));
    for (k, v) in imported.fields {
        out.insert(k, v);
    }
    if let (Some(u), "glb" | "gltf" | "vrml" | "x3d") = (unit, fmt.as_str()) {
        out.insert("unit".into(), json!(u));
    }
    Ok(out)
}

/// The file name without its extension, and without the inner one of a
/// gzip copy (part.step.gz, part.wrl.gz).
fn body_name(p: &Path) -> String {
    let file = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut stem = Path::new(&file).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if file.to_lowercase().ends_with(".gz") {
        if let Some(inner) = Path::new(&stem).file_stem().map(|s| s.to_string_lossy().into_owned()) {
            stem = inner;
        }
    }
    if stem.is_empty() {
        "Imported".into()
    } else {
        stem
    }
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
        .and_then(|store| import_geometry_in(path, fmt, &store, req.get("unit").and_then(Value::as_str)));
    match result {
        Ok(m) => JobResult::Json(m),
        Err(message) => error_result(&message),
    }
}

pub fn blob_result(op: &str, req: &Map<String, Value>) -> JobResult {
    let result = BlobStore::open(blobstore::default_root())
        .map_err(|e| format!("the geometry store cannot be opened ({e})"))
        .and_then(|store| blobstore::blob_op(op, req, &store));
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
