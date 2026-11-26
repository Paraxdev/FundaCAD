//! A plugin's manifest.json, FundaCAD 1's format (src/plugins/manifest.ts): what it is, what it may touch and what the
//! engine runs for it.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

pub const KINDS: [&str; 4] = ["builtin", "process", "panel", "compute"];
pub const GRANTS: [&str; 8] = [
    "document.read",
    "document.write",
    "geometry.build",
    "files.read",
    "files.write",
    "network",
    "devices.gamepad",
    "devices.hid",
];

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Translation {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub summary: String,
    pub enabled_by_default: bool,
    pub grants: Vec<String>,
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
        let grants = strings(&v, "grants")?;
        if let Some(g) = grants.iter().find(|g| !GRANTS.contains(&g.as_str())) {
            return Err(format!("{g:?} is not a grant"));
        }
        let enabled_by_default = match v.get("enabledByDefault") {
            None => true,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err("enabledByDefault is not true or false".into()),
        };
        let translations = match v.get("translations") {
            Some(t) => serde_json::from_value(t.clone()).map_err(|e| format!("translations: {e}"))?,
            None => BTreeMap::new(),
        };
        Ok(Manifest {
            name: text(&v, "name")?,
            version: text(&v, "version")?,
            summary: v.get("summary").and_then(Value::as_str).unwrap_or_default().to_owned(),
            enabled_by_default,
            grants,
            feature_types: strings(&v, "featureTypes")?,
            shape_generators: strings(&v, "shapeGenerators")?,
            exporters: strings(&v, "exporters")?,
            geometry_wasm: v.get("geometryWasm").and_then(Value::as_str).map(str::to_owned),
            translations,
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
