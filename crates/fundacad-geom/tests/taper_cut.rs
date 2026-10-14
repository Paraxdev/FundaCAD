//! A tapered extrude over an outline with inside corners. The kernel's tapered
//! prism rounds each inside corner with a sliver of a cone whose tip is the
//! outline's own vertex. Where that tip lay on a freeform face of the body, a
//! cut handed back the body with the whole tool beside it. Leaned sides meet
//! in an edge there, the solid a loft to the outline's mitre offset gives.
//! `taper/ridge_outline.json` is the outline of the report, a band that follows
//! the section of a freeform duct.
//!
//! An outline with an arc or a spline in it has the same edges: a side is
//! carried on past the corner as its own plane or cone, a spline's as the plane
//! that touches it there, and the solid is the same upwards, downwards,
//! narrowing and flaring.
//!
//! The loose solid itself only shows on the body of the report, which is a
//! user's part and not in the repo. The tests at the end run on it when
//! `FUNDACAD_TAPER_DUCT_STEP` names a STEP file of that body, and pass without
//! looking when it is unset.

use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
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

/// A block from y `front` up to z `top`. The outline lies at z 25.4 and
/// reaches y -55.65.
fn block_to(front: f64, top: f64) -> Vec<Value> {
    vec![
        sketch("blockSk", 0.0, &[[-45.0, front], [40.0, front], [40.0, 40.0], [-45.0, 40.0]]),
        json!({"id": "block", "type": "extrude", "sketch": "blockSk", "distance": top, "operation": "new"}),
    ]
}

/// The ridge lies wholly inside this one, so the cut is the tool's own volume.
fn block() -> Vec<Value> {
    block_to(-65.0, 40.0)
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
    assert!(shape.is_valid().unwrap_or(false), "the kernel calls the body unsound");
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
    assert!((removed - want).abs() <= tol, "removed {removed} mm3 where {want} was to go");
}

fn with(mut base: Vec<Value>, more: Vec<Value>) -> Vec<Value> {
    base.extend(more);
    base
}

fn all_planar(r: &Rebuild) -> bool {
    kernel::subshapes(&r.bodies[0].shape, Kind::Face).iter().all(kernel::face_is_planar)
}

fn new_body(pts: &[[f64; 2]], extra: Value) -> Rebuild {
    let mut f = tapered(pts, 0.0, extra);
    let extrude = f[1].as_object_mut().expect("the extrude");
    extrude.remove("targets");
    extrude.insert("operation".into(), json!("new"));
    build(f)
}

/// Once sealed inside the block, once running out of its top and front as it
/// runs out of the duct wall. No plain block was seen to show the loose solid:
/// sealed, the rounded corners already gave one solid in an unchanged box and
/// missed only on the volume, the 48 cones taking 0.089 mm3 more than the loft.
#[test]
fn the_ridge_tapered_into_a_plain_block_removes_what_the_loft_removes() {
    let pts = outline();
    for (front, top, want) in [(-65.0, 40.0, 2147.217), (-50.0, 26.5, 1454.461)] {
        let before = measured(&build(block_to(front, top)));
        let loft = before.volume - measured(&build(with(block_to(front, top), lofted(&pts, Z, RISE, 45.0)))).volume;
        assert!((loft - want).abs() < 0.01, "the loft removes {loft}");
        let r = build(with(block_to(front, top), tapered(&pts, Z, json!({"distance": RISE, "taper": 45}))));
        assert_cut(&before, &measured(&r), loft, 0.01);
        assert!(all_planar(&r), "a corner of the ridge is not an edge");
    }
}

#[test]
fn the_ridge_tapered_downwards_is_the_same_solid_for_either_winding() {
    let pts = outline();
    let turned: Vec<[f64; 2]> = pts.iter().rev().copied().collect();
    let before = measured(&build(block()));
    for (label, outline) in [("as drawn", &pts), ("turned round", &turned)] {
        let r = build(with(block(), tapered(outline, Z, json!({"distance": -RISE, "taper": 45}))));
        assert!(r.errors.is_empty(), "{label}: {:?}", messages(&r));
        assert_cut(&before, &measured(&r), 2147.217, 0.01);
    }
}

#[test]
fn the_ridge_tapered_both_ways_takes_two_ridges() {
    let pts = outline();
    let before = measured(&build(block()));
    let r = build(with(block(), tapered(&pts, Z, json!({"distance": RISE, "taper": 45, "symmetric": true}))));
    assert_cut(&before, &measured(&r), 2.0 * 2147.217, 0.02);
}

/// Past 2.1 mm or 48 degrees a side of the band closes up before the far end.
/// The corners stay edges there, and the volume runs on without a step.
#[test]
fn the_ridge_keeps_its_edges_past_where_a_side_closes_up() {
    let pts = outline();
    let turned: Vec<[f64; 2]> = pts.iter().rev().copied().collect();
    let before = measured(&build(block()));
    for (distance, taper, want) in [(2.1, 45.0, 2255.800), (2.2, 45.0, 2301.796), (1.9, 49.0, 1995.497), (1.9, 60.0, 1448.676)] {
        for (label, outline) in [("as drawn", &pts), ("turned round", &turned)] {
            for way in [1.0, -1.0] {
                let label = format!("{label}, {} by {taper}", way * distance);
                let r = build(with(block(), tapered(outline, Z, json!({"distance": way * distance, "taper": taper}))));
                assert!(r.errors.is_empty(), "{label}: {:?}", messages(&r));
                let removed = before.volume - measured(&r).volume;
                assert!((removed - want).abs() < 0.01, "{label}: removed {removed}");
                assert!(all_planar(&r), "{label}: a corner of the ridge is not an edge");
            }
        }
    }
}

