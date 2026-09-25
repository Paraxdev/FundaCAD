//! Disk checkpoints of the build state, the Python engine's `rebuild_cache.py`
//! `_persist_tick`, `_save_checkpoint`, `_restore_from_disk` and
//! `_body_fingerprint`.
//!
//! Body state that is not in the shape (owners, node ref, colours, `intact`,
//! a plugin's mesh pass specs) is written from `Body` field by field, and read
//! back the same way: a field left out here comes back empty on every reopen
//! with nothing to notice it.

use std::collections::HashMap;
use std::time::Duration;

use fundacad_core::body_ids::Event;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use super::keys::blob_key;
use super::store::{Checkpoint, GeomStore, ManifestEntry};
use crate::builder::{Body, FeatureError, ImportedMeta, Owners, PlaneRecord, Snapshot, State};

/// Face, edge and vertex counts and the poles box rounded to 4 places.
pub fn fingerprint(shape: &opencascade::primitives::Shape) -> Option<Value> {
    let mut out = [0.0f64; 9];
    if !opencascade_sys::geom_cache::geom_cache_fingerprint(shape.raw(), &mut out) {
        return None;
    }
    let round = |x: f64| (x * 1e4).round() / 1e4;
    Some(json!({
        "f": out[0] as u64,
        "e": out[1] as u64,
        "vx": out[2] as u64,
        "b": out[3..].iter().map(|x| round(*x)).collect::<Vec<_>>(),
    }))
}

fn same_fingerprint(got: &Value, want: &Value) -> bool {
    let counts = ["f", "e", "vx"].iter().all(|k| got.get(*k).is_some() && got.get(*k) == want.get(*k));
    let (Some(a), Some(b)) = (got["b"].as_array(), want["b"].as_array()) else {
        return false;
    };
    counts
        && a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => (x - y).abs() <= 1e-3,
            _ => false,
        })
}

/// Which blob key each body's current shape is stored under.
pub type Modified = HashMap<String, ((u64, u64), String)>;

/// The disk half of a cached rebuild, fed after every feature.
pub struct Persist<'a> {
    pub store: &'a GeomStore,
    pub keys: &'a [String],
    pub modified: Modified,
    pub acc_ms: f64,
    pub budget_ms: f64,
    pub written: usize,
}

impl Persist<'_> {
    /// `_persist_tick`: a body whose shape changed is keyed by this feature,
    /// and a checkpoint lands once a budget of replay time has built up.
    pub fn tick(&mut self, index: usize, state: &State<'_>, elapsed: Duration) {
        for b in &state.ctx.bodies {
            let stale = self.modified.get(&b.id).map_or(true, |(ident, _)| *ident != b.identity());
            if stale {
                self.modified
                    .insert(b.id.clone(), (b.identity(), blob_key(&self.keys[index], &b.id)));
            }
        }
        self.acc_ms += elapsed.as_secs_f64() * 1000.0;
        if self.acc_ms >= self.budget_ms {
            self.save(index, &state.snapshot());
        }
    }

    /// `_save_checkpoint`, best effort: a failed write costs a later replay only.
    pub fn save(&mut self, index: usize, snap: &Snapshot) {
        let Some(chain_key) = self.keys.get(index) else {
            return;
        };
        let mut manifest = Vec::new();
        let mut fps = Vec::new();
        let mut owners = Map::new();
        for b in &snap.bodies {
            let key = match self.modified.get(&b.id) {
                Some((ident, key)) if *ident == b.identity() => key.clone(),
                _ => blob_key(chain_key, &b.id),
            };
            if self.store.put_blob(&key, b.shape()).is_err() {
                return;
            }
            let Some(fp) = fingerprint(b.shape()) else {
                return;
            };
            fps.push(fp);
            owners.insert(b.id.clone(), json!(b.owners));
            manifest.push(ManifestEntry {
                body_id: b.id.clone(),
                name: b.name.clone(),
                blob_key: key,
                node_ref: b.node_ref.clone(),
                intact: b.intact,
                face_colors: b.face_colors.clone(),
                part_color: b.part_color.clone(),
                mesh_passes: b.mesh_passes.clone(),
            });
        }
        let state = json!({
            "datums": snap.datums,
            "sketch_planes": snap.sketch_planes,
            "datum_marks": snap.datum_marks,
            "face_centers": snap.face_centers,
            "errors": snap.errors.iter().map(FeatureError::wire_full).collect::<Vec<_>>(),
            "diagnostics": snap.diagnostics,
            "ids": snap.id_events.iter().map(|e| json!([e.key, e.inherit, e.id])).collect::<Vec<_>>(),
            "owners": owners,
            "fps": fps,
        });
        let record = Checkpoint {
            feat_index: index,
            manifest,
            state,
            replay_ms: self.acc_ms,
            bytes: 0,
            pinned: false,
        };
        if self.store.save_checkpoint(chain_key, record).is_ok() {
            self.written += 1;
            self.acc_ms = 0.0;
        }
    }
}

