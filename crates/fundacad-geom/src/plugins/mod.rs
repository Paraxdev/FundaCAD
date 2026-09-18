//! The plugin host, replacing `sidecar/plugin_geometry.py` and
//! `sidecar/shape_generate.py` (docs/RUST-PIVOT.md 2.3).
//!
//! A plugin bundle's geometry is a WebAssembly component (the world in
//! `wit/plugin.wit`) named by the manifest's `geometryWasm`. Manifests are read
//! for every plugin on disk, so a document can name the plugin it needs while
//! that plugin is absent; a component is compiled the first time one of its
//! declared names is used. Each call runs in a fresh instance under a time
//! budget, a memory cap and a WASI context with no files, no network and no
//! environment.

mod host;
mod kernel_api;
mod kernel_ext;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use fundacad_engine::error_result;
use fundacad_protocol::{CancelToken, JobResult};
use serde_json::{json, Map, Value};

use crate::builder::{Ctx, FResult, Fail};

pub use crate::mesh::passes::FaceMesh;
pub use host::MeshData;
pub use kernel_ext::delaunay_2d as delaunay_planar;

pub const MANIFEST_WASM: &str = "geometryWasm";
pub const MANIFEST_TYPES: &str = "featureTypes";
pub const MANIFEST_EXPORTERS: &str = "exporters";
pub const MANIFEST_GENERATORS: &str = "shapeGenerators";

/// A feature is supervised per feature in Python (STALL_TIMEOUT).
pub const FEATURE_BUDGET: Duration = Duration::from_secs(60);
/// server.py gives `generateShape` 180 s.
pub const GENERATE_BUDGET: Duration = Duration::from_secs(180);
pub const EXPORT_BUDGET: Duration = Duration::from_secs(600);
pub const MESH_PASS_BUDGET: Duration = Duration::from_secs(60);
pub const MEMORY_LIMIT: usize = 1 << 30;

struct Declared {
    id: String,
    dir: PathBuf,
    wasm: Option<String>,
    types: Vec<String>,
    exporters: Vec<String>,
    generators: Vec<String>,
    files_read: bool,
}

enum Loaded {
    NotYet,
    Ready(Box<host::Component>),
    Broken(String),
}

struct Entry {
    declared: Declared,
    loaded: Loaded,
}

#[derive(Default)]
struct Registry {
    entries: Vec<Entry>,
    discovered: bool,
}

fn registry() -> MutexGuard<'static, Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Read every installed plugin's manifest, `plugin_geometry.discover`.
///
/// Explicit, and only the server startup path calls it, exactly as the Python
/// engine does: a bare `builder::rebuild` has no plugins at all and a feature
/// type nothing built in owns is "unknown feature type", the same sentence the
/// Python builder gives on its own. Idempotent.
pub fn load() {
    let mut reg = registry();
    if reg.discovered {
        return;
    }
    reg.discovered = true;
    reg.entries = discover()
        .into_iter()
        .map(|declared| Entry {
            declared,
            loaded: Loaded::NotYet,
        })
        .collect();
}

/// Drop everything loaded. Tests only.
pub fn reset_for_tests() {
    let mut reg = registry();
    reg.entries.clear();
    reg.discovered = false;
}