/// Arms of 6 and 2 mm at 45 degrees: the section h up is the L inset by h, the
/// narrow arm is gone 1 mm up and the wide one 3 mm up.
#[test]
fn an_arm_that_closes_up_ends_in_a_ridge_and_the_rest_tapers_on() {
    let ell = [[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [2.0, 6.0], [2.0, 10.0], [0.0, 10.0]];
    let wide = |h: f64| 60.0 * h - 16.0 * h * h + 4.0 / 3.0 * h * h * h;
    for (distance, exact, height) in [(2.0, wide(2.0) + 4.0, 2.0), (3.5, wide(3.0) + 4.0, 3.0)] {
        for way in [1.0, -1.0] {
            let r = new_body(&ell, json!({"distance": way * distance, "taper": 45}));
            let m = measured(&r);
            assert_eq!(m.solids, 1);
            assert!((m.volume - exact).abs() < 1e-6, "{}: volume {} against {exact}", way * distance, m.volume);
            assert!((m.bbox[5] - m.bbox[2] - height).abs() < 1e-6, "{}: {:?}", way * distance, m.bbox);
            assert!(all_planar(&r), "a side is not a plane");
        }
    }
}

fn boss(entities: Value, extra: Value) -> Rebuild {
    let mut extrude = json!({"id": "boss", "type": "extrude", "sketch": "bossSk", "operation": "new"});
    for (k, v) in extra.as_object().expect("fields") {
        extrude[k] = v.clone();
    }
    build(vec![
        json!({"id": "bossSk", "type": "sketch", "plane": {"origin": [0, 0, 0], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "entities": entities}),
        extrude,
    ])
}

fn disc(radius: f64, extra: Value) -> Rebuild {
    boss(json!([{"type": "circle", "id": "c", "x": 0, "y": 0, "radius": radius}]), extra)
}

fn spline(id: &str, closed: bool, pts: &[[f64; 2]]) -> Value {
    let poles: Vec<Value> = pts.iter().map(|p| json!({"x": p[0], "y": p[1]})).collect();
    if closed {
        json!({"type": "bspline", "id": id, "closed": true, "poles": poles})
    } else {
        json!({"type": "bspline", "id": id, "degree": 3, "poles": poles})
    }
}

/// A spline outline has nothing but the kernel's own tapered prism or loft.
/// Upwards the kernel hands a closed spline back as its solid with two loose
/// faces it calls unsound, and leaves a vertex of the lens off its curve.
/// Downwards it offsets each side of the lens in two. Each is the right solid
/// and has to stay one. The lens is drawn clockwise, and upwards it came out
/// below its plane.
#[test]
fn a_spline_outline_tapers_both_ways_on_its_own_side() {
    let blob = json!([spline("b", true, &[[0.0, -20.0], [25.0, -18.0], [30.0, 5.0], [12.0, 28.0], [-15.0, 22.0], [-28.0, 0.0]])]);
    let lens = json!([
        spline("a", false, &[[0.0, 0.0], [5.0, 6.0], [15.0, 6.0], [20.0, 0.0]]),
        spline("b", false, &[[20.0, 0.0], [15.0, -6.0], [5.0, -6.0], [0.0, 0.0]]),
    ]);
    for (label, outline, distance, taper) in [("blob", &blob, 5.0, 10.0), ("lens", &lens, 1.5, 30.0)] {
        let up = measured(&boss(outline.clone(), json!({"distance": distance, "taper": taper})));
        let down = measured(&boss(outline.clone(), json!({"distance": -distance, "taper": taper})));
        assert_eq!((up.solids, down.solids), (1, 1), "{label}");
        assert!((up.volume - down.volume).abs() < 2e-3 * down.volume, "{label}: up {} down {}", up.volume, down.volume);
        assert!(up.bbox[2].abs() < 1e-6 && (up.bbox[5] - distance).abs() < 1e-6, "{label} up: {:?}", up.bbox);
        assert!(down.bbox[5].abs() < 1e-6 && (down.bbox[2] + distance).abs() < 1e-6, "{label} down: {:?}", down.bbox);
    }
}

/// A 20 x 10 rectangle with 2 mm corners at 45 degrees over 2.5 mm: the
/// corners are gone 2 mm along and the last half millimetre is a plain
/// rectangle. Downwards the loft paired the eight sides with the four that
/// were left and came out 1.2 percent short.
#[test]
fn a_rounded_outline_tapers_past_its_corner_radius_the_same_both_ways() {
    let (w, h, r) = (20.0, 10.0, 2.0);
    let k = r * (1.0 - 0.5f64.sqrt());
    let line = |id: &str, a: [f64; 2], b: [f64; 2]| json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]});
    let arc = |id: &str, a: [f64; 2], b: [f64; 2], m: [f64; 2]| json!({"type": "arc", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1], "mx": m[0], "my": m[1]});
    let outline = json!([
        line("s0", [r, 0.0], [w - r, 0.0]),
        arc("c0", [w - r, 0.0], [w, r], [w - k, k]),
        line("s1", [w, r], [w, h - r]),
        arc("c1", [w, h - r], [w - r, h], [w - k, h - k]),
        line("s2", [w - r, h], [r, h]),
        arc("c2", [r, h], [0.0, h - r], [k, h - k]),
        line("s3", [0.0, h - r], [0.0, r]),
        arc("c3", [0.0, r], [r, 0.0], [k, k]),
    ]);
    let exact = 1000.0 / 3.0 - (4.0 - std::f64::consts::PI) * 8.0 / 3.0;
    for distance in [2.5, -2.5] {
        let m = measured(&boss(outline.clone(), json!({"distance": distance, "taper": 45})));
        assert_eq!(m.solids, 1);
        assert!((m.volume - exact).abs() < 1e-3, "{distance}: volume {} against {exact}", m.volume);
    }
}

