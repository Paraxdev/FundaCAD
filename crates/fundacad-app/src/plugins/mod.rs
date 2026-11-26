//! The plugin host. A plugin is a folder with FundaCAD 1's manifest.json. Its geometry, a WebAssembly component, runs
//! in the engine as before; its window side, Vue in FundaCAD 1, is a native module here behind the same manifest, so
//! the bundled ones are ported to Rust and a third party plugin's manifest and geometry still load.

mod extra_params;
mod manager;
pub mod manifest;
mod screws;
#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use fundacad_client::{Doc, WorkerCommand};
use gpui::*;

use crate::commands::Group;
use crate::viewport::Viewport;
pub use manifest::Manifest;

/// The ids switched off, FundaCAD 1's `fundacad.plugins`.
const DISABLED_KEY: &str = "plugins";
/// Every id the host has met, so one that is off by default is switched off once and the person's choice then holds.
const SEEN_KEY: &str = "pluginsSeen";
/// The engine reads these two beside each plugin of a root that keeps records (fundacad-geom plugins/mod.rs).
const DISABLED_FILE: &str = "disabled_ids.json";
const RECORD_FILE: &str = "installed.json";
const PLUGIN_DIR_ENV: &str = "FUNDACAD_PLUGIN_DIR";

/// A folder plugins are read from. With `records`, a plugin counts only beside the consent record the install wrote.
#[derive(Clone, Debug, PartialEq)]
pub struct Root {
    pub dir: PathBuf,
    pub records: bool,
}

/// A plugin whose window side is compiled in. `install` registers its commands and contributions and returns the view
/// it draws over the workspace.
pub struct Native {
    pub manifest: &'static str,
    pub install: fn(&Entity<Viewport>, &mut Window, &mut App) -> AnyView,
}

const NATIVES: &[Native] = &[extra_params::NATIVE, screws::NATIVE];

#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub manifest: Manifest,
    /// Its folder on disk, where the engine finds its geometry. None for a native one shipped without a folder.
    pub dir: Option<PathBuf>,
    pub native: bool,
    /// Why it does not load, shown in the list.
    pub problem: Option<String>,
}

impl Found {
    /// What it adds to the engine, for the list.
    pub fn engine_part(&self) -> Option<String> {
        let m = &self.manifest;
        let mut parts = Vec::new();
        if !m.feature_types.is_empty() {
            parts.push(format!("features {}", m.feature_types.join(", ")));
        }
        if !m.shape_generators.is_empty() {
            parts.push(format!("shapes {}", m.shape_generators.join(", ")));
        }
        if !m.exporters.is_empty() {
            parts.push(format!("exports {}", m.exporters.join(", ")));
        }
        (!parts.is_empty()).then(|| parts.join(" \u{b7} "))
    }
}

/// The user's own plugins, beside the settings.
pub fn user_root() -> Option<PathBuf> {
    crate::settings::config_dir().map(|d| d.join("plugins"))
}

fn checkout_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins")
}

