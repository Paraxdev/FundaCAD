//! FundaCAD document files on disk, in either format. A port of
//! the Python MCP server's `docfile.py`.
//!
//! `.funda` is pretty JSON, `.fundab` is the binary format 2
//! (docs/FUNDA-FORMAT.md), and a reader decides by the first bytes, never the
//! name. Imported geometry is not part of the document object: a JSON file
//! carries it in a trailing `geometry` map, a binary file in sections, and both
//! land in the blob store the engine builds from, each blob published only once
//! its bytes prove its hash.
//!
//! Writing the binary format needs Reed-Solomon parity that only the app
//! computes, so a `.fundab` save here is refused with the way round it rather
//! than written without its error correction.

use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use blake2::digest::{Update, VariableOutput};
use serde_json::{Map, Value};

pub const BINARY_EXT: &str = "fundab";
pub const GEOMETRY_KEY: &str = "geometry";
const MAGIC: &[u8; 8] = b"FUNDACAD";
const TAIL_MAGIC: &[u8; 8] = b"FNDATAIL";
const KIND_DOCUMENT: u8 = 1;
const KIND_GEOMETRY: u8 = 2;
const MAX_TOTAL: u64 = 8 << 30;

#[derive(Debug, Clone)]
pub struct DocumentFileError(pub String);

impl std::fmt::Display for DocumentFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DocumentFileError {}

fn fail<T>(message: impl Into<String>) -> Result<T, DocumentFileError> {
    Err(DocumentFileError(message.into()))
}

/// The store the engine reads, as `link` hands it over.
pub fn blob_dir() -> PathBuf {
    crate::link::appenv("BLOB_DIR")
        .filter(|v| !v.is_empty())
        .map_or_else(
            || crate::app_session::app_data_dir().join("blobs"),
            PathBuf::from,
        )
}

pub fn is_binary_path(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.to_string_lossy().to_ascii_lowercase() == BINARY_EXT)
}

fn hash(data: &[u8]) -> String {
    let mut h = blake2::Blake2bVar::new(16).expect("16 is a legal blake2b length");
    h.update(data);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).expect("16 byte digest");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hash(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn publish(root: &Path, digest: &str, data: &[u8]) -> Result<(), DocumentFileError> {
    if hash(data) != digest {
        return fail(
            "this document's geometry does not match its hash, the file is damaged or was modified",
        );
    }
    if std::fs::create_dir_all(root).is_err() {
        return fail(format!("cannot write the blob store at {}", root.display()));
    }
    let dest = root.join(format!("{digest}.bbrep"));
    if dest.exists() {
        return Ok(());
    }
    let tmp = root.join(format!("{digest}.bbrep.tmp-{}", std::process::id()));
    if std::fs::write(&tmp, data).is_err() || std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return fail(format!("cannot write {}", dest.display()));
    }
    Ok(())
}

/// The document object, and how many geometry blobs were published.
pub fn read(path: &Path, root: Option<&Path>) -> Result<(Map<String, Value>, usize), DocumentFileError> {
    let root = root.map_or_else(blob_dir, Path::to_path_buf);
    let Ok(raw) = std::fs::read(path) else {
        return fail(format!("No such file: {}", path.display()));
    };
    let tail_is_magic = raw.len() >= 64 && &raw[raw.len() - 64..raw.len() - 56] == TAIL_MAGIC;
    let (doc, blobs) = if raw.starts_with(MAGIC) || tail_is_magic {
        read_fnda(&raw)?
    } else if raw.starts_with(b"PK") {
        read_zip(path)?
    } else {
        read_json(path, &raw)?
    };
    let Value::Object(doc) = doc else {
        return fail(format!(
            "{} is not a FundaCAD document (no `features`).",
            path.display()
        ));
    };
    if !doc.contains_key("features") {
        return fail(format!(
            "{} is not a FundaCAD document (no `features`).",
            path.display()
        ));
    }
    for (digest, data) in &blobs {
        publish(&root, digest, data)?;
    }
    Ok((doc, blobs.len()))
}