/// A 2 mm disc at 45 degrees comes to a point 2 mm along. The kernel ran the
/// cone on through its tip to the far end, an hourglass of 3 pi mm3 that it
/// calls sound, upwards and downwards alike.
#[test]
fn a_disc_tapered_past_its_tip_is_the_cone_and_no_more() {
    let cone = std::f64::consts::PI * 8.0 / 3.0;
    for distance in [3.0, -3.0] {
        let m = measured(&disc(2.0, json!({"distance": distance, "taper": 45})));
        assert!((m.volume - cone).abs() < 1e-6, "{distance}: volume {} against {cone}", m.volume);
        assert!((m.bbox[5] - m.bbox[2] - 2.0).abs() < 1e-6 && m.bbox[2] * m.bbox[5] == 0.0, "{distance}: {:?}", m.bbox);
    }
}

/// A flare that closes a 1 mm notch has no solid the outline's sides still
/// pair up with.
#[test]
fn a_taper_the_kernel_cannot_build_fails_with_a_sentence() {
    let notch = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [5.5, 10.0], [5.5, 5.0], [4.5, 5.0], [4.5, 10.0], [0.0, 10.0]];
    let refused = [
        ("notch flared up", new_body(&notch, json!({"distance": 2, "taper": -45}))),
        ("notch flared down", new_body(&notch, json!({"distance": -2, "taper": -45}))),
    ];
    for (label, r) in &refused {
        let msgs = messages(r);
        assert_eq!(msgs.len(), 1, "{label}: {msgs:?}");
        assert!(msgs[0].contains("taper") && !msgs[0].contains("Error"), "{label}: {msgs:?}");
        assert!(r.bodies.is_empty(), "{label}: a body was made all the same");
    }
    // With room for it the notch builds.
    measured(&new_body(&notch, json!({"distance": 0.3, "taper": -45})));
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

fn seg(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

/// An arc from `a` to `b` through `m`.
fn bow(id: &str, a: [f64; 2], b: [f64; 2], m: [f64; 2]) -> Value {
    json!({"type": "arc", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1], "mx": m[0], "my": m[1]})
}

/// The same outline drawn the other way round.
fn turned_round(outline: &Value) -> Value {
    let mut ents = outline.as_array().expect("entities").clone();
    ents.reverse();
    for e in &mut ents {
        if e["type"] == "bspline" {
            e["poles"].as_array_mut().expect("poles").reverse();
        } else {
            for (p, q) in [("x1", "x2"), ("y1", "y2")] {
                let (a, b) = (e[p].clone(), e[q].clone());
                e[p] = b;
                e[q] = a;
            }
        }
    }
    Value::Array(ents)
}

/// Simpson's rule from 0 to `to`.
fn integral(f: impl Fn(f64) -> f64, to: f64) -> f64 {
    let n = 4000;
    let h = to / f64::from(n);
    let inner: f64 = (1..n).map(|i| f(f64::from(i) * h) * if i % 2 == 1 { 4.0 } else { 2.0 }).sum();
    (f(0.0) + inner + f(to)) * h / 3.0
}

/// The part of a disc of radius `r` beyond a chord `e` from its centre.
fn cap(r: f64, e: f64) -> f64 {
    r * r * (e / r).acos() - e * (r * r - e * e).sqrt()
}

const PI: f64 = std::f64::consts::PI;

/// A 20 x 10 rectangle with a half round bump of 4 mm on its long side, or a
/// bite of the same size out of it. `d` is how far the sides have moved in.
fn bump() -> Value {
    json!([
        seg("a", [0.0, 0.0], [20.0, 0.0]),
        seg("b", [20.0, 0.0], [20.0, 10.0]),
        seg("c", [20.0, 10.0], [14.0, 10.0]),
        bow("d", [14.0, 10.0], [6.0, 10.0], [10.0, 14.0]),
        seg("e", [6.0, 10.0], [0.0, 10.0]),
        seg("f", [0.0, 10.0], [0.0, 0.0]),
    ])
}

fn bump_section(d: f64) -> f64 {
    (20.0 - 2.0 * d) * (10.0 - 2.0 * d) + PI * (4.0 - d).powi(2) - cap(4.0 - d, d)
}

