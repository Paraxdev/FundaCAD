//! A plugin's manifest.json, FundaCAD 1's format (src/plugins/manifest.ts): what it is, what it may touch and what the
//! engine runs for it.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

pub const KINDS: [&str; 4] = ["builtin", "process", "panel", "compute"];
pub const GRANTS: [&str; 12] = [
    "document.read",
    "document.write",
    "document.history",
    "geometry.build",
    "files.read",
    "files.write",
    "network",
    "network.local",
    "device.input",
    "input.remap",
    "ui.panel",
    "process.spawn",
];
const MAX_TRANSLATIONS: usize = 64;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Translation {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub summary: String,
    pub enabled_by_default: bool,
    pub grants: Vec<String>,
    pub hosts: Vec<String>,
    pub former_ids: Vec<String>,
    pub feature_types: Vec<String>,
    pub shape_generators: Vec<String>,
    pub exporters: Vec<String>,
    pub geometry_wasm: Option<String>,
    pub translations: BTreeMap<String, Translation>,
}

fn segment_ok(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.len() <= 31
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `Publisher.Name`: it is a directory name, so every segment starts with a letter and `.`, `..` cannot be spelled.
pub fn id_ok(id: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();
    (1..=2).contains(&parts.len()) && parts.iter().all(|p| segment_ok(p))
}

/// Case blind, as an id is a directory and Windows gives `A.B` and `a.b` the same one.
pub fn same_id(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn strings(v: &Value, key: &str) -> Result<Vec<String>, String> {
    match v.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => {
            a.iter().map(|x| x.as_str().map(str::to_owned).ok_or(format!("{key} holds a value that is not text"))).collect()
        }
        Some(_) => Err(format!("{key} is not a list")),
    }
}

/// A list of distinct texts that are not empty.
fn tokens(v: &Value, key: &str) -> Result<Vec<String>, String> {
    let list = strings(v, key)?;
    for (i, t) in list.iter().enumerate() {
        if t.is_empty() {
            return Err(format!("{key} holds an empty text"));
        }
        if list[..i].contains(t) {
            return Err(format!("{key} names {t:?} twice"));
        }
    }
    Ok(list)
}

fn host_ok(h: &str) -> bool {
    let labels: Vec<&str> = h.strip_prefix('.').unwrap_or(h).split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            let b = l.as_bytes();
            !b.is_empty()
                && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
                && b[0] != b'-'
                && b[b.len() - 1] != b'-'
        })
}

/// A bad entry is dropped, as FundaCAD 1 did, rather than refusing the plugin over its wording.
fn translations(v: Option<&Value>) -> BTreeMap<String, Translation> {
    let mut out = BTreeMap::new();
    let Some(Value::Object(m)) = v else { return out };
    for (code, entry) in m {
        if out.len() >= MAX_TRANSLATIONS {
            break;
        }
        let ok_code = !code.is_empty() && code.len() <= 16 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        let line = |k: &str| {
            entry
                .get(k)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty() && !s.contains(['\n', '\r']))
                .map(str::to_owned)
        };
        let t = Translation { name: line("name"), summary: line("summary") };
        if ok_code && (t.name.is_some() || t.summary.is_some()) {
            out.insert(code.clone(), t);
        }
    }
    out
}

fn text(v: &Value, key: &str) -> Result<String, String> {
    match v.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        Some(_) => Err(format!("{key} is not text")),
        None => Err(format!("it has no {key}")),
    }
}

impl Manifest {
    pub fn parse(json: &str) -> Result<Manifest, String> {
        let v: Value = serde_json::from_str(json.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
        if !v.is_object() {
            return Err("it is not a JSON object".into());
        }
        let id = text(&v, "id")?;
        if !id_ok(&id) {
            return Err(format!("{id:?} is not a plugin id, it reads Publisher.Name"));
        }
        let kind = text(&v, "kind")?;
        if !KINDS.contains(&kind.as_str()) {
            return Err(format!("{kind:?} is not a plugin kind"));
        }
        if !v.get("grants").is_some_and(Value::is_array) {
            return Err("grants is not a list".into());
        }
        let grants = tokens(&v, "grants")?;
        if let Some(g) = grants.iter().find(|g| !GRANTS.contains(&g.as_str())) {
            return Err(format!("{g:?} is not a grant"));
        }
        let enabled_by_default = match v.get("enabledByDefault") {
            None => true,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err("enabledByDefault is not true or false".into()),
        };
        let former_ids = tokens(&v, "formerIds")?;
        if former_ids.contains(&id) {
            return Err("formerIds names the plugin's own id".into());
        }
        let hosts = strings(&v, "hosts")?;
        if let Some(h) = hosts.iter().find(|h| !host_ok(h)) {
            return Err(format!("{h:?} is not a host name"));
        }
        let network = grants.iter().any(|g| g == "network");
        if network && hosts.is_empty() {
            return Err("it asks for network but names no hosts".into());
        }
        if !network && !hosts.is_empty() {
            return Err("it names hosts but does not ask for network".into());
        }
        Ok(Manifest {
            name: text(&v, "name")?,
            version: text(&v, "version")?,
            summary: v.get("summary").and_then(Value::as_str).unwrap_or_default().to_owned(),
            enabled_by_default,
            grants,
            hosts,
            former_ids,
            feature_types: tokens(&v, "featureTypes")?,
            shape_generators: strings(&v, "shapeGenerators")?,
            exporters: strings(&v, "exporters")?,
            geometry_wasm: v.get("geometryWasm").and_then(Value::as_str).map(str::to_owned),
            translations: translations(v.get("translations")),
            kind,
            id,
        })
    }

    /// The name in `lang`, English when it has none.
    #[allow(dead_code, reason = "the interface language of fc2/prefs picks it")]
    pub fn name_in(&self, lang: &str) -> &str {
        self.translations.get(lang).and_then(|t| t.name.as_deref()).unwrap_or(&self.name)
    }
}