fn read_json(path: &Path, raw: &[u8]) -> Result<(Value, Vec<(String, Vec<u8>)>), DocumentFileError> {
    let text = match std::str::from_utf8(raw) {
        Ok(t) => t,
        Err(e) => {
            return fail(format!(
                "{} is not a FundaCAD document: {e}",
                path.display()
            ))
        }
    };
    let mut doc: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            return fail(format!(
                "{} is not a FundaCAD document: {e}",
                path.display()
            ))
        }
    };
    let mut blobs = Vec::new();
    if let Some(geometry) = doc
        .as_object_mut()
        .and_then(|o| o.remove(GEOMETRY_KEY))
        .filter(Value::is_object)
    {
        let mut total: u64 = 0;
        for (digest, b64) in geometry.as_object().expect("checked") {
            let Some(b64) = b64.as_str().filter(|_| is_hash(digest)) else {
                return fail("this document's embedded geometry is damaged");
            };
            total += (b64.len() / 4 * 3) as u64;
            if total > MAX_TOTAL {
                return fail("this document expands to more than 8 GiB and was refused");
            }
            match base64::engine::general_purpose::STANDARD.decode(b64) {
                Ok(data) => blobs.push((digest.clone(), data)),
                Err(_) => return fail("this document's embedded geometry is damaged"),
            }
        }
    }
    Ok((doc, blobs))
}

pub fn referenced_geometry(doc: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in doc
        .get("features")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        if f.get("type").and_then(Value::as_str) != Some("import") {
            continue;
        }
        let Some(geom) = f.get("geom").and_then(Value::as_str).filter(|g| is_hash(g)) else {
            continue;
        };
        if !out.iter().any(|g| g == geom) {
            out.push(geom.to_string());
        }
    }
    out
}

/// Write `doc` as JSON with its referenced geometry embedded. Returns the
/// number of blobs embedded.
pub fn write(
    path: &Path,
    doc: &Map<String, Value>,
    root: Option<&Path>,
) -> Result<usize, DocumentFileError> {
    if is_binary_path(path) {
        return fail(
            "a .fundab file carries error correction only the FundaCAD app writes. Save as \
             .funda here, then open it in FundaCAD and Save As .fundab.",
        );
    }
    let root = root.map_or_else(blob_dir, Path::to_path_buf);
    let mut body: Map<String, Value> = doc
        .iter()
        .filter(|(k, _)| k.as_str() != GEOMETRY_KEY)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let mut geometry = Map::new();
    let mut missing = 0;
    for digest in referenced_geometry(&body) {
        let p = root.join(format!("{digest}.bbrep"));
        match std::fs::read(&p) {
            Ok(data) => {
                geometry.insert(
                    digest,
                    Value::String(base64::engine::general_purpose::STANDARD.encode(data)),
                );
            }
            Err(_) => missing += 1,
        }
    }
    if missing > 0 {
        return fail(format!(
            "{missing} imported bodies have no geometry in the blob store ({}), so saving was \
             stopped rather than writing a file that opens without them.",
            root.display()
        ));
    }
    let embedded = geometry.len();
    if embedded > 0 {
        body.insert(GEOMETRY_KEY.into(), Value::Object(geometry));
    }
    let mut text = match serde_json::to_string_pretty(&Value::Object(body)) {
        Ok(t) => t,
        Err(e) => return fail(format!("the document could not be written: {e}")),
    };
    text.push('\n');
    let tmp = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension().map_or(String::new(), |e| e
            .to_string_lossy()
            .into_owned()),
        std::process::id()
    ));
    if std::fs::write(&tmp, text.as_bytes()).is_err() {
        return fail(format!("cannot write {}", path.display()));
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return fail(format!("cannot write {}", path.display()));
    }
    Ok(embedded)
}

// --- format 2, read without repair -------------------------------------------
// The data shards are the stored bytes, so concatenating them and checking each
// section's hash is a complete reader for an undamaged file (FUNDA-FORMAT.md,
// "Reading", last paragraph). A damaged one is reported, and the app repairs it.

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut n = [0u8; 8];
    n.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(n)
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn damaged<T>() -> Result<T, DocumentFileError> {
    fail("this .fundab file is damaged, open it in FundaCAD to repair it")
}

