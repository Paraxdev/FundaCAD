//! A document's versions and branches without opening it: the rows of its
//! `versions` key, never what a version holds (`objects`) and never the geometry.
//! A `.fundab` costs its document section, a `.funda` one streaming parse that
//! skips every other key without building it.

use crate::fnda::{self, KIND_DOCUMENT};
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufReader, Read};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionRow {
    pub id: String,
    pub parent: Option<String>,
    pub branch: String,
    pub message: String,
    pub time: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Summary {
    pub format: &'static str,
    pub versions: Vec<VersionRow>,
    /// Branch name to its newest version id.
    pub branches: BTreeMap<String, String>,
    pub current: String,
}

#[derive(Deserialize)]
struct Head {
    #[serde(default)]
    versions: Option<RawRepo>,
}

#[derive(Deserialize)]
struct RawRepo {
    #[serde(default)]
    versions: Vec<Lenient<RawRow>>,
    #[serde(default)]
    branches: BTreeMap<String, Lenient<String>>,
    #[serde(default)]
    current: Lenient<String>,
}

#[derive(Deserialize)]
struct RawRow {
    id: String,
    #[serde(default)]
    parent: Option<String>,
    branch: String,
    #[serde(default)]
    message: Lenient<String>,
    #[serde(default)]
    time: Lenient<f64>,
    #[allow(dead_code)]
    tree: RawTree,
}

#[derive(Deserialize)]
struct RawTree {
    #[allow(dead_code)]
    features: Vec<IgnoredAny>,
    #[allow(dead_code)]
    rest: String,
}

/// A value of the wrong shape is dropped, as the app's own reader drops it.
#[derive(Deserialize)]
#[serde(untagged)]
enum Lenient<T> {
    Ok(T),
    Bad(IgnoredAny),
}

impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Lenient::Bad(IgnoredAny)
    }
}

impl<T> Lenient<T> {
    fn ok(self) -> Option<T> {
        match self {
            Lenient::Ok(v) => Some(v),
            Lenient::Bad(_) => None,
        }
    }
}

const MAIN_BRANCH: &str = "main";

fn summarise(format: &'static str, head: Head) -> Summary {
    let Some(repo) = head.versions else {
        return Summary { format, versions: vec![], branches: BTreeMap::new(), current: MAIN_BRANCH.into() };
    };
    let versions: Vec<VersionRow> = repo
        .versions
        .into_iter()
        .filter_map(Lenient::ok)
        .map(|r| VersionRow {
            id: r.id,
            parent: r.parent,
            branch: r.branch,
            message: r.message.ok().unwrap_or_default(),
            time: r.time.ok().unwrap_or(0.0),
        })
        .collect();
    let branches: BTreeMap<String, String> = repo
        .branches
        .into_iter()
        .filter_map(|(name, id)| id.ok().map(|id| (name, id)))
        .filter(|(_, id)| versions.iter().any(|v| &v.id == id))
        .collect();
    let current = repo
        .current
        .ok()
        .filter(|c| branches.contains_key(c))
        .or_else(|| branches.keys().next().cloned())
        .unwrap_or_else(|| MAIN_BRANCH.into());
    Summary { format, versions, branches, current }
}

fn damaged(e: impl std::fmt::Display) -> String {
    format!("the document could not be read: {e}")
}

