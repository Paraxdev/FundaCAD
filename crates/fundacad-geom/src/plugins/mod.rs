//! The plugin host, replacing the Python engine's `plugin_geometry.py` and
//! the Python engine's `shape_generate.py` (docs/RUST-PIVOT.md 2.3).
//!
//! A plugin bundle's geometry is a WebAssembly component (the world in
//! `wit/plugin.wit`) named by the manifest's `geometryWasm`. Manifests are read
//! for every plugin on disk, so a document can name the plugin it needs while
//! that plugin is absent; a component is compiled the first time one of its
//! declared names is used. Each call runs in a fresh instance under a time
//! budget, a memory cap and a WASI context with no files, no network and no
//! environment. Plugins installed, updated or removed while the engine runs are
//! picked up at the next lookup, as the Python pool restarts on a new stamp.

mod host;
mod kernel_api;
mod kernel_ext;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};

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

#[derive(PartialEq)]
struct Declared {
    id: String,
    dir: PathBuf,
    wasm: Option<String>,
    types: Vec<String>,
    exporters: Vec<String>,
    generators: Vec<String>,
    files_read: bool,
    /// The manifest's and the component's size and time, so a bundle replaced
    /// on disk is read again and one left alone keeps its compiled component.
    stamp: Vec<(u64, Option<SystemTime>)>,
}

enum Loaded {
    NotYet,
    Ready(Box<host::Component>),
    Broken(String),
}

struct Entry {
    declared: Declared,
    loaded: Loaded,
    identity: Option<String>,
}

#[derive(Default)]
struct Registry {
    entries: Vec<Entry>,
    discovered: bool,
    checked: Option<Instant>,
}

const RESCAN_EVERY: Duration = Duration::from_secs(1);

impl Registry {
    fn replace(&mut self, found: Vec<Declared>) {
        let mut old = std::mem::take(&mut self.entries);
        self.entries = found
            .into_iter()
            .map(|declared| {
                let (loaded, identity) = old
                    .iter()
                    .position(|e| e.declared == declared)
                    .map_or((Loaded::NotYet, None), |i| {
                        let e = old.swap_remove(i);
                        (e.loaded, e.identity)
                    });
                Entry { declared, loaded, identity }
            })
            .collect();
    }

    /// Read the plugin directories again when the last look is stale. Read once
    /// at start, a plugin installed while the engine ran stayed "unknown
    /// feature type" until the app was restarted.
    fn rescan(&mut self) {
        if !self.discovered || self.checked.is_some_and(|t| t.elapsed() < RESCAN_EVERY) {
            return;
        }
        self.checked = Some(Instant::now());
        let found = discover();
        let same = found.len() == self.entries.len()
            && found.iter().zip(&self.entries).all(|(a, b)| *a == b.declared);
        if !same {
            self.replace(found);
        }
    }
}

fn registry() -> MutexGuard<'static, Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The registry, having looked for plugins installed or removed since.
fn current() -> MutexGuard<'static, Registry> {
    let mut reg = registry();
    reg.rescan();
    reg
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
    reg.checked = Some(Instant::now());
    let found = discover();
    reg.replace(found);
}