/// `plugin_roots`: FUNDACAD_PLUGIN_DIR, then a checkout's own plugins/.
pub fn plugin_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("FUNDACAD_PLUGIN_DIR").filter(|d| !d.is_empty()) {
        out.push(PathBuf::from(dir));
    }
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins");
        if !out.iter().any(|p| same_dir(p, &repo)) {
            out.push(repo);
        }
    }
    out.into_iter().filter(|d| d.is_dir()).collect()
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn strings(man: &Value, key: &str) -> Vec<String> {
    man.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn discover() -> Vec<Declared> {
    let mut out: Vec<Declared> = Vec::new();
    for root in plugin_roots() {
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        dirs.sort();
        for dir in dirs.into_iter().filter(|d| d.is_dir()) {
            let Some(man) = std::fs::read(dir.join("manifest.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            else {
                continue;
            };
            let id = man
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
            if out.iter().any(|d| d.id == id) {
                continue;
            }
            out.push(Declared {
                wasm: man.get(MANIFEST_WASM).and_then(Value::as_str).map(str::to_owned),
                types: strings(&man, MANIFEST_TYPES),
                exporters: strings(&man, MANIFEST_EXPORTERS),
                generators: strings(&man, MANIFEST_GENERATORS),
                files_read: strings(&man, "grants").iter().any(|g| g == "files.read"),
                id,
                dir,
            });
        }
    }
    out
}

#[derive(Clone, Copy)]
enum Claim {
    Feature,
    Exporter,
    Generator,
}

fn declares(d: &Declared, claim: Claim, name: &str) -> bool {
    let list = match claim {
        Claim::Feature => &d.types,
        Claim::Exporter => &d.exporters,
        Claim::Generator => &d.generators,
    };
    list.iter().any(|t| t == name)
}

/// The loaded component that claims `name`, or why there is none.
fn component_for(reg: &mut Registry, claim: Claim, name: &str) -> Result<usize, Missing> {
    let Some(i) = reg
        .entries
        .iter()
        .position(|e| declares(&e.declared, claim, name))
    else {
        return Err(Missing::Unknown);
    };
    let entry = &mut reg.entries[i];
    if matches!(entry.loaded, Loaded::NotYet) {
        entry.loaded = compile(&entry.declared);
    }
    match &entry.loaded {
        Loaded::Ready(c) => {
            let claimed = match claim {
                Claim::Feature => c.registration.features.iter().any(|t| t == name),
                Claim::Exporter => c.registration.exporters.iter().any(|t| t == name),
                Claim::Generator => c.registration.shape_generators.iter().any(|t| t == name),
            };
            if claimed {
                Ok(i)
            } else {
                Err(Missing::NotRegistered(entry.declared.id.clone()))
            }
        }
        Loaded::Broken(why) => Err(Missing::Broken(entry.declared.id.clone(), why.clone())),
        Loaded::NotYet => Err(Missing::Unknown),
    }
}

enum Missing {
    Unknown,
    Broken(String, String),
    NotRegistered(String),
}

fn compile(d: &Declared) -> Loaded {
    let Some(rel) = &d.wasm else {
        return Loaded::Broken(format!(
            "its manifest names no {MANIFEST_WASM}, so the Rust engine has no geometry to run"
        ));
    };
    let path = rel.split('/').fold(d.dir.clone(), |p, part| p.join(part));
    if !path.is_file() {
        return Loaded::Broken(format!(
            "its manifest names {rel:?}, which is not in the bundle"
        ));
    }
    match host::Component::load(&path, d.files_read) {
        Ok(c) => {
            let undeclared: Vec<&String> = c
                .registration
                .features
                .iter()
                .filter(|t| !d.types.contains(t))
                .chain(c.registration.exporters.iter().filter(|t| !d.exporters.contains(t)))
                .chain(
                    c.registration
                        .shape_generators
                        .iter()
                        .filter(|t| !d.generators.contains(t)),
                )
                .collect();
            if let Some(first) = undeclared.first() {
                return Loaded::Broken(format!(
                    "it registers {first:?}, which its manifest does not declare"
                ));
            }
            eprintln!("[plugin-geometry] {}: loaded {}", d.id, path.display());
            Loaded::Ready(Box::new(c))
        }
        Err(e) => {
            eprintln!("[plugin-geometry] {}: geometry did not load: {e}", d.id);
            Loaded::Broken(e)
        }
    }
}

fn missing_feature(type_name: &str, m: Missing) -> String {
    match m {
        Missing::Unknown => format!("unknown feature type: {type_name}"),
        Missing::Broken(owner, why) => format!(
            "this needs the \"{owner}\" plugin, which is installed but would not load: {why}"
        ),
        Missing::NotRegistered(owner) => format!(
            "this needs the \"{owner}\" plugin, which is not installed. The feature is kept in the document and will build again once it is."
        ),
    }
}

/// The feature type's plugin handler, run against `ctx`. `None` when no
/// plugin on disk declares the type.
pub fn run_feature(
    ctx: &mut Ctx,
    type_name: &str,
    raw: &Value,
    cancel: Option<CancelToken>,
) -> Option<FResult> {
    let mut reg = registry();
    let i = match component_for(&mut reg, Claim::Feature, type_name) {
        Ok(i) => i,
        Err(Missing::Unknown) => return None,
        Err(m) => return Some(Err(Fail::msg(missing_feature(type_name, m)))),
    };
    let Loaded::Ready(c) = &reg.entries[i].loaded else {
        return None;
    };
    Some(c.run_feature(ctx, type_name, raw, cancel).map_err(|(message, code)| Fail::Value { message, code }))
}

/// The `generateShape` op.
pub fn generate_shape_result(req: &Map<String, Value>, cancel: Option<CancelToken>) -> JobResult {
    match generate_shape(req, cancel) {
        Ok(m) => JobResult::Json(m),
        Err(e) => error_result(&e),
    }
}

fn generate_shape(req: &Map<String, Value>, cancel: Option<CancelToken>) -> Result<Map<String, Value>, String> {
    let name = req.get("generator").and_then(Value::as_str).unwrap_or("");
    let output = req.get("output").and_then(Value::as_str).unwrap_or("mesh");
    let params = req.get("params").filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
    let placement = req.get("placement").filter(|p| !p.is_null());
    let mut reg = registry();
    let i = component_for(&mut reg, Claim::Generator, name)
        .map_err(|_| format!("no plugin that is running offers the shape {}", host::py_repr(name)))?;
    if output != "mesh" && output != "store" {
        return Err(format!("unknown output {}, expected mesh or store", host::py_repr(output)));
    }
    let Loaded::Ready(c) = &reg.entries[i].loaded else {
        return Err(format!("no plugin that is running offers the shape {}", host::py_repr(name)));
    };
    let mut shape = c.generate_shape(name, &params, cancel)?;
    drop(reg);
    if let Some(p) = placement {
        shape = kernel_api::place_json(&shape, p)?;
    }
    kernel_api::generated_reply(&shape, output)
}

/// The `exportWith` op.
pub fn export_with_result(
    req: &Map<String, Value>,
    watch: &dyn crate::builder::Watch,
    cancel: Option<CancelToken>,
) -> JobResult {
    match kernel_api::export_with(req, watch, cancel) {
        Ok(m) => JobResult::Json(m),
        Err(e) => error_result(&e),
    }
}

fn exporter_call(
    exporter: &str,
    bodies: Vec<host::ExportMesh>,
    options: &Value,
    path: &Path,
    cancel: Option<CancelToken>,
) -> Result<Option<Value>, String> {
    let mut reg = registry();
    let i = match component_for(&mut reg, Claim::Exporter, exporter) {
        Ok(i) => i,
        Err(Missing::Unknown) => {
            return Err(format!("no installed plugin provides the {} export", host::py_repr(exporter)))
        }
        Err(Missing::Broken(owner, why)) => {
            return Err(format!("the {} export needs {owner}, which did not load: {why}", host::py_repr(exporter)))
        }
        Err(Missing::NotRegistered(owner)) => {
            return Err(format!(
                "the {} export needs {owner}, which did not load: it did not register it", host::py_repr(exporter)
            ))
        }
    };
    let Loaded::Ready(c) = &reg.entries[i].loaded else {
        return Err(format!("no installed plugin provides the {} export", host::py_repr(exporter)));
    };
    c.write_export(exporter, bodies, options, path, cancel)
        .map_err(|e| format!("{exporter}: {e}"))
}

/// Whether an exporter is declared by any plugin on disk, before the rebuild.
fn exporter_declared(exporter: &str) -> Result<(), String> {
    let mut reg = registry();
    match component_for(&mut reg, Claim::Exporter, exporter) {
        Ok(_) => Ok(()),
        Err(Missing::Unknown) => Err(format!("no installed plugin provides the {} export", host::py_repr(exporter))),
        Err(Missing::Broken(owner, why)) => {
            Err(format!("the {} export needs {owner}, which did not load: {why}", host::py_repr(exporter)))
        }
        Err(Missing::NotRegistered(owner)) => Err(format!(
            "the {} export needs {owner}, which did not load: it did not register it", host::py_repr(exporter)
        )),
    }
}

/// `plugin_geometry.cache_key`: every pass on a body with its code version,
/// `None` when it has none. A pass whose plugin is not loaded keys as -1.
pub fn pass_cache_key(specs: &[Value]) -> Option<String> {
    if specs.is_empty() {
        return None;
    }
    let mut versions: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut reg = registry();
    for spec in specs {
        let name = spec.get("pass").and_then(Value::as_str).unwrap_or("").to_owned();
        let v = pass_owner(&mut reg, &name)
            .and_then(|i| match &reg.entries[i].loaded {
                Loaded::Ready(c) => c
                    .registration
                    .mesh_passes
                    .iter()
                    .find(|p| p.name == name)
                    .map(|p| i64::from(p.code_version)),
                _ => None,
            })
            .unwrap_or(-1);
        versions.insert(name, v);
    }
    Some(format!("{}:{}", json!(versions), Value::Array(specs.to_vec())))
}

fn pass_owner(reg: &mut Registry, pass: &str) -> Option<usize> {
    for i in 0..reg.entries.len() {
        if matches!(reg.entries[i].loaded, Loaded::NotYet) && reg.entries[i].declared.wasm.is_some() {
            let loaded = compile(&reg.entries[i].declared);
            reg.entries[i].loaded = loaded;
        }
        if let Loaded::Ready(c) = &reg.entries[i].loaded {
            if c.registration.mesh_passes.iter().any(|p| p.name == pass) {
                return Some(i);
            }
        }
    }
    None
}

/// One face a mesh pass claimed: the spec that won it and the pass's tag.
#[derive(Clone)]
pub struct PassClaim {
    pub spec: Value,
    pub tag: String,
}

/// `plugin_geometry.resolve` over every spec on a body, as face index in
/// `faces` order to the claim on it. A later spec wins a face an earlier one
/// also claimed, timeline order whichever plugins the two come from.
pub fn claim_faces(
    shape: &opencascade::primitives::Shape,
    faces: &[opencascade::primitives::Shape],
    specs: &[Value],
) -> HashMap<usize, PassClaim> {
    let mut out = HashMap::new();
    let mut reg = registry();
    for spec in specs {
        let name = spec.get("pass").and_then(Value::as_str).unwrap_or("");
        let Some(i) = pass_owner(&mut reg, name) else {
            continue;
        };
        let Loaded::Ready(c) = &reg.entries[i].loaded else {
            continue;
        };
        match c.resolve_pass(name, shape, spec) {
            Ok(hits) => {
                for (hit, tag) in hits {
                    if let Some(k) = faces.iter().position(|f| kernel_api::is_same(f, &hit)) {
                        out.insert(
                            k,
                            PassClaim {
                                spec: spec.clone(),
                                tag,
                            },
                        );
                    }
                }
            }
            Err(e) => eprintln!("[plugin-geometry] resolving {name:?} failed: {e}"),
        }
    }
    out
}

/// One claimed face displaced by the pass that claimed it, `None` when the
/// pass failed, which leaves the face as the kernel meshed it. The face must
/// have just been meshed: the pass reads its stored triangulation.
pub fn displace_face(
    face: &opencascade::primitives::Shape,
    claim: &PassClaim,
    density_cap: u32,
    split_creases: bool,
) -> Option<FaceMesh> {
    let name = claim.spec.get("pass").and_then(Value::as_str).unwrap_or("");
    let mut reg = registry();
    let i = pass_owner(&mut reg, name)?;
    let Loaded::Ready(c) = &reg.entries[i].loaded else {
        return None;
    };
    match c.displace(name, face, &claim.spec, &claim.tag, density_cap, split_creases) {
        Ok(m) => Some(FaceMesh {
            positions: m.positions,
            indices: m.indices,
            normals: m.normals,
        }),
        Err(e) => {
            eprintln!("[{name}] a face fell back to flat: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests;
