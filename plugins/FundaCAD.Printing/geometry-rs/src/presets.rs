//! print_presets.py: the person's active OrcaSlicer machine preset flattened
//! (its `inherits` chain resolved the way Orca does) with a compatible process
//! and filament, so a handed off project opens on their own machine. The
//! palette still owns the colours.
//!
//! The slicer's files are read through the host's `files` interface, which the
//! manifest's "files.read" grant opens.

use serde_json::{Map, Value};

use crate::fundacad::plugin::files;
use crate::py;

/// Preset fields that are per file metadata, not effective config, dropped
/// after the inherits chain is merged.
const META_KEYS: [&str; 10] = [
    "inherits",
    "from",
    "name",
    "setting_id",
    "filament_id",
    "renamed_from",
    "is_custom_defined",
    "version",
    "upward_compatible_machine",
    "instantiation",
];

/// A path the way `os.path.join` builds it on the machine the datadir names:
/// a drive letter or a backslash means Windows.
#[derive(Clone)]
struct PPath {
    full: String,
    /// The components below the datadir, for `is_user_preset`.
    rel: Vec<String>,
}

fn windows(p: &str) -> bool {
    p.contains('\\') || p.as_bytes().get(1) == Some(&b':')
}

fn join(base: &str, part: &str) -> String {
    if base.is_empty() {
        return part.to_string();
    }
    let sep = if windows(base) { '\\' } else { '/' };
    if base.ends_with('/') || (sep == '\\' && base.ends_with('\\')) {
        format!("{base}{part}")
    } else {
        format!("{base}{sep}{part}")
    }
}

impl PPath {
    fn child(&self, part: &str) -> PPath {
        let mut rel = self.rel.clone();
        rel.push(part.to_string());
        PPath {
            full: join(&self.full, part),
            rel,
        }
    }
}

/// `open(path)` then `json.load`, an OSError or a ValueError as its text.
fn read_json(path: &str) -> Result<Value, String> {
    let bytes = files::read(path)?;
    let text = String::from_utf8(bytes).map_err(|e| format!("'utf-8' codec can't decode: {e}"))?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn sorted_names(dir: &str) -> Option<Vec<(String, bool)>> {
    let mut names: Vec<(String, bool)> = files::list_dir(dir)
        .ok()?
        .into_iter()
        .map(|e| (e.name, e.is_dir))
        .collect();
    names.sort();
    Some(names)
}

/// name to path, in the order Python's dict keeps: the first sighting of a
/// name keeps its place, a later one (a user preset) replaces its path.
type Index = Vec<(String, PPath)>;

fn index_insert(idx: &mut Index, name: String, path: PPath) {
    if let Some(e) = idx.iter_mut().find(|(n, _)| *n == name) {
        e.1 = path;
    } else {
        idx.push((name, path));
    }
}

fn index_get<'a>(idx: &'a Index, name: &str) -> Option<&'a PPath> {
    idx.iter().find(|(n, _)| n == name).map(|(_, p)| p)
}

/// `index_presets`: system presets first, one level of vendor subfolders,
/// then user/default so a user preset shadows a same named system one.
fn index_presets(datadir: &PPath, kind: &str) -> Index {
    let mut dirs: Vec<PPath> = Vec::new();
    let sysroot = datadir.child("system");
    for (v, _) in sorted_names(&sysroot.full).unwrap_or_default() {
        let kd = sysroot.child(&v).child(kind);
        if files::is_dir(&kd.full) {
            dirs.push(kd.clone());
            for (sub, _) in sorted_names(&kd.full).unwrap_or_default() {
                let sd = kd.child(&sub);
                if files::is_dir(&sd.full) {
                    dirs.push(sd);
                }
            }
        }
    }
    dirs.push(datadir.child("user").child("default").child(kind));

    let mut idx: Index = Vec::new();
    for d in dirs {
        let Some(entries) = sorted_names(&d.full) else {
            continue;
        };
        for (fname, _) in entries {
            if !fname.ends_with(".json") {
                continue;
            }
            let path = d.child(&fname);
            let Ok(v) = read_json(&path.full) else {
                continue;
            };
            if let Some(Value::String(name)) = v.as_object().and_then(|o| o.get("name")) {
                index_insert(&mut idx, name.clone(), path);
            }
        }
    }
    idx
}

