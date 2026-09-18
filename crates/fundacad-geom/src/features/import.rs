//! The import feature, the Python engine's `import_feature.py`: the stored geometry of an
//! imported file, bound to its assembly manifest when it has one.
//!
//! Not here: `heal_snapped.heal_stored`, which repairs blobs written before the
//! import mesh gate existed. Blobs this engine writes pass that gate already.

use std::collections::HashMap;

use fundacad_core::schema::{Import, ImportNode, ImportPart};
use opencascade::mesh_import as occ;
use opencascade::primitives::Shape;
use opencascade::xcaf;
use serde_json::Value;

use crate::builder::{Ctx, FResult, Fail, ImportedMeta};
use crate::import::blobstore::{self, BlobStore};
use crate::kernel::{self, Kind};

const BINTOOLS_MAGIC: &[u8] = b"Open CASCADE Topology V";
const BREP_MAGIC: &[u8] = b"CASCADE Topology V";
/// `MAX_BREP_BYTES`, the decoded size cap of the legacy inline copy.
pub const MAX_BREP_BYTES: usize = 64 * 1024 * 1024;

fn has_magic(data: &[u8], magic: &[u8]) -> bool {
    let head = &data[..data.len().min(magic.len() + 2)];
    let start = head
        .iter()
        .position(|b| !matches!(b, b'\n' | b'\r' | b' '))
        .unwrap_or(head.len());
    head[start..].starts_with(magic)
}

/// `_blob_to_shape`: the header is checked because a crafted container
/// chooses both the bytes and the hash they are stored under.
pub fn blob_to_shape(data: &[u8]) -> FResult<Shape> {
    if !has_magic(data, BINTOOLS_MAGIC) {
        return Err(Fail::msg(
            "stored geometry is not a valid binary BREP (bad header)",
        ));
    }
    let shape = xcaf::from_bin(data).map_err(|_| Fail::Internal("Standard_Failure".into()))?;
    if kernel::is_null(&shape) {
        return Err(Fail::msg("stored geometry decoded to an empty shape"));
    }
    Ok(shape)
}