fn read_fnda(raw: &[u8]) -> Result<(Value, Vec<(String, Vec<u8>)>), DocumentFileError> {
    let mut table: Option<&[u8]> = None;
    let heads = [0usize, raw.len().saturating_sub(64)];
    for at in heads {
        if at + 64 > raw.len() {
            continue;
        }
        let head = &raw[at..at + 64];
        if &head[..8] != MAGIC && &head[..8] != TAIL_MAGIC {
            continue;
        }
        if crc32(&head[..56]) != u32_at(head, 56) {
            continue;
        }
        if u16_at(head, 8) > 2 {
            return fail("this document was written by a newer FundaCAD");
        }
        let (ta, tb, tl) = (
            u64_at(head, 16) as usize,
            u64_at(head, 24) as usize,
            u64_at(head, 32) as usize,
        );
        let crc = u32_at(head, 40);
        for off in [ta, tb] {
            if off + tl > raw.len() {
                continue;
            }
            let t = &raw[off..off + tl];
            if t.len() == tl && crc32(t) == crc && t.starts_with(b"FTBL") {
                table = Some(t);
                break;
            }
        }
        if table.is_some() {
            break;
        }
    }
    let Some(table) = table else {
        return damaged();
    };

    let mut doc: Option<Value> = None;
    let mut blobs = Vec::new();
    let count = u32_at(table, 4) as usize;
    let mut p = 8usize;
    for _ in 0..count {
        if p + 4 > table.len() {
            return damaged();
        }
        let kind = table[p];
        let codec = table[p + 1];
        let nl = u16_at(table, p + 2) as usize;
        p += 4;
        if p + nl + 24 + 16 + 8 > table.len() {
            return damaged();
        }
        let name = String::from_utf8_lossy(&table[p..p + nl]).into_owned();
        p += nl;
        let off = u64_at(table, p) as usize;
        let stored = u64_at(table, p + 8) as usize;
        let rawlen = u64_at(table, p + 16) as usize;
        p += 24;
        let digest: String = table[p..p + 16].iter().map(|b| format!("{b:02x}")).collect();
        p += 16;
        let shard = u32_at(table, p) as usize;
        let k = u16_at(table, p + 4) as usize;
        let m = u16_at(table, p + 6) as usize;
        p += 8;
        if kind != KIND_DOCUMENT && kind != KIND_GEOMETRY {
            continue;
        }
        if rawlen as u64 > MAX_TOTAL {
            return fail("this document expands to more than 8 GiB and was refused");
        }
        if shard == 0 || k == 0 {
            return damaged();
        }
        let groups = stored.div_ceil(shard * k);
        let mut data = Vec::with_capacity(stored);
        let mut q = off;
        for _ in 0..groups {
            let end = (q + shard * k).min(raw.len());
            if q < raw.len() {
                data.extend_from_slice(&raw[q..end]);
            }
            q += (k + m) * shard;
        }
        data.truncate(stored);
        let body = if codec == 1 {
            inflate_raw(&data).unwrap_or_default()
        } else {
            data
        };
        if body.len() != rawlen || hash(&body) != digest {
            return damaged();
        }
        if kind == KIND_DOCUMENT {
            doc = Some(cbor(&body)?);
        } else if name == digest {
            blobs.push((digest, body));
        }
    }
    match doc {
        Some(doc) => Ok((doc, blobs)),
        None => fail("this .fundab file has no document in it"),
    }
}

