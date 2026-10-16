//! A sketch with `fillRule: "evenodd"` extrudes the areas inside an odd number
//! of its closed outlines, so an imported logo keeps the holes of its letters.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

fn rebuild(doc: Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn circles(fill_rule: Option<&str>, regions: Option<Value>) -> Rebuild {
    let mut sketch = json!({"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"id": "c1", "type": "circle", "x": 0, "y": 0, "radius": 10},
        {"id": "c2", "type": "circle", "x": 0, "y": 0, "radius": 5},
        {"id": "c3", "type": "circle", "x": 0, "y": 0, "radius": 2},
    ]});
    if let Some(r) = fill_rule {
        sketch["fillRule"] = json!(r);
    }
    let mut extrude = json!({"id": "x", "type": "extrude", "sketch": "s", "distance": 2, "operation": "new"});
    if let Some(r) = regions {
        extrude["regions"] = r;
    }
    rebuild(json!({"version": 6, "parameters": {}, "features": [sketch, extrude]}))
}

fn totals(r: &Rebuild) -> (usize, usize, f64) {
    let solids = r.bodies.iter().map(|b| kernel::count(&b.shape, Kind::Solid)).sum();
    let faces = r.bodies.iter().map(|b| kernel::count(&b.shape, Kind::Face)).sum();
    let volume = r.bodies.iter().map(|b| kernel::volume(&b.shape)).sum();
    (solids, faces, volume)
}

fn near(got: f64, want: f64, rel: f64, what: &str) {
    assert!((got - want).abs() <= want.abs() * rel, "{what}: {got}, want {want}");
}

#[test]
fn evenodd_leaves_the_hole_and_keeps_the_island_inside_it() {
    let pi = std::f64::consts::PI;
    let (solids, faces, volume) = totals(&circles(Some("evenodd"), None));
    assert_eq!(solids, 2, "the ring and the island in its hole");
    assert_eq!(faces, 7, "ring: top, bottom, two walls; island: top, bottom, wall");
    near(volume, 2.0 * pi * (100.0 - 25.0 + 4.0), 1e-3, "volume");
}

#[test]
fn without_a_fill_rule_every_outline_is_filled_as_before() {
    let (solids, _, volume) = totals(&circles(None, None));
    assert_eq!(solids, 1);
    near(volume, 2.0 * std::f64::consts::PI * 100.0, 1e-3, "volume");
}

#[test]
fn a_region_point_still_picks_its_own_area_under_evenodd() {
    let (solids, _, volume) = totals(&circles(Some("evenodd"), Some(json!([[3.5, 0, 0]]))));
    assert_eq!(solids, 1);
    near(volume, 2.0 * std::f64::consts::PI * 21.0, 1e-3, "the band between r5 and r2");
}

#[test]
fn the_fill_rule_survives_a_round_trip_through_the_document() {
    let doc: CadDocument = serde_json::from_value(json!({"version": 6, "parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "fillRule": "evenodd", "entities": []},
    ]}))
    .unwrap();
    let back = serde_json::to_value(&doc).unwrap();
    assert_eq!(back["features"][0]["fillRule"], "evenodd");
}

fn ringed_glyphs(fill_rule: Option<&str>) -> (Rebuild, f64) {
    let mut entities = Vec::new();
    for k in 0..30 {
        let (cx, cy) = (f64::from(k % 6) * 30.0, f64::from(k / 6) * 30.0);
        for (r, tag) in [(10.0, "o"), (5.0, "i")] {
            let p = |j: i32| {
                let a = f64::from(j) * std::f64::consts::TAU / 8.0;
                (cx + r * a.cos(), cy + r * a.sin())
            };
            for j in 0..8 {
                let (a, b) = (p(j), p(j + 1));
                entities.push(json!({"id": format!("{tag}{k}_{j}"), "type": "line", "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1}));
            }
        }
    }
    let mut sketch = json!({"id": "s", "type": "sketch", "plane": "XY", "entities": entities});
    if let Some(r) = fill_rule {
        sketch["fillRule"] = json!(r);
    }
    let extrude = json!({"id": "x", "type": "extrude", "sketch": "s", "distance": 2, "operation": "new"});
    let t = std::time::Instant::now();
    let r = rebuild(json!({"version": 6, "parameters": {}, "features": [sketch, extrude]}));
    (r, t.elapsed().as_secs_f64())
}

#[test]
fn evenodd_costs_about_what_the_plain_fill_does_on_many_glyphs() {
    let (plain, plain_s) = ringed_glyphs(None);
    let (odd, odd_s) = ringed_glyphs(Some("evenodd"));
    let octagon = |r: f64| 2.0 * r * r * std::f64::consts::SQRT_2;
    let (solids, _, volume) = totals(&odd);
    assert_eq!(solids, 30);
    near(volume, 30.0 * 2.0 * (octagon(10.0) - octagon(5.0)), 1e-6, "thirty rings");
    near(totals(&plain).2, 30.0 * 2.0 * octagon(10.0), 1e-6, "thirty discs");
    assert!(odd_s < 5.0 * plain_s + 1.0, "evenodd {odd_s:.2} s, plain {plain_s:.2} s");
}