fn b64_value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Standard base64 with padding, whitespace skipped.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0;
    let mut padding = false;
    for c in text.bytes() {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == b'=' {
            padding = true;
            continue;
        }
        if padding {
            return None;
        }
        acc = (acc << 6) | b64_value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// `_brep_b64_to_shape`: the pre-v5 inline ASCII BREP.
pub fn brep_b64_to_shape(b64: &str) -> FResult<Shape> {
    let data = base64_decode(b64).ok_or_else(|| Fail::Internal("Error".into()))?;
    if data.len() > MAX_BREP_BYTES {
        return Err(Fail::msg("embedded BREP payload too large to import"));
    }
    if !has_magic(&data, BREP_MAGIC) {
        return Err(Fail::msg("embedded payload is not a valid BREP (bad header)"));
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let path = std::env::temp_dir().join(format!(
        "fundacad-{}-{nonce:x}.brep",
        std::process::id()
    ));
    std::fs::write(&path, &data).map_err(|_| Fail::Internal("OSError".into()))?;
    let read = Shape::read_brep_text(&path);
    let _ = std::fs::remove_file(&path);
    read.map_err(|_| Fail::Internal("Standard_Failure".into()))
}

/// `_import_shape`: the blob named by `geom`, else the inline copy.
fn import_shape(f: &Import) -> FResult<Shape> {
    let b64 = f.brep.as_deref().filter(|s| !s.is_empty());
    if let Some(digest) = f.geom.as_deref().filter(|s| !s.is_empty()) {
        let data = BlobStore::open(blobstore::default_root())
            .ok()
            .and_then(|store| store.get_bytes(digest));
        if let Some(data) = data {
            return blob_to_shape(&data);
        }
        if b64.is_none() {
            return Err(Fail::msg(
                "the geometry for this imported body is missing from local storage. \
                 Open the .funda file it was saved in, or re-import the original file.",
            ));
        }
        eprintln!("[blobstore] blob {digest} missing; falling back to the embedded BREP");
    }
    match b64 {
        Some(b64) => brep_b64_to_shape(b64),
        None => Err(Fail::msg("this imported body has no geometry attached")),
    }
}

/// `_assembly_root_index`: the first node without a parent.
fn root_index(nodes: &[ImportNode]) -> Option<usize> {
    nodes
        .iter()
        .position(|n| matches!(n.parent, None | Some(None)))
}

fn non_empty<T>(v: &Option<Option<Vec<T>>>) -> Option<&[T]> {
    v.as_ref()
        .and_then(Option::as_ref)
        .map(Vec::as_slice)
        .filter(|s| !s.is_empty())
}

/// `_bind_assembly`: false, with the reason recorded, when the manifest and
/// the geometry disagree.
fn bind_assembly(
    ctx: &mut Ctx,
    f: &Import,
    shape: &Shape,
    nodes: &[ImportNode],
    parts: &[ImportPart],
) -> bool {
    let children = kernel::children(shape);
    if children.len() != parts.len() {
        ctx.skip_feature(
            &f.id,
            "import",
            &format!(
                "assembly manifest lists {} parts but the stored geometry has {} top-level shapes, falling back to unnamed bodies",
                parts.len(),
                children.len()
            ),
        );
        return false;
    }
    let mut bound = Vec::with_capacity(parts.len());
    for (i, (child, part)) in children.into_iter().zip(parts).enumerate() {
        let node = part
            .node
            .as_i64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|&n| n < nodes.len());
        let Some(node) = node.filter(|_| !kernel::is_null(&child)) else {
            ctx.skip_feature(
                &f.id,
                "import",
                &format!(
                    "assembly manifest entry {i} does not refer to a known part , falling back to unnamed bodies"
                ),
            );
            return false;
        };
        let faces = kernel::count(&child, Kind::Face);
        if part.faces.get() != faces as f64 {
            ctx.skip_feature(
                &f.id,
                "import",
                &format!(
                    "assembly part {i} expected {} faces but the stored geometry has {faces}, falling back to unnamed bodies",
                    crate::builder::py_g(part.faces.get())
                ),
            );
            return false;
        }
        bound.push((child, node, part));
    }
    let mut owned: HashMap<usize, usize> = HashMap::new();
    for (_, node, _) in &bound {
        *owned.entry(*node).or_default() += 1;
    }
    let mut seen: HashMap<usize, usize> = HashMap::new();
    for (child, node, part) in bound {
        let mut label = Some(nodes[node].name.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(base_name(f))
            .to_owned();
        if owned[&node] > 1 {
            let n = seen.entry(node).or_default();
            *n += 1;
            label = format!("{label} {n}");
        }
        let meta = ImportedMeta {
            node_ref: Some(format!("{}/{node}", f.id)),
            face_colors: part
                .face_colors
                .as_ref()
                .and_then(|c| serde_json::to_value(c).ok()),
            part_color: part.color.clone(),
            intact: false,
        };
        ctx.new_body_with(child, Some(label), None, meta);
    }
    true
}

fn base_name(f: &Import) -> &str {
    Some(f.name.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Imported")
}

pub fn handle(ctx: &mut Ctx, f: &Import) -> FResult {
    let shape = import_shape(f)?;
    let base = base_name(f).to_owned();
    let nodes = non_empty(&f.nodes);
    if f.explode == Some(false) {
        let root = nodes.and_then(|n| root_index(n).map(|r| (r, &n[r])));
        let (name, node_ref) = match root {
            Some((r, node)) => (
                Some(node.name.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&base)
                    .to_owned(),
                Some(format!("{}/{r}", f.id)),
            ),
            None => (base, None),
        };
        let meta = ImportedMeta {
            node_ref,
            intact: true,
            ..Default::default()
        };
        ctx.new_body_with(shape, Some(name), None, meta);
        return Ok(());
    }
    if let (Some(nodes), Some(parts)) = (nodes, non_empty(&f.parts)) {
        if bind_assembly(ctx, f, &shape, nodes, parts) {
            return Ok(());
        }
    }
    let parts = occ::explode_solids(&shape).map_err(|_| Fail::Internal("Standard_Failure".into()))?;
    if parts.len() == 1 {
        let only = parts.into_iter().next().unwrap_or(shape);
        ctx.new_body(only, Some(base), None);
    } else {
        for (n, p) in parts.into_iter().enumerate() {
            ctx.new_body(p, Some(format!("{base} {}", n + 1)), None);
        }
    }
    Ok(())
}

/// The `migrateGeometry` op, server.py `_migrate_geometry_job`: pre-v5 inline
/// base64 BREP moved into the blob store, reporting each item that failed.
pub fn migrate_geometry(items: &[Value], store: &BlobStore) -> Value {
    let mut out = Vec::new();
    let mut failed = Vec::new();
    for it in items {
        let id = it.get("id").cloned().unwrap_or(Value::Null);
        let converted = it
            .get("brep")
            .and_then(Value::as_str)
            .ok_or_else(|| "'brep'".to_owned())
            .and_then(|b64| brep_b64_to_shape(b64).map_err(|e| fail_text(&e)))
            .and_then(|shape| {
                xcaf::to_bin_v3(&shape)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| store.put_bytes(&bytes).map_err(|e| e.to_string()))
                    .map_err(|e| {
                        format!(
                            "could not store the imported geometry ({e}). Check free disk space and permissions on the FundaCAD data directory."
                        )
                    })
            });
        match converted {
            Ok(geom) => out.push(serde_json::json!({"id": id, "geom": geom})),
            Err(message) => failed.push(serde_json::json!({"id": id, "message": message})),
        }
    }
    serde_json::json!({"items": out, "failed": failed})
}

fn fail_text(f: &Fail) -> String {
    match f {
        Fail::Value { message, .. } => message.clone(),
        Fail::Missing(k) => format!("'{k}'"),
        Fail::Internal(name) => name.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_and_refuses_junk() {
        assert_eq!(base64_decode("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64_decode("aGVs\nbG8h").as_deref(), Some(&b"hello!"[..]));
        assert!(base64_decode("a$b=").is_none());
    }

    #[test]
    fn magic_skips_the_leading_newline() {
        assert!(has_magic(b"\nCASCADE Topology V1", BREP_MAGIC));
        assert!(!has_magic(b"garbage", BREP_MAGIC));
    }
}