/// None for a file this cannot summarise cheaply, the old ZIP container.
pub fn read_summary(path: &Path) -> Result<Option<Summary>, String> {
    let mut file = std::fs::File::open(path).map_err(damaged)?;
    let mut magic = [0u8; 8];
    let n = file.read(&mut magic).map_err(damaged)?;
    if magic[..n].starts_with(b"PK") {
        return Ok(None);
    }
    if n == 8 && &magic == fnda::MAGIC {
        let Some(cbor) = fnda::read_section_of_kind(path, KIND_DOCUMENT)? else {
            return Err(damaged("it has no document section"));
        };
        let head: Head = ciborium::from_reader(cbor.as_slice()).map_err(damaged)?;
        return Ok(Some(summarise("fundab", head)));
    }
    drop(file);
    let reader = BufReader::new(std::fs::File::open(path).map_err(damaged)?);
    let head: Head = serde_json::from_reader(reader).map_err(damaged)?;
    Ok(Some(summarise("funda", head)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fnda::{document_sections, hex, json_to_cbor, write};

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let mut b = [0u8; 8];
        getrandom::getrandom(&mut b).unwrap();
        let d = std::env::temp_dir().join(format!("fundacad_summary_{tag}_{}", hex(&b)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const DOC: &str = r#"{
      "version": 10,
      "features": [{ "id": "f1", "type": "box" }],
      "versions": {
        "objects": { "h1": "{\"id\":\"f1\"}", "r1": "{}" },
        "versions": [
          { "id": "v1", "parent": null, "branch": "main", "message": "First", "time": 100, "tree": { "features": ["h1"], "rest": "r1" } },
          { "id": "v2", "parent": "v1", "branch": "main", "message": "Second", "time": 200, "tree": { "features": [], "rest": "r1" } },
          { "id": "v3", "parent": "v1", "branch": "wide", "message": "Wider", "time": 300, "tree": { "features": ["h1"], "rest": "r1" } },
          { "id": 7, "branch": "main" },
          { "id": "v9", "branch": "main" }
        ],
        "branches": { "main": "v2", "wide": "v3", "gone": "v8", "bad": 5 },
        "current": "wide"
      }
    }"#;

    fn want(format: &'static str) -> Summary {
        let row = |id: &str, parent: Option<&str>, branch: &str, message: &str, time: f64| VersionRow {
            id: id.into(),
            parent: parent.map(Into::into),
            branch: branch.into(),
            message: message.into(),
            time,
        };
        Summary {
            format,
            versions: vec![
                row("v1", None, "main", "First", 100.0),
                row("v2", Some("v1"), "main", "Second", 200.0),
                row("v3", Some("v1"), "wide", "Wider", 300.0),
            ],
            branches: BTreeMap::from([("main".into(), "v2".into()), ("wide".into(), "v3".into())]),
            current: "wide".into(),
        }
    }

    /// The document with a large geometry map after it, as the app writes an import.
    fn with_geometry(doc: &str) -> String {
        let blob = "QUJD".repeat(250_000);
        format!("{},\n  \"geometry\": {{ \"{}\": \"{blob}\" }}\n}}", doc.trim_end().trim_end_matches('}'), "0".repeat(32))
    }

    #[test]
    fn a_json_document_and_a_binary_one_give_the_same_rows() {
        let dir = tmpdir("both");
        let json = dir.join("part.funda");
        std::fs::write(&json, with_geometry(DOC)).unwrap();
        assert_eq!(read_summary(&json).unwrap(), Some(want("funda")));

        let blob = dir.join("blob.bin");
        let geometry: Vec<u8> = (0..400_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        std::fs::write(&blob, &geometry).unwrap();
        let hash = {
            use blake2::{digest::consts::U16, Blake2b, Digest};
            hex(&Blake2b::<U16>::digest(&geometry))
        };
        let blobs = BTreeMap::from([(hash, blob)]);
        let info = json_to_cbor(r#"{"app":"test"}"#).unwrap();
        let cbor = json_to_cbor(DOC).unwrap();
        let bin = dir.join("part.fundab");
        let mut file = std::fs::File::create(&bin).unwrap();
        write(&mut file, &document_sections(&info, &cbor, &blobs, &BTreeMap::new())).unwrap();
        drop(file);
        assert_eq!(read_summary(&bin).unwrap(), Some(want("fundab")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_document_without_history_has_no_rows() {
        let dir = tmpdir("none");
        let path = dir.join("plain.funda");
        std::fs::write(&path, r#"{ "version": 10, "features": [] }"#).unwrap();
        let s = read_summary(&path).unwrap().unwrap();
        assert!(s.versions.is_empty() && s.branches.is_empty());
        assert_eq!(s.current, "main");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_old_zip_container_is_not_summarised() {
        let dir = tmpdir("zip");
        let path = dir.join("old.funda");
        std::fs::write(&path, b"PK\x03\x04rest of a zip").unwrap();
        assert_eq!(read_summary(&path).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn garbage_and_a_missing_file_are_errors() {
        let dir = tmpdir("bad");
        let path = dir.join("bad.funda");
        std::fs::write(&path, b"not json at all").unwrap();
        assert!(read_summary(&path).is_err());
        assert!(read_summary(&dir.join("gone.funda")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn it_serialises_as_the_webview_reads_it() {
        let s = serde_json::to_value(want("funda")).unwrap();
        assert_eq!(s["versions"][1]["parent"], "v1");
        assert_eq!(s["branches"]["wide"], "v3");
        assert_eq!(s["current"], "wide");
        assert_eq!(s["format"], "funda");
    }
}
