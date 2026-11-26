//! Bringing one FundaCAD document into another as geometry, not features: the source's selectors name bodies by
//! its own build order, which the host numbers differently. Append copies once, link also keeps the source path
//! and a fingerprint so the body can refresh when that file changes.

use serde_json::{json, Map, Value};

use crate::{doc, Answer, Client, Refused};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertMode {
    Append,
    Link,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: f64,
}

/// What a stat of a linked file found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LinkStat {
    Found(FileStat),
    Missing,
    Unknown,
}

pub fn stat_file(path: &str) -> LinkStat {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime_ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64);
            match mtime_ms {
                Some(mtime_ms) => LinkStat::Found(FileStat { size: m.len(), mtime_ms }),
                None => LinkStat::Unknown,
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LinkStat::Missing,
        Err(_) => LinkStat::Unknown,
    }
}

/// A source document already read. `stat` is taken before the read, so a change made during it still shows as
/// stale on the next open.
pub struct Source<'a> {
    pub path: &'a str,
    pub text: &'a str,
    pub stat: LinkStat,
}

/// FundaCAD 1's contentHash: two 32-bit mixes over UTF-16 units and the length. Tells versions apart, it is not a
/// security digest.
pub fn document_stamp(text: &str) -> String {
    let (mut a, mut b, mut len) = (0x811c_9dc5_u32, 0x0100_0193_u32, 0_usize);
    for c in text.encode_utf16() {
        let c = u32::from(c);
        a = (a ^ c).wrapping_mul(0x0100_0193);
        b = b.wrapping_add(c).wrapping_mul(0x5bd1_e995).rotate_left(13);
        len += 1;
    }
    format!("{a:08x}{b:08x}{len:x}")
}

pub fn base_name(path: &str) -> String {
    let file = super::files::base_name(path);
    let stem = match file.rfind('.') {
        Some(i) if i + 1 < file.len() => &file[..i],
        _ => file,
    };
    if stem.is_empty() {
        "Document".into()
    } else {
        stem.into()
    }
}

fn link_of(source: &Source<'_>) -> Value {
    let mut l = Map::new();
    l.insert("path".into(), json!(source.path));
    l.insert("stamp".into(), json!(document_stamp(source.text)));
    if let LinkStat::Found(s) = source.stat {
        l.insert("size".into(), json!(s.size));
        l.insert("mtime".into(), json!(s.mtime_ms));
    }
    Value::Object(l)
}

/// The document the source would build: its features up to its own rollback, without what it suppresses, with
/// its own body visibility.
pub fn buildable_source(text: &str) -> Result<Map<String, Value>, String> {
    let parsed: Map<String, Value> = match serde_json::from_str(text) {
        Ok(Value::Object(m)) => m,
        Ok(_) => return Err("it is not a document".into()),
        Err(e) => return Err(e.to_string()),
    };
    let built = doc::built(&parsed);
    let mut out = Map::new();
    out.insert("parameters".into(), built.get("parameters").cloned().unwrap_or(json!({})));
    out.insert("features".into(), built.get("features").cloned().unwrap_or(json!([])));
    if let Some(v) = built.get("bodyVisibility").filter(|v| v.as_object().is_some_and(|m| !m.is_empty())) {
        out.insert("bodyVisibility".into(), v.clone());
    }
    Ok(out)
}

/// Why an insert gave nothing, by the step that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertError {
    Read(String),
    Empty,
    Build(Refused),
    ReadBack(Refused),
    NotLinked,
}

impl InsertError {
    pub fn cancelled(&self) -> bool {
        matches!(self, InsertError::Build(r) | InsertError::ReadBack(r) if r.cancelled)
    }
}

/// Builds the source on its own, writes it to `temp_path` as STEP and reads that back as geometry. `stop` is
/// checked between the two requests, the engine only cancels one in flight. The caller deletes `temp_path`, a
/// different path the engine wrote to is deleted here.
pub fn bake(
    client: &Client,
    source: &Source<'_>,
    temp_path: &str,
    stop: impl Fn() -> bool,
) -> Result<Map<String, Value>, InsertError> {
    let doc = buildable_source(source.text).map_err(InsertError::Read)?;
    if doc.get("features").and_then(Value::as_array).is_none_or(Vec::is_empty) {
        return Err(InsertError::Empty);
    }
    let mut req = Map::new();
    req.insert("document".into(), Value::Object(doc));
    req.insert("format".into(), json!("step"));
    req.insert("path".into(), json!(temp_path));
    let exported = client.request("export", req).map_err(InsertError::Build)?;
    let written = exported.get("path").and_then(Value::as_str).unwrap_or(temp_path);
    let read: Answer = if stop() {
        Err(Refused { message: "cancelled".into(), cancelled: true })
    } else {
        client.request("import", super::import::import_fields(written, "step", None))
    };
    if written != temp_path {
        let _ = std::fs::remove_file(written);
    }
    read.map_err(InsertError::ReadBack)
}