/// The engine's order: FUNDACAD_PLUGIN_DIR, the user's folder, then a debug build's checkout plugins/, which holds only
/// what FundaCAD ships and so needs no records.
pub fn roots() -> Vec<Root> {
    let mut out: Vec<Root> = Vec::new();
    let env = std::env::var_os(PLUGIN_DIR_ENV).filter(|d| !d.is_empty()).map(PathBuf::from);
    for dir in env.into_iter().chain(user_root()) {
        if !out.iter().any(|r| same_dir(&r.dir, &dir)) {
            out.push(Root { dir, records: true });
        }
    }
    if cfg!(debug_assertions) {
        let repo = checkout_root();
        if !out.iter().any(|r| same_dir(&r.dir, &repo)) {
            out.push(Root { dir: repo, records: false });
        }
    }
    out
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// The install record covers the manifest when the grants agreed to equal the ones asked for now, as sets.
fn consented(dir: &Path, m: &Manifest) -> bool {
    let Some(record) =
        std::fs::read(dir.join(RECORD_FILE)).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    else {
        return false;
    };
    let Some(agreed) = record.pointer("/consented/grants").and_then(serde_json::Value::as_array) else {
        return false;
    };
    let agreed: BTreeSet<&str> = agreed.iter().filter_map(serde_json::Value::as_str).collect();
    agreed == m.grants.iter().map(String::as_str).collect()
}

/// The natives first, then every folder of every root. The first plugin with an id wins; a folder with a native's id
/// lends it its geometry.
pub fn discover(roots: &[Root], natives: &[&str]) -> Vec<Found> {
    let mut out: Vec<Found> = natives
        .iter()
        .filter_map(|m| Manifest::parse(m).map_err(|e| log::warn!("a native plugin's manifest does not read: {e}")).ok())
        .map(|manifest| Found { manifest, dir: None, native: true, problem: None })
        .collect();
    for root in roots {
        let Ok(rd) = std::fs::read_dir(&root.dir) else { continue };
        let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let folder = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
            // Bundles nobody has agreed to yet are unpacked into .inspect- and .staging- folders.
            if folder.starts_with('.') {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else { continue };
            let manifest = match Manifest::parse(&text) {
                Ok(m) => m,
                Err(why) => {
                    let mut m = Manifest::parse(&format!(
                        r#"{{"id":"{}","name":"{folder}","version":"0","kind":"panel"}}"#,
                        if manifest::id_ok(&folder) { folder.as_str() } else { "Unknown.Plugin" }
                    ))
                    .expect("a stand in manifest");
                    m.name = folder.clone();
                    out.push(Found { manifest: m, dir: Some(dir), native: false, problem: Some(why) });
                    continue;
                }
            };
            if root.records && !consented(&dir, &manifest) {
                continue;
            }
            match out.iter_mut().find(|f| manifest::same_id(&f.manifest.id, &manifest.id)) {
                Some(f) if f.native && f.dir.is_none() => {
                    f.dir = Some(dir);
                    f.manifest.geometry_wasm = manifest.geometry_wasm;
                    f.manifest.feature_types = manifest.feature_types;
                    f.manifest.shape_generators = manifest.shape_generators;
                    f.manifest.exporters = manifest.exporters;
                }
                Some(_) => {}
                None => {
                    let problem = manifest
                        .geometry_wasm
                        .is_none()
                        .then(|| "its window side runs in FundaCAD 1 only, FundaCAD 2 loads plugin geometry".to_owned());
                    out.push(Found { manifest, dir: Some(dir), native: false, problem });
                }
            }
        }
    }
    out
}

/// The ids switched off: the person's list, plus every plugin met for the first time that is off by default.
pub fn settle_disabled(found: &[Found], disabled: &[String], seen: &[String]) -> (BTreeSet<String>, Vec<String>) {
    let mut off: BTreeSet<String> = disabled.iter().cloned().collect();
    let mut seen: Vec<String> = seen.to_vec();
    for f in found {
        let id = &f.manifest.id;
        if !seen.iter().any(|s| manifest::same_id(s, id)) {
            if !f.manifest.enabled_by_default {
                off.insert(id.clone());
            }
            seen.push(id.clone());
        }
    }
    (off, seen)
}

/// Written whole and renamed into place, as the engine reads a missing list as every plugin off.
pub fn write_disabled(dir: &Path, off: &BTreeSet<String>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let ids: Vec<&String> = off.iter().collect();
    let text = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{DISABLED_FILE}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join(DISABLED_FILE)).map_err(|e| format!("{}: {e}", dir.display()))
}

/// A row a plugin adds to a body's menu.
#[derive(Clone)]
#[allow(dead_code, reason = "the items menu of fc2/commands reads it")]
pub struct MenuRow {
    pub label: SharedString,
    pub run: Rc<dyn Fn(&mut Window, &mut App)>,
}

/// What a body is made of, by the features that own its faces, to the rows a plugin offers for it.
type BodyMenu = Rc<dyn Fn(&Doc, &[String], &mut App) -> Vec<MenuRow>>;

