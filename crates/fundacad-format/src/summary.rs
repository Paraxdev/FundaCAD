//! A document's versions and branches without opening it, never the objects or the geometry: a `.fundab` costs its
//! document section, a `.funda` one streaming parse that skips every other key.

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
    versions: Lenient<RawRepo>,
}

#[derive(Deserialize)]
struct RawRepo {
    #[serde(default)]
    versions: Lenient<Vec<Lenient<RawRow>>>,
    #[serde(default)]
    branches: Lenient<Pairs>,
    #[serde(default)]
    current: Lenient<String>,
}

/// A map read in file order, which the app's fallback branch depends on.
struct Pairs(Vec<(String, Lenient<String>)>);

impl<'de> Deserialize<'de> for Pairs {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Pairs;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a map")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<Pairs, A::Error> {
                let mut out = Vec::new();
                while let Some(pair) = m.next_entry()? {
                    out.push(pair);
                }
                Ok(Pairs(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// The first of `names` in the order a JavaScript object lists its keys: whole
/// number keys first, smallest first, then the rest as written.
fn first_js_key<'a>(names: impl Iterator<Item = &'a String>) -> Option<&'a String> {
    let index = |k: &str| k.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == k);
    let names: Vec<&String> = names.collect();
    names.iter().filter_map(|k| index(k).map(|n| (n, *k))).min().map(|(_, k)| k).or_else(|| names.first().copied())
}

#[derive(Deserialize)]
struct RawRow {
    id: String,
    #[serde(default)]
    parent: Lenient<String>,
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
    let Some(repo) = head.versions.ok() else {
        return Summary { format, versions: vec![], branches: BTreeMap::new(), current: MAIN_BRANCH.into() };
    };
    let versions: Vec<VersionRow> = repo
        .versions
        .ok()
        .unwrap_or_default()
        .into_iter()
        .filter_map(Lenient::ok)
        .map(|r| VersionRow {
            id: r.id,
            parent: r.parent.ok(),
            branch: r.branch,
            message: r.message.ok().unwrap_or_default(),
            time: r.time.ok().unwrap_or(0.0),
        })
        .collect();
    let pairs: Vec<(String, String)> = repo
        .branches
        .ok()
        .map(|p| p.0)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, id)| id.ok().map(|id| (name, id)))
        .filter(|(_, id)| versions.iter().any(|v| &v.id == id))
        .collect();
    let first = first_js_key(pairs.iter().map(|(name, _)| name)).cloned();
    let branches: BTreeMap<String, String> = pairs.into_iter().collect();
    let current =
        repo.current.ok().filter(|c| branches.contains_key(c)).or(first).unwrap_or_else(|| MAIN_BRANCH.into());
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
