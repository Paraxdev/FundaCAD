//! A stress study after a restart builds what a cold build does to the last bit, though the app's own build
//! resumed from a disk checkpoint whose directions and rotations read back an ulp off.

use std::path::PathBuf;
use std::time::Duration;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::cache::store::{self, GeomStore};
use fundacad_geom::cache::{self, RebuildCache, Source};
use fundacad_geom::inspect;
use fundacad_geom::mesh::{tessellate, MeshParams};
use serde_json::{json, Value};

fn typed(raw: &Value) -> CadDocument {
    serde_json::from_value(raw.clone()).unwrap()
}

fn tile_ring(slot: f64) -> Value {
    json!({"parameters": {}, "features": [
        {"id": "tile", "type": "box", "length": 4, "width": 1, "height": 0.5, "operation": "new"},
        {"id": "out", "type": "move", "bodies": ["body1"], "dx": 20},
        {"id": "ring", "type": "patternCircular", "bodies": ["body1"], "count": 29, "angle": 360, "axis": "Z"},
        {"id": "slot", "type": "box", "length": 60, "width": slot, "height": 6, "operation": "cut", "targets": ["body1"]},
    ]})
}

fn turned_cylinder_cut(slot: f64) -> Value {
    json!({"parameters": {}, "features": [
        {"id": "block", "type": "box", "length": 30, "width": 20, "height": 10, "operation": "new"},
        {"id": "pin", "type": "cylinder", "radius": 3, "height": 40, "operation": "new"},
        {"id": "turn", "type": "move", "bodies": ["body2"], "rx": 31, "ry": 17, "rz": 23, "dx": 2, "dy": -1.5},
        {"id": "cut", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
        {"id": "slot", "type": "box", "length": 4, "width": slot, "height": 30, "operation": "cut", "targets": ["body1"]},
    ]})
}

/// Every body's id and mesh vertex coordinates as bits, what a study meshes.
fn surfaces(r: &Rebuild) -> Vec<(String, Vec<u64>)> {
    let params = MeshParams { linear: 0.05, angular: 0.25, relative: false, display: false, force_remesh: true };
    r.bodies
        .iter()
        .map(|b| {
            let access = opencascade::mesh_access::MeshAccess::new(&b.shape);
            (b.id.clone(), tessellate(&b.shape, &access, params).positions.iter().map(|x| x.to_bits()).collect())
        })
        .collect()
}

fn cold(raw: &Value) -> Vec<(String, Vec<u64>)> {
    surfaces(&builder::rebuild(&typed(raw), raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled")))
}

fn app_build(raw: &Value) -> Source {
    let mut cache = cache::global().lock().unwrap();
    cache.rebuild(&typed(raw), raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    cache.stats.source
}

fn study(raw: &Value) -> (Vec<(String, Vec<u64>)>, Source) {
    let req = json!({"document": raw});
    let (_, r) =
        inspect::exact_rebuild_request(req.as_object().unwrap(), &NoWatch).unwrap_or_else(|_| panic!("refused"));
    (surfaces(&r), cache::global().lock().unwrap().stats.source)
}

fn first_differing(got: &[(String, Vec<u64>)], want: &[(String, Vec<u64>)]) -> String {
    for ((id, a), (_, b)) in got.iter().zip(want) {
        if let Some((x, y)) = a.iter().zip(b).find(|(x, y)| x != y) {
            return format!(
                "{id}: {} against {}, off by {:e}",
                f64::from_bits(*x),
                f64::from_bits(*y),
                f64::from_bits(*x) - f64::from_bits(*y)
            );
        }
    }
    "the same coordinates in another count".into()
}

// One test only: the engine's global cache reads its disk root from the environment once.
#[test]
fn a_study_after_a_disk_resume_meshes_the_cold_build_to_the_last_bit() {
    let home = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("disk-resume-exact-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::env::set_var("XDG_CACHE_HOME", &home);
    std::env::remove_var("FUNDACAD_DISK_CACHE");
    let root = store::default_root();
    assert!(root.starts_with(&home), "the disk cache would land in {}", root.display());

    for (name, doc) in [("tile ring", tile_ring as fn(f64) -> Value), ("turned cylinder cut", turned_cylinder_cut)] {
        let (base, edited) = (doc(0.4), doc(0.6));
        let (want_base, want_edited) = (cold(&base), cold(&edited));
        {
            let mut before_restart = RebuildCache::new(Some(GeomStore::open(&root).unwrap()));
            before_restart.budget_ms = 0.0;
            before_restart.tip_after = Duration::ZERO;
            before_restart.rebuild(&typed(&base), &base, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
        }
        cache::global().lock().unwrap().reset();

        assert_eq!(app_build(&edited), Source::Disk, "{name}: the app's build did not resume from disk");
        assert_eq!(app_build(&base), Source::Ram, "{name}: the app's edit did not resume in RAM");
        let (got, _) = study(&base);
        assert!(got == want_base, "{name}, a study after a disk resume: {}", first_differing(&got, &want_base));
        let (got, source) = study(&edited);
        assert_eq!(source, Source::Ram, "{name}: the second study did not resume in RAM");
        assert!(got == want_edited, "{name}, a study resumed in RAM after it: {}", first_differing(&got, &want_edited));
    }
    let _ = std::fs::remove_dir_all(&home);
}