#[derive(Default)]
struct Host {
    found: Vec<Found>,
    off: BTreeSet<String>,
    views: Vec<AnyView>,
    body_menus: Vec<(&'static str, BodyMenu)>,
}

impl Global for Host {}

pub fn enabled(cx: &App, id: &str) -> bool {
    cx.try_global::<Host>().is_none_or(|h| !h.off.iter().any(|o| manifest::same_id(o, id)))
}

pub fn found(cx: &App) -> Vec<Found> {
    cx.try_global::<Host>().map(|h| h.found.clone()).unwrap_or_default()
}

pub fn set_enabled(cx: &mut App, id: &str, on: bool) {
    let host = cx.default_global::<Host>();
    if on {
        host.off.retain(|o| !manifest::same_id(o, id));
    } else {
        host.off.insert(id.to_owned());
    }
    let off = host.off.clone();
    crate::settings::set(cx, DISABLED_KEY, &off);
    tell_engine(&off);
    cx.refresh_windows();
}

fn tell_engine(off: &BTreeSet<String>) {
    for root in roots().into_iter().filter(|r| r.records) {
        if let Err(e) = write_disabled(&root.dir, off) {
            log::warn!("the plugin switches did not reach the engine: {e}");
        }
    }
}

/// A command of a plugin, greyed and out of the palette while the plugin is off.
pub fn command(
    cx: &mut App,
    plugin: &'static str,
    id: &'static str,
    label: &'static str,
    group: Group,
    run: impl Fn(&mut Window, &mut App) + 'static,
) {
    crate::commands::register(cx, id, label, group, move |window, cx| {
        if enabled(cx, plugin) {
            run(window, cx)
        }
    });
    crate::commands::set_enabled(cx, id, move |cx| enabled(cx, plugin));
}

pub fn add_body_menu(cx: &mut App, plugin: &'static str, f: impl Fn(&Doc, &[String], &mut App) -> Vec<MenuRow> + 'static) {
    cx.default_global::<Host>().body_menus.push((plugin, Rc::new(f)));
}

/// The rows the running plugins add to the menu of a body whose faces `owners` made.
#[allow(dead_code, reason = "the items menu of fc2/commands calls it")]
pub fn body_menu(cx: &mut App, doc: &Doc, owners: &[String]) -> Vec<MenuRow> {
    let menus: Vec<(&'static str, BodyMenu)> =
        cx.try_global::<Host>().map(|h| h.body_menus.clone()).unwrap_or_default();
    let on: Vec<BodyMenu> = menus.into_iter().filter(|(p, _)| enabled(cx, p)).map(|(_, f)| f).collect();
    on.into_iter().flat_map(|f| f(doc, owners, cx)).collect()
}

/// Finds the plugins, settles what is on, tells the engine and installs every native one.
pub fn install(viewport: &Entity<Viewport>, window: &mut Window, cx: &mut App) {
    let natives: Vec<&str> = NATIVES.iter().map(|n| n.manifest).collect();
    let found = discover(&roots(), &natives);
    let disabled: Vec<String> = crate::settings::get(cx, DISABLED_KEY).unwrap_or_default();
    let seen: Vec<String> = crate::settings::get(cx, SEEN_KEY).unwrap_or_default();
    let (off, seen_now) = settle_disabled(&found, &disabled, &seen);
    if seen_now.len() != seen.len() {
        crate::settings::set(cx, SEEN_KEY, &seen_now);
        crate::settings::set(cx, DISABLED_KEY, &off);
    }
    tell_engine(&off);
    cx.set_global(Host { found, off, ..Default::default() });
    let mut views = vec![manager::install(window, cx)];
    for n in NATIVES {
        views.push((n.install)(viewport, window, cx));
    }
    cx.global_mut::<Host>().views = views;
}

/// The views the plugins draw over the workspace.
pub fn views(cx: &App) -> Vec<AnyView> {
    cx.try_global::<Host>().map(|h| h.views.clone()).unwrap_or_default()
}

/// Points a release engine at the user's plugins when nothing else names a folder, as the debug one reads the checkout.
pub fn worker(cmd: WorkerCommand) -> WorkerCommand {
    if std::env::var_os(PLUGIN_DIR_ENV).is_some_and(|d| !d.is_empty()) {
        return cmd;
    }
    match user_root().filter(|d| d.is_dir()) {
        Some(dir) => cmd.env(PLUGIN_DIR_ENV, dir),
        None => cmd,
    }
}