fn bite() -> Value {
    let mut b = bump();
    b[3]["my"] = json!(6.0);
    b
}

fn bite_section(d: f64) -> f64 {
    (20.0 - 2.0 * d) * (10.0 - 2.0 * d) - cap(4.0 + d, d)
}

/// Two discs of 6 and 4 mm with their centres 7 mm apart.
fn two_discs() -> Value {
    let x = (49.0 + 36.0 - 16.0) / 14.0;
    let y = (36.0f64 - x * x).sqrt();
    json!([bow("a", [x, y], [x, -y], [-6.0, 0.0]), bow("b", [x, -y], [x, y], [11.0, 0.0])])
}

fn two_discs_section(d: f64) -> f64 {
    let (r1, r2) = (6.0 - d, 4.0 - d);
    let x = (49.0 + r1 * r1 - r2 * r2) / 14.0;
    PI * (r1 * r1 + r2 * r2) - cap(r1, x) - cap(r2, 7.0 - x)
}

/// A disc of 4 mm with a square notch 4 mm wide down to 1 mm above its centre.
fn notched_disc() -> Value {
    let y = 12.0f64.sqrt();
    json!([
        bow("a", [2.0, y], [-2.0, y], [0.0, -4.0]),
        seg("b", [-2.0, y], [-2.0, 1.0]),
        seg("c", [-2.0, 1.0], [2.0, 1.0]),
        seg("d", [2.0, 1.0], [2.0, y]),
    ])
}

fn notched_disc_section(d: f64) -> f64 {
    let (r, w, floor) = (4.0 - d, 2.0 + d, 1.0 - d);
    PI * r * r - (w * (r * r - w * w).sqrt() + r * r * (w / r).asin() - 2.0 * w * floor)
}

/// The loft joined the ends of an arc's side to the ends of its offset with
/// straight edges, so downwards and flaring the bump came out 0.076 mm3 off,
/// the bite 0.076 and 0.138, the notched disc 0.373. Upwards and narrowing the
/// kernel's draft had them right already.
#[test]
fn an_arc_that_ends_in_a_corner_tapers_to_the_exact_solid_every_way() {
    tapers_to_the_exact_solid_every_way("bump", bump(), bump_section);
    tapers_to_the_exact_solid_every_way("bite", bite(), bite_section);
    tapers_to_the_exact_solid_every_way("two discs", two_discs(), two_discs_section);
}

/// On Linux the kernel's tapered prism found the bisector of the arc's corner
/// crossing one face and not the other, read past the end of its own list and
/// took the whole process down with a segfault 1.5 up at 30 degrees.
#[test]
fn a_notched_disc_tapers_where_the_kernel_disagrees_with_itself() {
    tapers_to_the_exact_solid_every_way("notched disc", notched_disc(), notched_disc_section);
}

fn tapers_to_the_exact_solid_every_way(name: &str, outline: Value, section: fn(f64) -> f64) {
    let k = 30f64.to_radians().tan();
    for (winding, outline) in [("as drawn", outline.clone()), ("turned round", turned_round(&outline))] {
        for (distance, taper) in [(1.5, 30.0), (-1.5, 30.0), (1.5, -30.0), (-1.5, -30.0)] {
            let label = format!("{name} {winding}, {distance} by {taper}");
            let m = measured(&boss(outline.clone(), json!({"distance": distance, "taper": taper})));
            let lean = if taper > 0.0 { k } else { -k };
            let exact = integral(|z| section(lean * z), 1.5);
            assert_eq!(m.solids, 1, "{label}");
            assert!((m.volume - exact).abs() < 1e-5, "{label}: volume {} against {exact}", m.volume);
            let (low, high) = if distance > 0.0 { (0.0, 1.5) } else { (-1.5, 0.0) };
            assert!((m.bbox[2] - low).abs() < 1e-6 && (m.bbox[5] - high).abs() < 1e-6, "{label}: {:?}", m.bbox);
        }
    }
}

/// An L with 4 mm arms, its five outside corners rounded with `r`.
fn rounded_ell(r: f64) -> Value {
    let k = r * (1.0 - 0.5f64.sqrt());
    json!([
        seg("a", [r, 0.0], [10.0 - r, 0.0]),
        bow("a2", [10.0 - r, 0.0], [10.0, r], [10.0 - k, k]),
        seg("b", [10.0, r], [10.0, 4.0 - r]),
        bow("b2", [10.0, 4.0 - r], [10.0 - r, 4.0], [10.0 - k, 4.0 - k]),
        seg("c", [10.0 - r, 4.0], [4.0, 4.0]),
        seg("d", [4.0, 4.0], [4.0, 10.0 - r]),
        bow("d2", [4.0, 10.0 - r], [4.0 - r, 10.0], [4.0 - k, 10.0 - k]),
        seg("e", [4.0 - r, 10.0], [r, 10.0]),
        bow("e2", [r, 10.0], [0.0, 10.0 - r], [k, 10.0 - k]),
        seg("f", [0.0, 10.0 - r], [0.0, r]),
        bow("g", [0.0, r], [r, 0.0], [k, k]),
    ])
}

