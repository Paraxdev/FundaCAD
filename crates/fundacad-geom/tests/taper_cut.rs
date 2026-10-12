//! A tapered extrude over an outline with inside corners. The kernel's tapered
//! prism rounds each inside corner with a sliver of a cone whose tip is the
//! outline's own vertex. Where that tip lay on a freeform face of the body, a
//! cut handed back the body with the whole tool beside it. Leaned sides meet
//! in an edge there, the solid a loft to the outline's mitre offset gives.
//! `taper/ridge_outline.json` is the outline of the report, a band that follows
//! the section of a freeform duct.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

const Z: f64 = 25.4;
const RISE: f64 = 1.9;

fn outline() -> Vec<[f64; 2]> {
    serde_json::from_str(include_str!("taper/ridge_outline.json")).expect("the outline parses")
}

fn lines(pts: &[[f64; 2]]) -> Vec<Value> {
    (0..pts.len())
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        })
        .collect()
}

fn sketch(id: &str, z: f64, pts: &[[f64; 2]]) -> Value {
    json!({"id": id, "type": "sketch", "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "entities": lines(pts)})
}

fn block() -> Vec<Value> {
    vec![
        sketch("blockSk", 0.0, &[[-45.0, -65.0], [40.0, -65.0], [40.0, 40.0], [-45.0, 40.0]]),
        json!({"id": "block", "type": "extrude", "sketch": "blockSk", "distance": 40, "operation": "new"}),
    ]
}

fn tapered(pts: &[[f64; 2]], z: f64, extra: Value) -> Vec<Value> {
    let mut cut = json!({"id": "ridge", "type": "extrude", "sketch": "ridgeSk", "operation": "cut", "targets": ["body1"]});
    for (k, v) in extra.as_object().expect("fields") {
        cut[k] = v.clone();
    }
    vec![sketch("ridgeSk", z, pts), cut]
}

/// The inward mitre offset of a closed polygon of either winding.
fn inset(pts: &[[f64; 2]], d: f64) -> Vec<[f64; 2]> {
    let n = pts.len();
    let area: f64 = (0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum();
    let side = area.signum();
    let moved: Vec<([f64; 2], [f64; 2])> = (0..n)
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let len = dx.hypot(dy);
            ([a[0] - dy / len * side * d, a[1] + dx / len * side * d], [dx, dy])
        })
        .collect();
    (0..n)
        .map(|i| {
            let (a, da) = moved[(i + n - 1) % n];
            let (b, db) = moved[i];
            let den = da[0] * db[1] - da[1] * db[0];
            if den.abs() < 1e-12 {
                return b;
            }
            let t = ((b[0] - a[0]) * db[1] - (b[1] - a[1]) * db[0]) / den;
            [a[0] + da[0] * t, a[1] + da[1] * t]
        })
        .collect()
}

/// The same ridge as a loft from the outline to its own mitre offset.
fn lofted(pts: &[[f64; 2]], z: f64, rise: f64, taper: f64) -> Vec<Value> {
    vec![
        sketch("ridgeSk", z, pts),
        sketch("ridgeTopSk", z + rise, &inset(pts, rise.abs() * taper.to_radians().tan())),
        json!({"id": "ridge", "type": "loft", "sketches": ["ridgeSk", "ridgeTopSk"], "operation": "cut", "targets": ["body1"]}),
    ]
}

fn build(features: Vec<Value>) -> Rebuild {
    let raw = json!({"parameters": {}, "features": features});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled")
}

fn messages(r: &Rebuild) -> Vec<&str> {
    r.errors.iter().map(|e| e.message.as_str()).collect()
}

struct Measured {
    volume: f64,
    solids: usize,
    bbox: [f64; 6],
}

fn measured(r: &Rebuild) -> Measured {
    assert!(r.errors.is_empty(), "{:?}", messages(r));
    assert_eq!(r.bodies.len(), 1, "bodies");
    let shape = &r.bodies[0].shape;
    Measured {
        volume: kernel::volume_precise(shape),
        solids: kernel::count(shape, Kind::Solid),
        bbox: kernel::bbox(shape).expect("a box"),
    }
}

/// One solid, no larger than `before`, with `want` mm3 gone give or take `tol`.
fn assert_cut(before: &Measured, after: &Measured, want: f64, tol: f64) {
    assert_eq!(after.solids, 1, "solids");
    for k in 0..3 {
        assert!(
            after.bbox[k] >= before.bbox[k] - 1e-6 && after.bbox[k + 3] <= before.bbox[k + 3] + 1e-6,
            "the cut body's box {:?} reaches outside the body's {:?}",
            after.bbox,
            before.bbox
        );
    }
    let removed = before.volume - after.volume;
    assert!((removed - want).abs() <= tol, "removed {removed} mm3, the loft removes {want}");
}

fn with(mut base: Vec<Value>, more: Vec<Value>) -> Vec<Value> {
    base.extend(more);
    base
}

#[test]
fn the_ridge_tapered_into_a_plain_block_removes_what_the_loft_removes() {
    let pts = outline();
    let before = measured(&build(block()));
    let loft = before.volume - measured(&build(with(block(), lofted(&pts, Z, RISE, 45.0)))).volume;
    assert!((loft - 2147.217).abs() < 0.01, "the loft removes {loft}");
    let r = build(with(block(), tapered(&pts, Z, json!({"distance": RISE, "taper": 45}))));
    // The 48 rounded inside corners took 0.089 mm3 more than the loft.
    assert_cut(&before, &measured(&r), loft, 0.01);
    let faces = kernel::subshapes(&r.bodies[0].shape, Kind::Face);
    assert!(faces.iter().all(kernel::face_is_planar), "a corner of the ridge is not an edge");
}

#[test]
fn a_tapered_square_is_still_the_plain_frustum() {
    let square = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
    let mut f = tapered(&square, 5.0, json!({"distance": 4, "taper": 30, "operation": "new"}));
    f[1].as_object_mut().expect("the extrude").remove("targets");
    let r = build(f);
    let m = measured(&r);
    assert!((m.volume - 243.692).abs() < 1e-3, "volume {}", m.volume);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Face), 6);
    assert!((m.bbox[2] - 5.0).abs() < 1e-9 && (m.bbox[5] - 9.0).abs() < 1e-9, "{:?}", m.bbox);
}

#[test]
fn an_inside_corner_tapers_to_an_edge_not_a_cone() {
    // An L with 4 mm arms, leaned 30 degrees over 3 mm: the section h up is the
    // L inset by h tan(30), so the volume is exact.
    let ell = [[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [4.0, 4.0], [4.0, 10.0], [0.0, 10.0]];
    let mut f = tapered(&ell, 0.0, json!({"distance": 3, "taper": 30, "operation": "new"}));
    f[1].as_object_mut().expect("the extrude").remove("targets");
    let r = build(f);
    let m = measured(&r);
    let faces = kernel::subshapes(&r.bodies[0].shape, Kind::Face);
    assert_eq!(faces.len(), 8, "six sides and two caps");
    assert!(faces.iter().all(kernel::face_is_planar), "a side is not a plane");
    let (h, k) = (3.0f64, 30f64.to_radians().tan());
    let exact = 64.0 * h - 20.0 * k * h * h + 4.0 / 3.0 * k * k * h * h * h;
    assert!((m.volume - exact).abs() < 1e-6, "volume {} against {exact}", m.volume);
}