/// Drop everything loaded. Tests only.
pub fn reset_for_tests() {
    let mut reg = registry();
    reg.entries.clear();
    reg.discovered = false;
    reg.checked = None;
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

fn file_stamp(path: &Path) -> (u64, Option<SystemTime>) {
    std::fs::metadata(path).map_or((0, None), |m| (m.len(), m.modified().ok()))
}

fn wasm_path(dir: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(dir.to_path_buf(), |p, part| p.join(part))
}

fn discover() -> Vec<Declared> {
    discover_in(&plugin_roots())
}

fn discover_in(roots: &[PathBuf]) -> Vec<Declared> {
    let mut out: Vec<Declared> = Vec::new();
    for root in roots {
        let Ok(rd) = std::fs::read_dir(root) else {
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
            let wasm = man.get(MANIFEST_WASM).and_then(Value::as_str).map(str::to_owned);
            let mut stamp = vec![file_stamp(&dir.join("manifest.json"))];
            if let Some(rel) = &wasm {
                stamp.push(file_stamp(&wasm_path(&dir, rel)));
            }
            out.push(Declared {
                wasm,
                stamp,
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

/// `component_for`, looking at the disk again first when it fails, so a plugin
/// installed or repaired a moment ago is not refused for the rescan interval.
fn lookup(reg: &mut Registry, claim: Claim, name: &str) -> Result<usize, Missing> {
    match component_for(reg, claim, name) {
        Err(_) if reg.discovered => {
            reg.checked = None;
            reg.rescan();
            component_for(reg, claim, name)
        }
        found => found,
    }
}

enum Missing {
    Unknown,
    Broken(String, String),
    NotRegistered(String),
}

/// Why a bundle made for the Python engine will not run here. The app offers
/// such a bundle as an update whatever its version (src/plugins/updates.ts).
pub const NO_COMPONENT: &str = "the installed copy was made for the previous engine and has no component for FundaCAD 1.0, updating the plugin in Preferences, Plugins fixes it";

fn compile(d: &Declared) -> Loaded {
    let Some(rel) = &d.wasm else {
        return Loaded::Broken(NO_COMPONENT.into());
    };
    let path = wasm_path(&d.dir, rel);
    if !path.is_file() {
        return Loaded::Broken(format!(
            "its manifest names {rel:?}, which is not in the installed copy, updating the plugin in Preferences, Plugins fixes it"
        ));
    }
    let started = Instant::now();
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
            eprintln!(
                "[plugin-geometry] {}: loaded {} in {} ms",
                d.id,
                path.display(),
                started.elapsed().as_millis()
            );
            Loaded::Ready(Box::new(c))
        }
        Err(e) => {
            eprintln!("[plugin-geometry] {}: geometry did not load: {e}", d.id);
            Loaded::Broken(e)
        }
    }
}

/// `plugin_geometry.unregistered`'s sentences, for a feature type, a shape
/// generator or an exporter. A plugin on disk that declares the name owns it
/// whether or not its component loads, so the sentence names the plugin.
fn missing(claim: Claim, name: &str, m: Missing) -> String {
    let subject = match claim {
        Claim::Feature => "this".to_owned(),
        Claim::Generator => format!("the shape {}", host::py_repr(name)),
        Claim::Exporter => format!("the {} export", host::py_repr(name)),
    };
    let why = match m {
        Missing::Unknown => {
            return match claim {
                Claim::Feature => format!("unknown feature type: {name}"),
                Claim::Generator => format!("no plugin that is running offers the shape {}", host::py_repr(name)),
                Claim::Exporter => format!("no installed plugin provides the {} export", host::py_repr(name)),
            }
        }
        Missing::Broken(owner, why) => (owner, why),
        Missing::NotRegistered(owner) => (owner, "its component does not register it".to_owned()),
    };
    format!(
        "{subject} needs the \"{}\" plugin, which is installed but would not load: {}",
        why.0, why.1
    )
}

/// The feature type's plugin handler, run against `ctx`. `None` when no
/// plugin on disk declares the type.
pub fn run_feature(
    ctx: &mut Ctx,
    type_name: &str,
    raw: &Value,
    cancel: Option<CancelToken>,
) -> Option<FResult> {
    let mut reg = current();
    let i = match lookup(&mut reg, Claim::Feature, type_name) {
        Ok(i) => i,
        Err(Missing::Unknown) => return None,
        Err(m) => return Some(Err(Fail::msg(missing(Claim::Feature, type_name, m)))),
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
    let mut reg = current();
    let i = lookup(&mut reg, Claim::Generator, name).map_err(|m| missing(Claim::Generator, name, m))?;
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
    let mut reg = current();
    let i = lookup(&mut reg, Claim::Exporter, exporter).map_err(|m| missing(Claim::Exporter, exporter, m))?;
    let Loaded::Ready(c) = &reg.entries[i].loaded else {
        return Err(format!("no installed plugin provides the {} export", host::py_repr(exporter)));
    };
    c.write_export(exporter, bodies, options, path, cancel)
        .map_err(|e| format!("{exporter}: {e}"))
}

/// Whether an exporter is declared by any plugin on disk, before the rebuild.
fn exporter_declared(exporter: &str) -> Result<(), String> {
    let mut reg = current();
    lookup(&mut reg, Claim::Exporter, exporter)
        .map(|_| ())
        .map_err(|m| missing(Claim::Exporter, exporter, m))
}

/// A bundle's identity for the rebuild caches: its manifest and component
/// bytes hashed, remembered until the files' stamp changes.
fn identity(entry: &mut Entry) -> String {
    if let Some(id) = &entry.identity {
        return id.clone();
    }
    let d = &entry.declared;
    let manifest = std::fs::read(d.dir.join("manifest.json")).unwrap_or_default();
    let wasm = d
        .wasm
        .as_deref()
        .and_then(|rel| std::fs::read(wasm_path(&d.dir, rel)).ok())
        .unwrap_or_default();
    let id = crate::cache::keys::hash_hex(&[d.id.as_bytes(), b"\0", &manifest, b"\0", &wasm]);
    entry.identity = Some(id.clone());
    id
}

/// Each feature type a plugin on disk declares, to the identity of the bundle
/// that runs it, so a cached build of a plugin feature is keyed on the code
/// that made it. A type no plugin declares is absent.
pub fn feature_identities() -> HashMap<String, String> {
    let mut reg = current();
    let mut out = HashMap::new();
    for e in reg.entries.iter_mut() {
        if e.declared.types.is_empty() {
            continue;
        }
        let id = identity(e);
        for t in &e.declared.types {
            out.entry(t.clone()).or_insert_with(|| id.clone());
        }
    }
    out
}

/// `plugin_geometry.cache_key`: every pass on a body with its code version and
/// its bundle's identity, `None` when it has none. A pass whose plugin is not
/// loaded keys as -1.
pub fn pass_cache_key(specs: &[Value]) -> Option<String> {
    if specs.is_empty() {
        return None;
    }
    let mut versions: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    let mut reg = current();
    for spec in specs {
        let name = spec.get("pass").and_then(Value::as_str).unwrap_or("").to_owned();
        let v = pass_owner(&mut reg, &name)
            .and_then(|i| {
                let Loaded::Ready(c) = &reg.entries[i].loaded else {
                    return None;
                };
                let version = c.registration.mesh_passes.iter().find(|p| p.name == name)?.code_version;
                Some(json!([version, identity(&mut reg.entries[i])]))
            })
            .unwrap_or(json!(-1));
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
    let mut reg = current();
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