/// Half millimetre corners are gone 0.866 mm up at 30 degrees, and with one of
/// its arcs closing up the kernel's draft leaves the outline to its tapered
/// prism, which rounded the inside corner with a cone: 71.5223 mm3. Where an
/// arc closes up that prism is 1.4e-5 mm3 off by itself.
#[test]
fn an_inside_corner_tapers_to_an_edge_beside_an_arc_that_closes_up() {
    let (r, h, k) = (0.5, 1.5, 30f64.to_radians().tan());
    let area = 64.0 - 5.0 * r * r * (1.0 - PI / 4.0);
    let rim = 40.0 - 5.0 * r * (2.0 - PI / 2.0);
    let turns = 5.0 * PI / 4.0 - 1.0;
    // Rounded up to where the corners are gone, the plain L from there.
    let gone = r / k;
    let round = |z: f64| area * z - rim * k * z * z / 2.0 + turns * k * k * z.powi(3) / 3.0;
    let plain = |z: f64| 64.0 * z - 20.0 * k * z * z + 4.0 / 3.0 * k * k * z.powi(3);
    let narrow = round(gone) + plain(h) - plain(gone);
    let flare = area * h + rim * k * h * h / 2.0 + turns * k * k * h.powi(3) / 3.0;
    let outline = rounded_ell(r);
    for (winding, outline) in [("as drawn", outline.clone()), ("turned round", turned_round(&outline))] {
        for (distance, taper, exact) in [(h, 30.0, narrow), (-h, 30.0, narrow), (h, -30.0, flare), (-h, -30.0, flare)] {
            let m = measured(&boss(outline.clone(), json!({"distance": distance, "taper": taper})));
            assert_eq!(m.solids, 1, "{winding}, {distance} by {taper}");
            assert!((m.volume - exact).abs() < 1e-4, "{winding}, {distance} by {taper}: volume {} against {exact}", m.volume);
        }
    }
}

fn polygon(pts: &[[f64; 2]]) -> Value {
    Value::Array(lines(pts))
}

