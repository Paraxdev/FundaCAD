//! A chamfer on the rims of a plate full of holes.

use std::f64::consts::PI;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::blend::{ops, Fits, SectionErr};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

/// A square plate 10 thick with r2.5 holes through it, its top face's edges chamfered by `chamfer`.
fn plate(side: f64, holes: &[(f64, f64)], chamfer: Option<f64>) -> Value {
    let circles: Vec<Value> = holes
        .iter()
        .enumerate()
        .map(|(i, &(x, y))| json!({"type": "circle", "id": format!("h{i}"), "x": x, "y": y, "radius": 2.5}))
        .collect();
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XY", "entities": [
            {"type": "line", "id": "a", "x1": 0, "y1": 0, "x2": side, "y2": 0},
            {"type": "line", "id": "b", "x1": side, "y1": 0, "x2": side, "y2": side},
            {"type": "line", "id": "c", "x1": side, "y1": side, "x2": 0, "y2": side},
            {"type": "line", "id": "d", "x1": 0, "y1": side, "x2": 0, "y2": 0}]}),
        json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"}),
        json!({"id": "hs", "type": "sketch", "plane": "XY", "entities": circles}),
        json!({"id": "cut", "type": "extrude", "sketch": "hs", "distance": 10, "operation": "cut"}),
    ];
    if let Some(d) = chamfer {
        features.push(json!({"id": "ch", "type": "chamfer", "distance": d,
            "edges": {"kind": "face", "by": "nearest", "point": [1.5, 1.5, 10], "body": "body1"}}));
    }
    json!({"parameters": {}, "features": features})
}

fn one_hole() -> (Shape, Vec<Shape>) {
    let body = build(&plate(20.0, &[(10.0, 10.0)], None)).bodies[0].shape.clone();
    let rim: Vec<Shape> = kernel::subshapes(&body, Kind::Edge)
        .into_iter()
        .filter(|e| {
            kernel::bbox(e)
                .is_some_and(|b| (b[2] - 10.0).abs() < 1e-6 && (b[5] - 10.0).abs() < 1e-6 && b[0] > 1.0 && b[3] < 19.0)
        })
        .collect();
    assert_eq!(rim.len(), 1, "one rim on the top face");
    (body, rim)
}

/// The volume a 45 degree chamfer of `s` takes off the rim of an r2.5 hole.
fn rim_cut(s: f64) -> f64 {
    2.0 * PI * (2.5 + s / 3.0) * s * s / 2.0
}

#[test]
fn a_section_chamfer_on_a_hole_rim_cuts_the_rim() {
    let (body, rim) = one_hole();
    for s in [0.5, 0.75] {
        let out = ops::section(&body, &rim, true, &[s], None, s, 1, false, 0.0).expect("the rim chamfers");
        let removed = kernel::volume(&body) - kernel::volume(&out);
        assert!(
            (removed - rim_cut(s)).abs() < 0.01 * rim_cut(s),
            "at {s} it took {removed}, the rim's chamfer is {}",
            rim_cut(s)
        );
        assert_eq!(kernel::count(&out, Kind::Face), kernel::count(&body, Kind::Face) + 1, "at {s} one chamfer face");
    }
}

#[test]
fn the_section_build_beats_the_job_heartbeat_while_it_works() {
    let (body, rim) = one_hole();
    let beats = Arc::new(AtomicUsize::new(0));
    let count = beats.clone();
    let _hook = fundacad_geom::heartbeat::install(Some(Arc::new(move || {
        count.fetch_add(1, Ordering::Relaxed);
    })));
    ops::section(&body, &rim, true, &[0.5], None, 0.5, 1, false, 0.0).expect("the rim chamfers");
    assert!(beats.load(Ordering::Relaxed) > 0, "no beat");
}

/// The size a refusal offers, from its "It fits up to Xmm".
fn offered(message: &str) -> Option<f64> {
    let rest = message.split("fits up to ").nth(1)?;
    rest.split("mm").next()?.parse().ok()
}

fn grid() -> Vec<(f64, f64)> {
    (0..3).flat_map(|i| (0..3).map(move |j| (5.0 + 7.0 * f64::from(i), 5.0 + 7.0 * f64::from(j)))).collect()
}

/// What a 1mm chamfer on the grid plate's top edges takes: four outer edges of 100 that overlap s^3/3 at each
/// corner, and nine rims.
fn grid_cut() -> f64 {
    4.0 * 100.0 / 2.0 - 4.0 / 3.0 + 9.0 * rim_cut(1.0)
}

#[test]
fn a_chamfer_too_large_for_a_grid_of_holes_offers_the_size_that_keeps_the_rims_apart() {
    let holes = grid();
    let refused = build(&plate(100.0, &holes, Some(1.5)));
    let message = refused.errors.first().map(|e| e.message.as_str()).unwrap_or_else(|| panic!("1.5 built"));
    // The rims are 2 apart, so each chamfer may take 1.
    assert_eq!(offered(message), Some(1.0), "{message}");

    let bare = kernel::volume(&build(&plate(100.0, &holes, None)).bodies[0].shape);
    let at = build(&plate(100.0, &holes, Some(1.0)));
    assert!(at.errors.is_empty(), "the offered 1mm does not build: {:?}", at.errors);
    let removed = bare - kernel::volume(&at.bodies[0].shape);
    assert!((removed - grid_cut()).abs() < 1.0, "removed {removed}, expected {}", grid_cut());
}

#[test]
fn a_refused_section_chamfer_hands_back_the_body_it_built_at_the_size_it_offers() {
    let body = build(&plate(100.0, &grid(), None)).bodies[0].shape.clone();
    let top: Vec<Shape> = kernel::subshapes(&body, Kind::Edge)
        .into_iter()
        .filter(|e| kernel::bbox(e).is_some_and(|b| (b[2] - 10.0).abs() < 1e-6 && (b[5] - 10.0).abs() < 1e-6))
        .collect();
    assert_eq!(top.len(), 13, "four outer edges and nine rims");
    let sizes = vec![1.5; top.len()];
    match ops::section(&body, &top, true, &sizes, None, 1.5, 1, false, 0.0).err() {
        Some(SectionErr::TooLarge { fits: Fits::UpTo(k), .. }) => assert!((k - 1.0).abs() < 1e-9, "offers {k}"),
        other => panic!("1.5 was not refused with a size: {other:?}"),
    }
    assert!(ops::take_fitted(&body, &top[1..], 1.0).is_none(), "another selection's body");
    assert!(ops::section(&body, &top, true, &sizes, None, 1.5, 1, false, 0.0).is_err(), "refused again");
    let built = ops::take_fitted(&body, &top, 1.0).expect("the body built at 1mm");
    assert!(ops::take_fitted(&body, &top, 1.0).is_none(), "handed back once");
    let removed = kernel::volume(&body) - kernel::volume(&built);
    assert!((removed - grid_cut()).abs() < 1.0, "removed {removed}, expected {}", grid_cut());
}
