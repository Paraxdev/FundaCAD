//! Separate turns each disjoint solid of a body into a body of its own.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

fn rect(id: &str, x0: f64, x1: f64) -> Value {
    let p = [[x0, 0.0], [x1, 0.0], [x1, 10.0], [x0, 10.0]];
    let lines: Vec<Value> = (0..4)
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % 4]);
            json!({"type": "line", "id": format!("{id}{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        })
        .collect();
    json!({"id": id, "type": "sketch", "plane": "XY", "entities": lines})
}

fn parted(extra: Vec<Value>) -> builder::Rebuild {
    let mut features = vec![
        rect("sk", 0.0, 30.0),
        json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"}),
        rect("sc", 20.0, 24.0),
        json!({"id": "cut", "type": "extrude", "sketch": "sc", "distance": 10, "operation": "cut"}),
    ];
    features.extend(extra);
    let raw = json!({"parameters": {}, "features": features});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled")
}

#[test]
fn a_parted_body_becomes_one_body_per_solid_and_the_largest_keeps_the_id() {
    let before = parted(vec![]);
    assert_eq!(before.bodies.len(), 1);
    assert_eq!(kernel::count(&before.bodies[0].shape, Kind::Solid), 2);
    let id = before.bodies[0].id.clone();
    let name = before.bodies[0].name.clone();

    let r = parted(vec![json!({"id": "sep", "type": "separate", "body": id})]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 2);
    for b in &r.bodies {
        assert_eq!(kernel::count(&b.shape, Kind::Solid), 1);
    }
    assert_eq!(r.bodies[0].id, id);
    assert_eq!(r.bodies[0].name, name);
    assert_eq!(r.bodies[1].name, format!("{name} 2"));
    let big = kernel::volume_precise(&r.bodies[0].shape).abs();
    let small = kernel::volume_precise(&r.bodies[1].shape).abs();
    assert!((big - 2000.0).abs() < 1e-6, "{big}");
    assert!((small - 600.0).abs() < 1e-6, "{small}");
}

#[test]
fn a_body_of_one_solid_is_refused_with_a_note() {
    let raw = json!({"parameters": {}, "features": [
        rect("sk", 0.0, 30.0),
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"},
        {"id": "sep", "type": "separate"},
    ]});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.errors.len(), 1);
    assert!(r.errors[0].message.contains("one solid"), "{}", r.errors[0].message);
}

#[test]
fn a_piece_never_takes_a_name_another_body_already_has() {
    let name = parted(vec![]).bodies[0].name.clone();
    let taken = format!("{name} 2");
    let r = parted(vec![
        json!({"id": "bx", "type": "box", "length": 5, "width": 5, "height": 5, "name": taken}),
        json!({"id": "sep", "type": "separate", "body": "body1"}),
    ]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names.len(), 3, "{names:?}");
    let mut sorted = names.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), 3, "duplicate names: {names:?}");
    assert!(names.contains(&format!("{name} 3").as_str()), "{names:?}");
}