fn inflate_raw(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(data)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

fn read_zip(path: &Path) -> Result<(Value, Vec<(String, Vec<u8>)>), DocumentFileError> {
    let Ok(file) = std::fs::File::open(path) else {
        return fail(format!("No such file: {}", path.display()));
    };
    let Ok(mut z) = zip::ZipArchive::new(file) else {
        return fail(format!("{} is not a FundaCAD document.", path.display()));
    };
    let total: u64 = (0..z.len())
        .filter_map(|i| z.by_index_raw(i).ok().map(|e| e.size()))
        .sum();
    if total > MAX_TOTAL {
        return fail("this document expands to more than 8 GiB and was refused");
    }
    let manifest: Value = read_entry(&mut z, "manifest.json")
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let Some(doc) = read_entry(&mut z, "document.json").and_then(|b| serde_json::from_slice(&b).ok())
    else {
        return fail(format!(
            "{} is not a FundaCAD document (no `features`).",
            path.display()
        ));
    };
    let mut blobs = Vec::new();
    for row in manifest
        .get("blobs")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let (Some(h), Some(entry)) = (
            row.get("hash").and_then(Value::as_str),
            row.get("entry").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !is_hash(h) {
            continue;
        }
        if let Some(data) = read_entry(&mut z, entry) {
            blobs.push((h.to_string(), data));
        }
    }
    Ok((doc, blobs))
}

fn read_entry<R: Read + Seek>(z: &mut zip::ZipArchive<R>, name: &str) -> Option<Vec<u8>> {
    let mut entry = z.by_name(name).ok()?;
    let mut out = Vec::new();
    entry.read_to_end(&mut out).ok()?;
    Some(out)
}

// --- CBOR, enough of it to read a document -----------------------------------

fn cbor(b: &[u8]) -> Result<Value, DocumentFileError> {
    let (value, _) = cbor_item(b, 0)?;
    Ok(value)
}

fn bad_cbor<T>() -> Result<T, DocumentFileError> {
    fail("this .fundab file's document is not valid CBOR")
}

fn cbor_len(b: &[u8], p: usize, ai: u8) -> Result<(Option<u64>, usize), DocumentFileError> {
    Ok(match ai {
        0..=23 => (Some(u64::from(ai)), p),
        24 if p < b.len() => (Some(u64::from(b[p])), p + 1),
        25 if p + 2 <= b.len() => (Some(u64::from(u16::from_be_bytes([b[p], b[p + 1]]))), p + 2),
        26 if p + 4 <= b.len() => (
            Some(u64::from(u32::from_be_bytes([
                b[p],
                b[p + 1],
                b[p + 2],
                b[p + 3],
            ]))),
            p + 4,
        ),
        27 if p + 8 <= b.len() => {
            let mut n = [0u8; 8];
            n.copy_from_slice(&b[p..p + 8]);
            (Some(u64::from_be_bytes(n)), p + 8)
        }
        31 => (None, p),
        _ => return bad_cbor(),
    })
}

fn cbor_item(b: &[u8], mut p: usize) -> Result<(Value, usize), DocumentFileError> {
    if p >= b.len() {
        return bad_cbor();
    }
    let ib = b[p];
    p += 1;
    let (major, ai) = (ib >> 5, ib & 31);
    if major == 7 {
        return Ok(match ai {
            20 => (Value::Bool(false), p),
            21 => (Value::Bool(true), p),
            22 | 23 => (Value::Null, p),
            25 if p + 2 <= b.len() => (number(f16(u16::from_be_bytes([b[p], b[p + 1]]))), p + 2),
            26 if p + 4 <= b.len() => (
                number(f64::from(f32::from_be_bytes([
                    b[p],
                    b[p + 1],
                    b[p + 2],
                    b[p + 3],
                ]))),
                p + 4,
            ),
            27 if p + 8 <= b.len() => {
                let mut n = [0u8; 8];
                n.copy_from_slice(&b[p..p + 8]);
                (number(f64::from_be_bytes(n)), p + 8)
            }
            _ => return bad_cbor(),
        });
    }
    let (n, mut p) = cbor_len(b, p, ai)?;
    match major {
        0 => Ok((Value::from(n.unwrap_or(0)), p)),
        1 => Ok((Value::from(-1i64 - n.unwrap_or(0) as i64), p)),
        2 | 3 => {
            let mut parts: Vec<u8> = Vec::new();
            match n {
                None => {
                    while p < b.len() && b[p] != 0xFF {
                        let (part, next) = cbor_item(b, p)?;
                        p = next;
                        match part {
                            Value::String(s) => parts.extend_from_slice(s.as_bytes()),
                            _ => return bad_cbor(),
                        }
                    }
                    p += 1;
                }
                Some(n) => {
                    let end = p + n as usize;
                    if end > b.len() {
                        return bad_cbor();
                    }
                    parts.extend_from_slice(&b[p..end]);
                    p = end;
                }
            }
            Ok((
                Value::String(String::from_utf8_lossy(&parts).into_owned()),
                p,
            ))
        }
        4 => {
            let mut out = Vec::new();
            loop {
                match n {
                    Some(n) if out.len() as u64 >= n => break,
                    None if p < b.len() && b[p] == 0xFF => break,
                    None if p >= b.len() => return bad_cbor(),
                    _ => {}
                }
                let (item, next) = cbor_item(b, p)?;
                out.push(item);
                p = next;
            }
            Ok((Value::Array(out), if n.is_some() { p } else { p + 1 }))
        }
        5 => {
            let mut out = Map::new();
            let mut i = 0u64;
            loop {
                match n {
                    Some(n) if i >= n => break,
                    None if p < b.len() && b[p] == 0xFF => break,
                    None if p >= b.len() => return bad_cbor(),
                    _ => {}
                }
                let (key, next) = cbor_item(b, p)?;
                let (value, next) = cbor_item(b, next)?;
                let key = match key {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                out.insert(key, value);
                p = next;
                i += 1;
            }
            Ok((Value::Object(out), if n.is_some() { p } else { p + 1 }))
        }
        // A tag: the tagged value is what matters here.
        _ => cbor_item(b, p),
    }
}

fn number(v: f64) -> Value {
    serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
}

fn f16(bits: u16) -> f64 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((bits >> 10) & 0x1F) as i32;
    let frac = f64::from(bits & 0x3FF);
    sign * match exp {
        0 => frac * 2f64.powi(-24),
        31 => {
            if frac == 0.0 {
                f64::INFINITY
            } else {
                f64::NAN
            }
        }
        _ => (frac / 1024.0 + 1.0) * 2f64.powi(exp - 15),
    }
}
