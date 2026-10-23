//! A non-uniform scale of a body the viewer has already meshed (dev-424). The app rebuilds through the RAM cache and
//! meshes every step, so each scale meets the mesh of the step before, which a cold rebuild never does.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::{kernel, reply, soundness};
use fundacad_protocol::{FullBody, JobResult, WireBody};
use serde_json::{json, Map, Value};

fn typed(raw: &Value) -> CadDocument {
    serde_json::from_value(raw.clone()).expect("a document")
}

fn full(bodies: Vec<WireBody>) -> Vec<FullBody> {
    bodies
        .into_iter()
        .map(|b| match b {
            WireBody::Full(f) => f,
            WireBody::Stub(_) => panic!("a full body"),
        })
        .collect()
}

fn cold(raw: &Value) -> (Rebuild, Vec<FullBody>) {
    let r = builder::rebuild(&typed(raw), raw, &NoWatch).expect("not cancelled");
    let JobResult::Mesh(m) = reply::mesh_result(&r.bodies, 0.1, &Map::new(), &NoWatch) else { panic!("a mesh reply") };
    (r, full(m.bodies))
}

/// Adds the features one at a time as the app does, meshing after each.
fn warm(raw: &Value) -> (Rebuild, Vec<FullBody>) {
    let all = raw["features"].as_array().expect("features").clone();
    let mut cache = RebuildCache::new(None);
    let mut last = None;
    for n in 1..=all.len() {
        let mut d = raw.clone();
        d["features"] = Value::Array(all[..n].to_vec());
        let r = cache.rebuild(&typed(&d), &d, &NoWatch).expect("not cancelled");
        assert!(r.errors.is_empty(), "{} failed: {:?}", all[n - 1]["id"], r.errors);
        let m = cache.mesh(&r, 0.1, &Map::new(), &mut |_, _| {});
        last = Some((r, full(m.bodies)));
    }
    last.expect("a feature")
}

fn assert_like_cold(raw: &Value) {
    let (w, wm) = warm(raw);
    let (c, cm) = cold(raw);
    assert!(c.errors.is_empty(), "{:?}", c.errors);
    for (i, (wb, cb)) in w.bodies.iter().zip(&c.bodies).enumerate() {
        let s = &wb.shape;
        assert!(s.is_valid().unwrap(), "{} is not valid", wb.id);
        assert_eq!(soundness::of(s).fault(), None, "{}", wb.id);
        let (vw, vc) = (kernel::volume_precise(s), kernel::volume_precise(&cb.shape));
        assert!((vw - vc).abs() < 1e-6 * vc, "{} volume {vw}, a cold build has {vc}", wb.id);
        assert_eq!(
            wm[i].fields["bbox"], cm[i].fields["bbox"],
            "{} is drawn away from where a cold build puts it",
            wb.id
        );
        let faces = kernel::count(s, kernel::Kind::Face);
        let mut per = vec![0; faces];
        for &f in &wm[i].face_ids {
            per[f as usize] += 1;
        }
        assert!(per.iter().all(|&n| n > 0), "{} triangles per face {per:?}", wb.id);
    }
}

#[test]
fn every_scale_of_the_shelled_box_works_on_the_mesh_the_viewer_left() {
    let raw: Value = serde_json::from_str(include_str!("scale/shelled_box_scaled_on_z.json")).expect("the fixture");
    assert_like_cold(&raw);
}

#[test]
fn a_moved_duplicate_of_a_scaled_box_scaled_on_x_draws_every_face_in_place() {
    let raw = json!({"parameters": {}, "features": [
        {"id": "f1", "type": "box", "length": 100, "width": 100, "height": 100},
        {"id": "f2", "type": "scale", "factor": 1, "sx": 1, "sy": 1.7, "sz": 1, "bodies": ["body1"]},
        {"id": "f3", "type": "move", "dx": 40, "dy": 0, "dz": 0, "bodies": ["body1"]},
        {"id": "f4", "type": "duplicate", "dx": 0, "dy": 0, "dz": 0, "bodies": ["body1"]},
        {"id": "f5", "type": "move", "dx": 0, "dy": 150, "dz": 0, "bodies": ["body2"]},
        {"id": "f6", "type": "scale", "factor": 1, "sx": 0.425, "sy": 1, "sz": 1, "bodies": ["body2"]},
    ]});
    assert_like_cold(&raw);
}