fn geometry_fields(baked: &Map<String, Value>, f: &mut Map<String, Value>) {
    f.insert("geom".into(), baked.get("geom").cloned().unwrap_or(Value::Null));
    f.insert("solid".into(), baked.get("solid").cloned().unwrap_or(json!(true)));
    for k in ["nodes", "parts"] {
        if let Some(v) = baked.get(k) {
            f.insert(k.into(), v.clone());
        }
    }
}

/// The `import` feature an insert adds at the end of the history.
pub fn insert_feature(id: &str, source: &Source<'_>, mode: InsertMode, baked: &Map<String, Value>) -> Value {
    let mut f = Map::new();
    f.insert("id".into(), json!(id));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("step"));
    f.insert("name".into(), json!(base_name(source.path)));
    f.insert("source".into(), json!(source.path));
    geometry_fields(baked, &mut f);
    if mode == InsertMode::Link {
        f.insert("link".into(), link_of(source));
    }
    Value::Object(f)
}

/// Replaces a linked body's geometry and link in place, so everything built on it rebuilds against the new one.
pub fn refresh_link(
    doc: &mut Map<String, Value>,
    feature_id: &str,
    source: &Source<'_>,
    baked: &Map<String, Value>,
) -> Result<(), InsertError> {
    let f = doc
        .get_mut("features")
        .and_then(Value::as_array_mut)
        .and_then(|fs| fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(feature_id)))
        .and_then(Value::as_object_mut)
        .filter(|f| f.get("type").and_then(Value::as_str) == Some("import") && f.contains_key("link"))
        .ok_or(InsertError::NotLinked)?;
    geometry_fields(baked, f);
    f.insert("link".into(), link_of(source));
    Ok(())
}

/// Keeps the geometry and forgets the file, the body becomes an ordinary import.
pub fn unlink(doc: &mut Map<String, Value>, feature_id: &str) {
    let found = doc
        .get_mut("features")
        .and_then(Value::as_array_mut)
        .and_then(|fs| fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(feature_id)))
        .and_then(Value::as_object_mut);
    if let Some(f) = found {
        f.remove("link");
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StaleLinks {
    pub changed: Vec<String>,
    pub missing: Vec<String>,
    pub unknown: Vec<String>,
}

/// Linked imports whose file no longer matches the size and time stored when it was read, never reading the file.
/// A link stored without them, a file the stat could not tell about, or a new time on the same size (a copy or a
/// checkout keeps the content) is unknown until the user updates it.
pub fn stale_links(doc: &Map<String, Value>, stat: impl Fn(&str) -> LinkStat) -> StaleLinks {
    let mut out = StaleLinks::default();
    let features = doc.get("features").and_then(Value::as_array).into_iter().flatten();
    for f in features.filter(|f| f.get("type").and_then(Value::as_str) == Some("import")) {
        let (Some(id), Some(link)) = (f.get("id").and_then(Value::as_str), f.get("link")) else { continue };
        let Some(path) = link.get("path").and_then(Value::as_str) else { continue };
        let size = link.get("size").and_then(Value::as_f64);
        let mtime = link.get("mtime").and_then(Value::as_f64);
        let bucket = match (stat(path), size, mtime) {
            (LinkStat::Missing, _, _) => &mut out.missing,
            (LinkStat::Found(now), Some(size), Some(mtime)) => {
                if now.size as f64 != size {
                    &mut out.changed
                } else if now.mtime_ms != mtime {
                    &mut out.unknown
                } else {
                    continue;
                }
            }
            _ => &mut out.unknown,
        };
        bucket.push(id.to_owned());
    }
    out
}

/// Whether two paths name the same file as far as the text says, which refuses inserting a document into itself.
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").to_lowercase();
    norm(a) == norm(b)
}