fn parse_error(v: &Value) -> Option<FeatureError> {
    Some(FeatureError {
        message: v.get("message")?.as_str()?.to_owned(),
        feature_id: v.get("feature_id").and_then(Value::as_str).map(str::to_owned),
        code: v.get("code").and_then(Value::as_str).map(str::to_owned),
        detail: v.get("detail").cloned(),
    })
}

fn parse_event(v: &Value) -> Option<Event> {
    let a = v.as_array()?;
    Some(Event {
        key: a.first()?.as_str()?.to_owned(),
        inherit: a.get(1).and_then(Value::as_str).map(str::to_owned),
        id: a.get(2)?.as_str()?.to_owned(),
    })
}

fn object_map<T: serde::de::DeserializeOwned>(v: &Value) -> Option<IndexMap<String, T>> {
    serde_json::from_value(v.clone()).ok()
}

/// `_restore_from_disk`: the deepest checkpoint of these keys as a resume
/// point `(start, snapshot, modified)`. Anything missing, unreadable or not
/// matching its fingerprint is a miss for the whole checkpoint.
pub fn restore(store: &GeomStore, keys: &[String]) -> Option<(usize, Snapshot, Modified)> {
    let (_, cp) = store.find_checkpoint(keys)?;
    let state = &cp.state;
    let fps = state.get("fps")?.as_array()?;
    if fps.len() != cp.manifest.len() {
        return None;
    }
    let mut bodies = Vec::with_capacity(cp.manifest.len());
    let mut modified = Modified::new();
    for (entry, want) in cp.manifest.iter().zip(fps) {
        let shape = store.get_blob(&entry.blob_key)?;
        if !same_fingerprint(&fingerprint(&shape)?, want) {
            return None;
        }
        let owners: Owners = state
            .get("owners")
            .and_then(|o| o.get(&entry.body_id))
            .and_then(|o| serde_json::from_value(o.clone()).ok())
            .unwrap_or_default();
        let mut body = Body::restored(
            entry.body_id.clone(),
            entry.name.clone(),
            shape,
            owners,
            ImportedMeta {
                node_ref: entry.node_ref.clone(),
                face_colors: entry.face_colors.clone(),
                part_color: entry.part_color.clone(),
                intact: entry.intact,
            },
        );
        body.mesh_passes = entry.mesh_passes.clone();
        modified.insert(entry.body_id.clone(), (body.identity(), entry.blob_key.clone()));
        bodies.push(body);
    }
    let errors = state
        .get("errors")?
        .as_array()?
        .iter()
        .map(parse_error)
        .collect::<Option<Vec<_>>>()?;
    let id_events = state
        .get("ids")?
        .as_array()?
        .iter()
        .map(parse_event)
        .collect::<Option<Vec<_>>>()?;
    let datums: IndexMap<String, PlaneRecord> = object_map(state.get("datums")?)?;
    let snap = Snapshot {
        bodies,
        sketches: HashMap::new(),
        replay_sketches: true,
        datums,
        sketch_planes: state.get("sketch_planes").and_then(object_map).unwrap_or_default(),
        datum_marks: state.get("datum_marks").and_then(object_map).unwrap_or_default(),
        face_centers: state.get("face_centers").and_then(object_map).unwrap_or_default(),
        diagnostics: state.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default(),
        errors,
        id_events,
        tools: HashMap::new(),
    };
    Some((cp.feat_index + 1, snap, modified))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel;

    #[test]
    fn the_fingerprint_carries_topology() {
        let cube = kernel::make_box(10.0, 10.0, 10.0).unwrap();
        let fp = fingerprint(&cube).unwrap();
        assert_eq!((fp["f"].as_u64(), fp["e"].as_u64(), fp["vx"].as_u64()), (Some(6), Some(12), Some(8)));
        let drill = kernel::translated(&kernel::make_cylinder(2.0, 30.0).unwrap(), [0.0, 0.0, -10.0]).unwrap();
        let holed = kernel::boolean_op(&cube, &[&drill], kernel::BoolKind::Cut).unwrap();
        let fp2 = fingerprint(&holed).unwrap();
        assert!(fp2["e"] != fp["e"] && fp2["vx"] != fp["vx"]);
        assert!(same_fingerprint(&fp, &fp) && !same_fingerprint(&fp, &fp2));
    }

    #[test]
    fn the_fingerprint_box_ignores_triangulation() {
        let sphere = kernel::make_sphere(7.0).unwrap();
        let before = fingerprint(&sphere).unwrap();
        let _ = crate::mesh::body_payload(&sphere, "b", "B", 0.5, crate::mesh::viewport_profile(1));
        assert!(same_fingerprint(&fingerprint(&sphere).unwrap(), &before));
    }
}
