//! A warm disk cache answers a plugin feature exactly as a cold build does,
//! and never with what an earlier copy of the plugin's component made. Needs
//! `python scripts/build-plugin-wasm.py` first; without the components every
//! case is skipped with a note.
#![cfg(feature = "plugins")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use fundacad_core::CadDocument;
use fundacad_geom::builder::NoWatch;
use fundacad_geom::cache::store::GeomStore;
use fundacad_geom::cache::{RebuildCache, Source};
use fundacad_geom::plugins;
use fundacad_protocol::WireBody;
use serde_json::{json, Map, Value};

/// The plugin registry and FUNDACAD_PLUGIN_DIR are process wide.
static PLUGINS: Mutex<()> = Mutex::new(());

fn repo_plugin(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins").join(name)
}

fn built(names: &[&str]) -> bool {
    let ok = names.iter().all(|n| repo_plugin(n).join("geometry.wasm").is_file());
    if !ok {
        eprintln!("skipped: build the components with scripts/build-plugin-wasm.py");
    }
    ok
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-warm-plugin-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A fresh process's registry over the given plugin directory.
fn restart_plugins(dir: Option<&Path>) {
    match dir {
        Some(d) => std::env::set_var("FUNDACAD_PLUGIN_DIR", d),
        None => std::env::remove_var("FUNDACAD_PLUGIN_DIR"),
    }
    plugins::reset_for_tests();
    plugins::load();
}

fn textured() -> Value {
    json!({"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
        {"id": "t", "type": "texture", "kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0},
    ]})
}

/// What a reply must reproduce: each body's id, etag and triangle count, and the errors.
fn answer(cache: &mut RebuildCache, raw: &Value) -> Value {
    let doc: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let r = cache.rebuild(&doc, raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    let m = cache.mesh(&r, 0.1, &Map::new(), &mut |_, _| {});
    let bodies: Vec<Value> = m
        .bodies
        .iter()
        .map(|b| match b {
            WireBody::Full(f) => json!([f.fields["id"], f.fields["etag"], f.indices.len() / 3]),
            WireBody::Stub(s) => json!([s["id"], s["etag"], null]),
        })
        .collect();
    json!({"bodies": bodies, "errors": r.errors.iter().map(|e| e.wire()).collect::<Vec<_>>()})
}

fn checkpointing(root: &Path) -> RebuildCache {
    let mut cache = RebuildCache::new(Some(GeomStore::open(root).unwrap()));
    cache.budget_ms = 0.0;
    cache.tip_after = Duration::ZERO;
    cache.mesh_persist_after = Duration::ZERO;
    cache
}

fn triangles(a: &Value) -> u64 {
    a["bodies"][0][2].as_u64().unwrap()
}

#[test]
fn a_warm_textured_rebuild_equals_the_cold_one() {
    let _g = PLUGINS.lock().unwrap_or_else(|e| e.into_inner());
    if !built(&["FundaCAD.Texture"]) {
        return;
    }
    restart_plugins(None);
    let root = scratch("texture");
    let raw = textured();
    let reference = answer(&mut RebuildCache::new(None), &raw);
    assert!(triangles(&reference) > 1000, "{reference}");
    {
        let mut cache = checkpointing(&root);
        assert_eq!(answer(&mut cache, &raw), reference);
        assert!(cache.stats.checkpoints_written >= 3);
    }
    restart_plugins(None);
    let mut reopened = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let got = answer(&mut reopened, &raw);
    assert_eq!(reopened.stats.source, Source::Disk);
    assert!(reopened.stats.replayed.is_empty(), "replayed {:?}", reopened.stats.replayed);
    assert_eq!(got, reference);
    assert_eq!(triangles(&got), triangles(&reference));
}

/// A custom section appended to a component: the same code under new bytes.
fn with_custom_section(wasm: &[u8]) -> Vec<u8> {
    let name = b"fundacad-test";
    let payload = b"changed";
    let body_len = 1 + name.len() + payload.len();
    let mut out = wasm.to_vec();
    out.push(0);
    out.push(u8::try_from(body_len).unwrap());
    out.push(u8::try_from(name.len()).unwrap());
    out.extend_from_slice(name);
    out.extend_from_slice(payload);
    out
}

#[test]
fn a_changed_component_is_never_served_its_old_result() {
    let _g = PLUGINS.lock().unwrap_or_else(|e| e.into_inner());
    if !built(&["FundaCAD.Texture", "FundaCAD.PrintToolbox"]) {
        return;
    }
    let plugins_dir = scratch("bundles");
    let bundle = plugins_dir.join("FundaCAD.Texture");
    std::fs::create_dir_all(&bundle).unwrap();
    std::fs::copy(repo_plugin("FundaCAD.Texture").join("manifest.json"), bundle.join("manifest.json")).unwrap();
    let original = std::fs::read(repo_plugin("FundaCAD.Texture").join("geometry.wasm")).unwrap();
    std::fs::write(bundle.join("geometry.wasm"), &original).unwrap();

    restart_plugins(Some(&plugins_dir));
    let root = scratch("changed");
    let raw = textured();
    let reference = answer(&mut RebuildCache::new(None), &raw);
    assert!(triangles(&reference) > 1000, "{reference}");
    assert_eq!(answer(&mut checkpointing(&root), &raw), reference);

    std::fs::write(bundle.join("geometry.wasm"), with_custom_section(&original)).unwrap();
    restart_plugins(Some(&plugins_dir));
    let mut cache = checkpointing(&root);
    let rebuilt = answer(&mut cache, &raw);
    assert_eq!(cache.stats.resumed_at, 2, "the texture feature ran again");
    assert_eq!(rebuilt, answer(&mut RebuildCache::new(None), &raw));
    assert_eq!(triangles(&rebuilt), triangles(&reference));

    std::fs::write(
        bundle.join("geometry.wasm"),
        std::fs::read(repo_plugin("FundaCAD.PrintToolbox").join("geometry.wasm")).unwrap(),
    )
    .unwrap();
    restart_plugins(Some(&plugins_dir));
    let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    let broken = answer(&mut cache, &raw);
    assert_eq!(broken, answer(&mut RebuildCache::new(None), &raw));
    assert_eq!(broken["errors"][0]["feature_id"], "t", "{broken}");
    assert!(triangles(&broken) < 100, "{broken}");

    std::fs::write(bundle.join("geometry.wasm"), &original).unwrap();
    restart_plugins(Some(&plugins_dir));
    let mut cache = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
    assert_eq!(answer(&mut cache, &raw), reference);
    assert_eq!(cache.stats.source, Source::Disk);
    assert!(cache.stats.replayed.is_empty(), "replayed {:?}", cache.stats.replayed);
    restart_plugins(None);
}
