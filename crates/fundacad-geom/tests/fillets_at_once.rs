//! Two fillets built at the same time, each on its own body, as the test runner and a busy engine do.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::features::blend::ops;
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::select::entity::{edges_of, EdgeEnt};
use opencascade::primitives::Shape;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

const MITRE: [f64; 3] = [15.68, -21.21, 9.92];

fn g2_box() -> Shape {
    let (w, d, h) = (35.392, 46.453, 10.782);
    let doc: Value = json!({"parameters": {}, "bodyIds": {"f2:0": "body1"}, "features": [
        {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "e0", "width": w, "height": d, "x": 0, "y": 0}]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": h, "operation": "new", "regions": [[0, 0, 0]]},
        {"id": "f3", "type": "fillet", "radius": 4.7, "continuity": "G2", "edges": [
            {"kind": "edge", "by": "nearest", "point": [-w / 2.0, 0, h], "body": "body1"},
            {"kind": "edge", "by": "nearest", "point": [0, d / 2.0, h], "body": "body1"},
            {"kind": "edge", "by": "nearest", "point": [w / 2.0, 0, h], "body": "body1"},
            {"kind": "edge", "by": "nearest", "point": [0, -d / 2.0, h], "body": "body1"}]}]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r.bodies[0].shape.clone()
}

fn mitre_of(base: &Shape) -> EdgeEnt {
    let d = |e: &EdgeEnt| kernel::distance_to_point(&e.shape, MITRE).unwrap_or(f64::INFINITY);
    edges_of(base).unwrap().into_iter().min_by(|a, b| d(a).total_cmp(&d(b))).expect("the mitre")
}

#[test]
fn two_corner_rounds_built_at_once_come_out_as_one_built_alone() {
    // The engine's own pool at one thread leaves the kernel's work to the two callers, where they collide most.
    std::env::set_var("FUNDACAD_THREADS", "1");
    let rounds = 100;
    let seen = Mutex::new(BTreeMap::<String, usize>::new());
    std::thread::scope(|s| {
        for _ in 0..2 {
            s.spawn(|| {
                let base = g2_box();
                let mitre = mitre_of(&base);
                assert!((mitre.length - 15.1091).abs() < 1e-3, "the mitre is {} mm long", mitre.length);
                let mid = [mitre.mid.x, mitre.mid.y, mitre.mid.z];
                assert!(mid.iter().zip([15.683, -21.214, 9.926]).all(|(a, b)| (a - b).abs() < 1e-2), "{mid:?}");
                for _ in 0..rounds {
                    let (out, built) =
                        ops::fillet(&base, std::slice::from_ref(&mitre.shape), &[4.5]).expect("the kernel runs");
                    let key = format!("{built:?} with {} faces", kernel::count(&out, Kind::Face));
                    *seen.lock().unwrap().entry(key).or_default() += 1;
                }
            });
        }
    });
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen, BTreeMap::from([("Done with 13 faces".to_owned(), 2 * rounds)]));
}