/// A spline in the outline leaves the kernel nothing but its tapered prism,
/// which rounded every inside corner narrowing and every outside one flaring,
/// 0.0805 mm3 a square corner here. An inside corner brought to an edge is the
/// two sides carried on, so the solid is that of two outlines without one laid
/// over each other, and those the kernel builds as they are: `whole` has to
/// hold what `parts` hold less what their `overlap` holds. Flaring, the loft
/// failed on the bulging L and built a hump no STEP file could be written of,
/// 0.2 mm3 short.
#[test]
fn a_corner_of_an_outline_with_a_spline_tapers_to_an_edge() {
    let bulge = spline("s", false, &[[0.0, 10.0], [-2.0, 7.0], [-2.0, 3.0], [0.0, 0.0]]);
    let hump = spline("s", false, &[[14.0, 10.0], [14.0, 15.0], [6.0, 15.0], [6.0, 10.0]]);
    let cases = [
        // An L whose long side bulges, the inside corner between two lines.
        (
            "bulging L",
            json!([
                seg("a", [0.0, 0.0], [10.0, 0.0]), seg("b", [10.0, 0.0], [10.0, 4.0]), seg("c", [10.0, 4.0], [4.0, 4.0]),
                seg("d", [4.0, 4.0], [4.0, 10.0]), seg("e", [4.0, 10.0], [0.0, 10.0]), bulge.clone(),
            ]),
            [
                json!([seg("a", [0.0, 0.0], [4.0, 0.0]), seg("b", [4.0, 0.0], [4.0, 10.0]), seg("c", [4.0, 10.0], [0.0, 10.0]), bulge]),
                polygon(&[[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [0.0, 4.0]]),
            ],
            polygon(&[[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]]),
        ),
        // A rectangle with a hump, both inside corners between a line and the
        // spline, which a stem straight down from its ends carries on.
        (
            "hump",
            json!([
                seg("a", [0.0, 0.0], [20.0, 0.0]), seg("b", [20.0, 0.0], [20.0, 10.0]), seg("c", [20.0, 10.0], [14.0, 10.0]),
                hump.clone(), seg("e", [6.0, 10.0], [0.0, 10.0]), seg("f", [0.0, 10.0], [0.0, 0.0]),
            ]),
            [
                polygon(&[[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]]),
                json!([seg("a", [6.0, 6.0], [14.0, 6.0]), seg("b", [14.0, 6.0], [14.0, 10.0]), hump, seg("d", [6.0, 10.0], [6.0, 6.0])]),
            ],
            polygon(&[[6.0, 6.0], [14.0, 6.0], [14.0, 10.0], [6.0, 10.0]]),
        ),
    ];
    for (name, whole, parts, overlap) in cases {
        let narrow = |outline: &Value| measured(&boss(outline.clone(), json!({"distance": 1.5, "taper": 30}))).volume;
        let exact = narrow(&parts[0]) + narrow(&parts[1]) - narrow(&overlap);
        let mut flared = Vec::new();
        for (winding, outline) in [("as drawn", whole.clone()), ("turned round", turned_round(&whole))] {
            for (distance, taper) in [(1.5, 30.0), (-1.5, 30.0), (1.5, -30.0), (-1.5, -30.0)] {
                let label = format!("{name} {winding}, {distance} by {taper}");
                let r = boss(outline.clone(), json!({"distance": distance, "taper": taper}));
                assert!(r.errors.is_empty(), "{label}: {:?}", messages(&r));
                let m = measured(&r);
                assert_eq!(m.solids, 1, "{label}");
                if taper > 0.0 {
                    assert!((m.volume - exact).abs() < 2e-3, "{label}: volume {} against {exact}", m.volume);
                } else {
                    flared.push(m.volume);
                }
            }
        }
        let spread = flared.iter().fold(0.0f64, |w, v| w.max((v - flared[0]).abs()));
        assert!(spread < 2e-3, "{name} flared: {flared:?}");
    }
}

/// A 30 x 20 plate with a half round hole of 4 mm, flat side down. The hole
/// leans the other way, so narrowing the plate carries its two corners on to
/// an edge, and the section `d` in has the half disc grown by `d`.
#[test]
fn a_hole_with_an_arc_that_ends_in_a_corner_leans_the_other_way() {
    let outline = json!([
        seg("a", [0.0, 0.0], [30.0, 0.0]),
        seg("b", [30.0, 0.0], [30.0, 20.0]),
        seg("c", [30.0, 20.0], [0.0, 20.0]),
        seg("d", [0.0, 20.0], [0.0, 0.0]),
        seg("h", [11.0, 8.0], [19.0, 8.0]),
        bow("i", [19.0, 8.0], [11.0, 8.0], [15.0, 12.0]),
    ]);
    let k = 30f64.to_radians().tan();
    let section = |d: f64| (30.0 - 2.0 * d) * (20.0 - 2.0 * d) - (PI * (4.0 + d).powi(2) - cap(4.0 + d, d));
    for (distance, taper) in [(1.5, 30.0), (-1.5, 30.0), (1.5, -30.0), (-1.5, -30.0)] {
        let lean = if taper > 0.0 { k } else { -k };
        let exact = integral(|z| section(lean * z), 1.5);
        let m = measured(&boss(outline.clone(), json!({"distance": distance, "taper": taper, "regions": [[2, 2, 0]]})));
        assert_eq!(m.solids, 1, "{distance} by {taper}");
        assert!((m.volume - exact).abs() < 1e-5, "{distance} by {taper}: volume {} against {exact}", m.volume);
    }
}

/// Both ways is two of the same solid, and a pull on the face that looks down
/// is the solid upside down: 222.0838 mm3 each as the loft had the bite.
#[test]
fn both_ways_and_a_pull_on_a_face_that_looks_down_give_the_same_solid() {
    let exact = integral(|z| bite_section(30f64.to_radians().tan() * z), 1.5);
    let both = measured(&boss(bite(), json!({"distance": 1.5, "taper": 30, "symmetric": true})));
    assert!((both.volume - 2.0 * exact).abs() < 1e-5, "both ways: volume {} against {}", both.volume, 2.0 * exact);
    assert!((both.bbox[2] + 1.5).abs() < 1e-6 && (both.bbox[5] - 1.5).abs() < 1e-6, "{:?}", both.bbox);

    let slab = bite_section(0.0) * 5.0;
    let pulled = build(vec![
        json!({"id": "bossSk", "type": "sketch", "plane": {"origin": [0, 0, 0], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "entities": bite()}),
        json!({"id": "boss", "type": "extrude", "sketch": "bossSk", "distance": 5, "operation": "new"}),
        json!({"id": "pull", "type": "press-pull", "face": {"kind": "face", "by": "nearest", "point": [3, 3, 0], "body": "body1"},
               "distance": 1.5, "taper": 30}),
    ]);
    let m = measured(&pulled);
    assert!((m.volume - slab - exact).abs() < 1e-5, "pulled: volume {} against {}", m.volume, slab + exact);
    assert!((m.bbox[2] + 1.5).abs() < 1e-6 && (m.bbox[5] - 5.0).abs() < 1e-6, "{:?}", m.bbox);
}

/// The arms of the rounded L are 4 mm wide and gone 2 mm up at 45 degrees, so
/// the cone at its inside corner stops short of the far end and there is no
/// edge to bring it to. It built with the cone.
#[test]
fn a_corner_the_taper_cannot_bring_to_an_edge_fails_with_a_sentence() {
    for distance in [4.0, -4.0] {
        let r = boss(rounded_ell(0.5), json!({"distance": distance, "taper": 45}));
        let msgs = messages(&r);
        assert_eq!(msgs.len(), 1, "{distance}: {msgs:?}");
        assert!(msgs[0].contains("corner") && msgs[0].contains("taper") && !msgs[0].contains("Error"), "{distance}: {msgs:?}");
        assert!(r.bodies.is_empty(), "{distance}: a body was made all the same");
    }
}

/// The kernel has no sound tapered prism of this hump of eleven poles, and
/// flared the loft stood in for it: 406.9 mm3 drawn one way round and 415.3
/// the other, as a solid no STEP file could be written of. It gets the
/// sentence and no body now.
#[test]
fn a_spline_the_kernel_cannot_lean_fails_with_a_sentence() {
    let poles = [
        [14.0, 10.0], [14.0, 11.0], [14.0, 12.0], [14.0, 13.0], [13.0, 16.0], [10.0, 17.0],
        [7.0, 16.0], [6.0, 13.0], [6.0, 12.0], [6.0, 11.0], [6.0, 10.0],
    ];
    let outline = json!([
        seg("a", [0.0, 0.0], [20.0, 0.0]),
        seg("b", [20.0, 0.0], [20.0, 10.0]),
        seg("c", [20.0, 10.0], [14.0, 10.0]),
        spline("d", false, &poles),
        seg("e", [6.0, 10.0], [0.0, 10.0]),
        seg("f", [0.0, 10.0], [0.0, 0.0]),
    ]);
    for (winding, outline) in [("as drawn", outline.clone()), ("turned round", turned_round(&outline))] {
        for distance in [1.5, -1.5] {
            let r = boss(outline.clone(), json!({"distance": distance, "taper": -30}));
            let msgs = messages(&r);
            assert_eq!(msgs.len(), 1, "{winding}, {distance}: {msgs:?}");
            assert!(msgs[0].contains("taper") && !msgs[0].contains("Error"), "{winding}, {distance}: {msgs:?}");
            assert!(r.bodies.is_empty(), "{winding}, {distance}: a body was made all the same");
        }
    }
}

const KAPPA: f64 = 0.552_284_749_830_793_6;

/// A block with a tunnel of 7.2 mm swept 150 degrees about Z at 30 mm, its
/// wall a spline turned about the axis. Like the duct of the report it is a
/// void whose wall leans 45 degrees at the level the ridge is drawn on, which
/// is `TUNNEL.0`, there between the radii `TUNNEL.1` and `TUNNEL.2`.
const TUNNEL: (f64, f64, f64) = (20.0 + 0.9 * (4.0 + 3.0 * KAPPA), 30.0 - 0.9 * (4.0 + 3.0 * KAPPA), 30.0 + 0.9 * (4.0 + 3.0 * KAPPA));

fn tunnel() -> Vec<Value> {
    let quarters = [
        [[1.0, 0.0], [1.0, KAPPA], [KAPPA, 1.0], [0.0, 1.0]],
        [[0.0, 1.0], [-KAPPA, 1.0], [-1.0, KAPPA], [-1.0, 0.0]],
        [[-1.0, 0.0], [-1.0, -KAPPA], [-KAPPA, -1.0], [0.0, -1.0]],
        [[0.0, -1.0], [KAPPA, -1.0], [1.0, -KAPPA], [1.0, 0.0]],
    ];
    let wall: Vec<Value> = quarters
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let poles: Vec<Value> = q.iter().map(|p| json!({"x": 30.0 + 7.2 * p[0], "y": 20.0 + 7.2 * p[1]})).collect();
            json!({"type": "bspline", "id": format!("q{i}"), "degree": 3, "poles": poles})
        })
        .collect();
    vec![
        sketch("blockSk", 0.0, &[[-45.0, -50.0], [50.0, -50.0], [50.0, 50.0], [-45.0, 50.0]]),
        json!({"id": "block", "type": "extrude", "sketch": "blockSk", "distance": 40, "operation": "new"}),
        json!({"id": "tunnelSk", "type": "sketch", "plane": "XZ", "entities": wall}),
        json!({"id": "tunnel", "type": "revolve", "sketch": "tunnelSk", "axis": "Z", "angle": 150, "operation": "cut", "targets": ["body1"]}),
    ]
}