/// `resolve_chain`: one preset flattened along its `inherits` chain, root
/// first and the child overriding its parent, with the names in the chain.
fn resolve_chain(idx: &Index, name: &str) -> Result<(Map<String, Value>, Vec<String>), String> {
    let mut chain: Vec<Value> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut cur = Some(name.to_string());
    while let Some(c) = cur.take() {
        if names.contains(&c) {
            break;
        }
        names.push(c.clone());
        let Some(path) = index_get(idx, &c) else {
            return Err(format!("preset not found: {c}"));
        };
        let v = read_json(&path.full)?;
        cur = match v.as_object().and_then(|o| o.get("inherits")) {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        chain.push(v);
    }
    let mut out = Map::new();
    for v in chain.iter().rev() {
        if let Value::Object(o) = v {
            for (k, x) in o {
                out.insert(k.clone(), x.clone());
            }
        }
    }
    for k in META_KEYS {
        out.shift_remove(k);
    }
    Ok((out, names))
}

fn is_compatible(idx: &Index, name: &str, chain: &[String]) -> bool {
    let Ok((cfg, _)) = resolve_chain(idx, name) else {
        return false;
    };
    match cfg.get("compatible_printers") {
        Some(Value::Array(a)) => a.iter().any(|s| s.as_str().is_some_and(|s| chain.iter().any(|c| c == s))),
        _ => false,
    }
}

/// `pick_preset`: compatible with the machine, the person's own presets first,
/// then one whose name carries every hint, then alphabetical.
fn pick_preset(idx: &Index, chain: &[String], hints: &[&str]) -> Option<String> {
    let mut user = Vec::new();
    let mut system = Vec::new();
    for (name, path) in idx {
        if is_compatible(idx, name, chain) {
            if path.rel.iter().any(|c| c == "user") {
                user.push(name.clone());
            } else {
                system.push(name.clone());
            }
        }
    }
    user.sort();
    system.sort();
    for pool in [&user, &system] {
        if let Some(n) = pool.iter().find(|n| hints.iter().all(|h| n.contains(h))) {
            return Some(n.clone());
        }
        if let Some(first) = pool.first() {
            return Some(first.clone());
        }
    }
    None
}

/// `project_settings`: the ACTIVE machine preset with a compatible process and
/// filament, all flattened.
pub fn project_settings(
    datadir: Option<&Value>,
    filament_count: Option<&Value>,
) -> Result<Map<String, Value>, String> {
    let dd_text = datadir.filter(|v| py::truthy(Some(v))).map(py::str_of);
    let Some(dd_text) = dd_text.filter(|d| files::is_dir(d)) else {
        return Err(format!(
            "Orca datadir not found: {}",
            datadir.map_or_else(|| "None".to_string(), py::str_of)
        ));
    };
    let dd = PPath {
        full: dd_text,
        rel: Vec::new(),
    };
    let conf = read_json(&dd.child("OrcaSlicer.conf").full)?;
    let machine = conf
        .as_object()
        .and_then(|o| o.get("presets"))
        .filter(|p| py::truthy(Some(p)))
        .and_then(|p| p.get("machine"))
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .ok_or("no active machine preset in OrcaSlicer.conf")?
        .to_string();

    let m_idx = index_presets(&dd, "machine");
    let (mut cfg, chain) = resolve_chain(&m_idx, &machine)?;

    let p_idx = index_presets(&dd, "process");
    if let Some(proc_) = pick_preset(&p_idx, &chain, &["0.20"]) {
        if let Ok((pcfg, _)) = resolve_chain(&p_idx, &proc_) {
            for (k, v) in pcfg {
                cfg.insert(k, v);
            }
            cfg.insert("print_settings_id".into(), Value::String(proc_));
        }
    }

    let n = if py::truthy(filament_count) {
        filament_count
            .and_then(py::int_of)
            .ok_or_else(|| {
                format!(
                    "invalid literal for int() with base 10: {}",
                    py::repr_str(&filament_count.map(py::str_of).unwrap_or_default())
                )
            })?
            .max(1)
    } else {
        1
    };
    let f_idx = index_presets(&dd, "filament");
    if let Some(fil) = pick_preset(&f_idx, &chain, &["PLA"]) {
        if let Ok((fcfg, _)) = resolve_chain(&f_idx, &fil) {
            for (k, v) in fcfg {
                let one = match &v {
                    Value::Array(a) if !a.is_empty() => a[0].clone(),
                    other => other.clone(),
                };
                cfg.insert(k, Value::Array(vec![one; n as usize]));
            }
            cfg.insert(
                "filament_settings_id".into(),
                Value::Array(vec![Value::String(fil); n as usize]),
            );
        }
    }

    if !cfg.contains_key("printer_settings_id") {
        cfg.insert("printer_settings_id".into(), Value::String(machine));
    }
    cfg.shift_remove("filament_colour");
    cfg.shift_remove("compatible_printers");
    Ok(cfg)
}
