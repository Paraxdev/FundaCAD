//! A split's `offset` moves its plane along the plane's normal, whatever the plane is: a world plane, a datum
//! plane or a picked face's plane. Absent, the plane is where it says.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use serde_json::{json, Value};

/// The z range of the one body left after the block and `tail`.
fn z_range(tail: &[Value]) -> (f64, f64) {
    let mut features = vec![json!({"id": "block", "type": "box", "length": 20, "width": 20, "height": 20})];
    features.extend(tail.iter().cloned());
    let raw = json!({"parameters": {"po": 3}, "features": features});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(r.bodies.len(), 1);
    let b = kernel::bbox(&r.bodies[0].shape).expect("a box");
    (b[2], b[5])
}

fn top_after(split: Value) -> f64 {
    let mut s = split;
    s["id"] = json!("cut");
    s["type"] = json!("split");
    s["keep"] = json!("top");
    z_range(&[s]).0
}

#[test]
fn the_offset_moves_a_world_plane_a_datum_plane_and_a_face_plane() {
    let (low, high) = z_range(&[]);
    let mid = (low + high) / 2.0;
    let near = |a: f64, b: f64| assert!((a - b).abs() < 1e-6, "{a} != {b}");

    let face = json!({"origin": [0, 0, mid], "normal": [0, 0, 2], "xdir": [1, 0, 0]});
    near(top_after(json!({"plane": face})), mid);
    near(top_after(json!({"plane": face, "offset": -2.5})), mid - 2.5);
    near(top_after(json!({"plane": "XY", "offset": mid + 4.0})), mid + 4.0);
    near(top_after(json!({"plane": "XY", "offset": "po"})), 3.0);

    let datum = json!({"id": "dp", "type": "datumPlane", "plane": "XY", "offset": mid});
    let split = json!({"id": "cut", "type": "split", "planeId": "dp", "offset": 2, "keep": "top"});
    near(z_range(&[datum, split]).0, mid + 2.0);
}