/// A band over the tunnel as the report's band lies over its duct: the outer
/// side an arc on the wall, one end a spline, and the inner side two chords
/// that meet in an inside corner on the wall.
fn band() -> Value {
    let (_, r_in, r_out) = TUNNEL;
    let at = |r: f64, deg: f64| [r * deg.to_radians().cos(), r * deg.to_radians().sin()];
    let p = [at(r_out, 15.0), at(r_out, 65.0), at(r_out, 115.0), at(r_in, 115.0), at(r_in, 65.0), at(r_in, 15.0)];
    let out = |t: f64| {
        let (dx, dy) = (p[3][0] - p[2][0], p[3][1] - p[2][1]);
        let l = dx.hypot(dy);
        json!({"x": p[2][0] + dx * t + dy / l, "y": p[2][1] + dy * t - dx / l})
    };
    json!([
        bow("outer", p[0], p[2], p[1]),
        {"type": "bspline", "id": "end", "degree": 3, "poles": [{"x": p[2][0], "y": p[2][1]}, out(0.33), out(0.67), {"x": p[3][0], "y": p[3][1]}]},
        seg("in1", p[3], p[4]),
        seg("in2", p[4], p[5]),
        seg("end2", p[5], p[0]),
    ])
}

/// What the cut has to take was worked out apart from the engine, with the
/// same surgery written against another build of the kernel: 197.996 and
/// 383.782 mm3. The cone at the inside corner added 0.068 and 0.156 mm3 to
/// that, and at 1.9 mm that other kernel cut nothing at all with it.
#[test]
fn a_ridge_with_an_arc_a_spline_and_an_inside_corner_cuts_a_body_with_a_spline_wall() {
    let before = measured(&build(tunnel()));
    for (distance, want) in [(1.9, 197.996), (2.5, 383.782)] {
        let mut features = tunnel();
        features.push(json!({"id": "ridgeSk", "type": "sketch", "plane": {"origin": [0, 0, TUNNEL.0], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "entities": band()}));
        features.push(json!({"id": "ridge", "type": "extrude", "sketch": "ridgeSk", "operation": "cut", "targets": ["body1"], "distance": distance, "taper": 45}));
        let r = build(features);
        assert!(r.errors.is_empty(), "{distance}: {:?}", messages(&r));
        assert_cut(&before, &measured(&r), want, 0.02);
    }
}

/// The body of the report with nothing else in the document, or nothing when
/// the variable is unset.
fn duct_body() -> Option<Vec<Value>> {
    static BODY: OnceLock<Option<Value>> = OnceLock::new();
    let feature = BODY.get_or_init(|| {
        let path = std::env::var("FUNDACAD_TAPER_DUCT_STEP").ok()?;
        let dir = std::env::temp_dir().join(format!("fundacad-taper-cut-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        let store = BlobStore::open(&dir).unwrap();
        let mut f = import::import_geometry(&path, "step", &store).unwrap();
        f.insert("id".into(), json!("duct"));
        f.insert("type".into(), json!("import"));
        f.insert("format".into(), json!("step"));
        Some(Value::Object(f))
    });
    feature.clone().map(|f| vec![f])
}

fn no_split(r: &Rebuild) {
    let split: Vec<&Value> = r.diagnostics.iter().filter(|d| d["code"] == "bodySplit").collect();
    assert!(split.is_empty(), "{split:?}");
}

/// The report itself: the cut gave two solids, the tool loose in front of the
/// wall, and removed 0.18 mm3.
#[test]
fn the_ridge_tapered_over_the_duct_it_follows_cuts_it_and_adds_nothing() {
    let Some(body) = duct_body() else { return };
    let pts = outline();
    let before = measured(&build(body.clone()));
    let r = build(with(body, tapered(&pts, Z, json!({"distance": RISE, "taper": 45}))));
    // The loft to the exact mitre offset removes 370.415 here, the report's
    // own loft to a hand drawn offset 378.8.
    assert_cut(&before, &measured(&r), 370.4, 2.0);
    no_split(&r);
}

#[test]
fn six_points_of_the_ridge_with_one_inside_corner_on_the_duct_cut_one_solid() {
    let Some(body) = duct_body() else { return };
    let all = outline();
    let pts: Vec<[f64; 2]> = [35, 36, 37, 56, 57, 58].iter().map(|&i| all[i]).collect();
    let before = measured(&build(body.clone()));
    let after = measured(&build(with(body, tapered(&pts, Z, json!({"distance": RISE, "taper": 45})))));
    // The loft removes 28.036.
    assert_cut(&before, &after, 28.04, 0.5);
}

/// Where a side of the band closes up the rounded tool came back, and with it
/// a refusal after most of a minute or a cut said to have removed nothing.
#[test]
fn the_ridge_tapered_past_where_a_side_closes_up_still_cuts_the_duct() {
    let Some(body) = duct_body() else { return };
    let pts = outline();
    let before = measured(&build(body.clone()));
    // No loft reaches these to compare with. From 370.4 at 45 degrees the cut
    // loses about 28 mm3 a degree.
    for (distance, taper, want) in [(2.2, 45.0, 511.5), (1.9, 50.0, 231.9), (1.9, 60.0, 27.7)] {
        let r = build(with(body.clone(), tapered(&pts, Z, json!({"distance": distance, "taper": taper}))));
        assert!(r.errors.is_empty(), "{distance} by {taper}: {:?}", messages(&r));
        assert_cut(&before, &measured(&r), want, 2.0);
        no_split(&r);
    }
}

/// One side of the six points a spline bulging 1 mm outwards. With the cone
/// at its inside corner the tool took 62.9 mm3 of the duct for the first side
/// and all of its own 153.4 mm3 for the second, where it dips 29.1 and 35.1
/// mm3 into the wall, and for the third the cut was refused.
#[test]
fn six_points_of_the_ridge_with_a_spline_side_cut_what_they_dip_into_the_duct() {
    let Some(body) = duct_body() else { return };
    let all = outline();
    let p: Vec<[f64; 2]> = [35, 36, 37, 56, 57, 58].iter().map(|&i| all[i]).collect();
    let before = measured(&build(body.clone()));
    for (k, want) in [(2usize, 29.14), (0, 35.10), (5, 29.09)] {
        let (a, b) = (p[k], p[(k + 1) % 6]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx.hypot(dy);
        let out = |t: f64| json!({"x": a[0] + dx * t + dy / l, "y": a[1] + dy * t - dx / l});
        let mut ents = lines(&p);
        ents[k] = json!({"type": "bspline", "id": "s", "degree": 3, "poles": [{"x": a[0], "y": a[1]}, out(0.33), out(0.67), {"x": b[0], "y": b[1]}]});
        let mut features = body.clone();
        features.push(json!({"id": "ridgeSk", "type": "sketch", "plane": {"origin": [0, 0, Z], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "entities": ents}));
        features.push(json!({"id": "ridge", "type": "extrude", "sketch": "ridgeSk", "operation": "cut", "targets": ["body1"], "distance": RISE, "taper": 45}));
        let r = build(features);
        assert!(r.errors.is_empty(), "side {k}: {:?}", messages(&r));
        assert_cut(&before, &measured(&r), want, 0.5);
        no_split(&r);
    }
}
