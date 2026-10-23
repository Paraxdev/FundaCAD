//! The `thread` feature: each profile family and hand on a shaft and in a bore, multi-start, print clearance, a ridge
//! in a nominal bore, and a thread that follows its hole when the hole changes size.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn build(params: Value, features: Vec<Value>) -> Rebuild {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let doc = json!({ "parameters": params, "features": features });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn errors(r: &Rebuild) -> Vec<String> {
    r.errors.iter().map(|e| e.message.clone()).collect()
}

/// A groove `h` deep, `w0` wide at the face and `w1` at its floor, run `b` out
/// of the material so the flanks clear the face.
#[derive(Clone, Copy)]
struct Groove {
    h: f64,
    w0: f64,
    w1: f64,
}

impl Groove {
    fn flank_tan(&self) -> f64 {
        (self.w0 - self.w1) / 2.0 / self.h
    }
    fn profile(&self, b: f64) -> Value {
        let out = self.w0 / 2.0 + b * self.flank_tan();
        json!([[-b, -out], [self.h, -self.w1 / 2.0], [self.h, self.w1 / 2.0], [-b, out]])
    }
    fn area(&self) -> f64 {
        self.h * (self.w0 + self.w1) / 2.0
    }
    /// Distance of the area's centroid from the face, into the material.
    fn centroid_depth(&self) -> f64 {
        self.h * (self.w0 + 2.0 * self.w1) / (3.0 * (self.w0 + self.w1))
    }
}

const TAN30: f64 = 0.577_350_269_189_625_8;

/// 60 degree ISO, UNC and UNF external groove: root at 17H/24, crest flat P/8.
fn iso_external(p: f64) -> Groove {
    let h = 17.0 / 24.0 * 0.866_025_403_784_438_6 * p;
    Groove { h, w0: 0.875 * p, w1: 0.875 * p - 2.0 * h * TAN30 }
}

/// 60 degree internal groove cut from the basic minor D1: 5H/8 deep, P/4 crest.
fn iso_internal(p: f64) -> Groove {
    let h = 5.0 / 8.0 * 0.866_025_403_784_438_6 * p;
    Groove { h, w0: 0.75 * p, w1: 0.75 * p - 2.0 * h * TAN30 }
}

/// ISO 2904 trapezoidal: depth P/2 + ac, 15 degree flanks, crest flat 0.366P.
fn trapezoidal(p: f64, ac: f64) -> Groove {
    let h = 0.5 * p + ac;
    let w0 = 0.634 * p;
    Groove { h, w0, w1: w0 - 2.0 * h * 15f64.to_radians().tan() }
}

/// ACME general purpose: depth P/2 + 0.254, 14.5 degree flanks, crest 0.3707P.
fn acme(p: f64) -> Groove {
    let h = 0.5 * p + 0.254;
    let w0 = p - 0.3707 * p;
    Groove { h, w0, w1: w0 - 2.0 * h * 14.5f64.to_radians().tan() }
}

fn face_at(x: f64) -> Value {
    json!({"kind": "face", "by": "nearest", "point": [x, 0, 0], "body": "body1"})
}

fn thread(face: Value, profile: Value, pitch: f64, starts: u32, hand: &str, extra: Value) -> Value {
    let mut t = json!({"id": "th", "type": "thread", "face": face, "profile": profile,
        "pitch": pitch, "starts": starts, "hand": hand, "axis": [0, 0, 1]});
    if let Value::Object(m) = extra {
        for (k, v) in m {
            t[k] = v;
        }
    }
    t
}

fn shaft(r: f64, l: f64) -> Value {
    json!({"id": "sh", "type": "cylinder", "radius": r, "height": l})
}

fn bored_block(r: Value, l: f64) -> Vec<Value> {
    vec![
        json!({"id": "bk", "type": "box", "length": 24, "width": 24, "height": l}),
        json!({"id": "bo", "type": "cylinder", "radius": r, "height": l + 2.0, "operation": "cut", "targets": ["body1"]}),
    ]
}

fn inside(s: &opencascade::primitives::Shape, theta_deg: f64, rad: f64, z: f64) -> bool {
    let t = theta_deg.to_radians();
    kernel::point_inside(s, [rad * t.cos(), rad * t.sin(), z], 1e-7)
}

/// Centres of the runs along z, on the meridian at `theta`, where a point at
/// radius `rad` is empty (a groove) when `empty` or filled (a ridge) otherwise.
fn runs(
    s: &opencascade::primitives::Shape,
    theta: f64,
    rad: f64,
    z0: f64,
    z1: f64,
    step: f64,
    empty: bool,
) -> Vec<f64> {
    let mut out = Vec::new();
    let mut start: Option<f64> = None;
    let mut z = z0;
    while z <= z1 {
        let hit = inside(s, theta, rad, z) != empty;
        match (hit, start) {
            (true, None) => start = Some(z),
            (false, Some(a)) => {
                if a > z0 {
                    out.push((a + z - step) / 2.0);
                }
                start = None;
            }
            _ => {}
        }
        z += step;
    }
    out
}

fn wrap(x: f64, p: f64) -> f64 {
    let m = x.rem_euclid(p);
    if m > p / 2.0 {
        m - p
    } else {
        m
    }
}

/// The groove spacing along one meridian is the pitch, and turning by 45/N
/// degrees about +z moves it P/8 up for a right hand thread, down for a left.
fn assert_pitch_and_hand(
    s: &opencascade::primitives::Shape,
    probe_r: f64,
    p: f64,
    starts: u32,
    left: bool,
    empty: bool,
) {
    let step = p / 400.0;
    let a = runs(s, 0.0, probe_r, -2.5 * p, 2.5 * p, step, empty);
    assert!(a.len() >= 3, "grooves along the meridian: {a:?}");
    for w in a.windows(2) {
        assert!((w[1] - w[0] - p).abs() < p / 50.0, "groove spacing {} for pitch {p}: {a:?}", w[1] - w[0]);
    }
    let theta = 45.0 / starts as f64;
    let b = runs(s, theta, probe_r, -2.5 * p, 2.5 * p, step, empty);
    let shift = wrap(b[0] - a[0], p);
    let want = if left { -p / 8.0 } else { p / 8.0 };
    assert!((shift - want).abs() < p / 40.0, "turning {theta} degrees moved the groove {shift}, want {want}");
}

/// Filled at `solid_r` all along the middle, and empty somewhere at `gap_r`.
fn assert_root(s: &opencascade::primitives::Shape, solid_r: f64, gap_r: f64, p: f64) {
    let zs: Vec<f64> = (0..400).map(|i| -p + 2.0 * p * i as f64 / 400.0).collect();
    assert!(zs.iter().all(|&z| inside(s, 0.0, solid_r, z)), "material missing at r {solid_r}");
    assert!(zs.iter().any(|&z| !inside(s, 0.0, gap_r, z)), "no groove reaches r {gap_r}");
}

struct Case {
    groove: Groove,
    p: f64,
    starts: u32,
    left: bool,
}

fn shaft_case(c: Case, r: f64, l: f64) {
    let hand = if c.left { "left" } else { "right" };
    let base = build(json!({}), vec![shaft(r, l)]);
    let before = kernel::volume_precise(&base.bodies[0].shape);
    let res = build(
        json!({}),
        vec![shaft(r, l), thread(face_at(r), c.groove.profile(0.05 * c.p), c.p, c.starts, hand, json!({}))],
    );
    assert!(errors(&res).is_empty(), "{:?}", errors(&res));
    assert_eq!(res.bodies.len(), 1);
    assert_eq!(res.bodies[0].id, "body1");
    let s = &res.bodies[0].shape;
    assert_eq!(kernel::count(s, kernel::Kind::Solid), 1);
    let removed = before - kernel::volume_precise(s);
    let want = c.groove.area() * std::f64::consts::TAU * (r - c.groove.centroid_depth()) * l / c.p;
    assert!((removed / want - 1.0).abs() < 0.01, "removed {removed:.3}, analytic {want:.3}");
    assert_root(s, r - c.groove.h - 0.01, r - c.groove.h + 0.01, c.p);
    assert_pitch_and_hand(s, r - c.groove.h / 2.0, c.p, c.starts, c.left, true);
}

fn bore_case(c: Case, r: f64, l: f64) {
    let hand = if c.left { "left" } else { "right" };
    let base = build(json!({}), bored_block(json!(r), l));
    let before = kernel::volume_precise(&base.bodies[0].shape);
    let mut f = bored_block(json!(r), l);
    f.push(thread(face_at(r), c.groove.profile(0.05 * c.p), c.p, c.starts, hand, json!({})));
    let res = build(json!({}), f);
    assert!(errors(&res).is_empty(), "{:?}", errors(&res));
    let s = &res.bodies[0].shape;
    assert_eq!(kernel::count(s, kernel::Kind::Solid), 1);
    let removed = before - kernel::volume_precise(s);
    let want = c.groove.area() * std::f64::consts::TAU * (r + c.groove.centroid_depth()) * l / c.p;
    assert!((removed / want - 1.0).abs() < 0.01, "removed {removed:.3}, analytic {want:.3}");
    assert_root(s, r + c.groove.h + 0.01, r + c.groove.h - 0.01, c.p);
    assert_pitch_and_hand(s, r + c.groove.h / 2.0, c.p, c.starts, c.left, true);
}

#[test]
fn iso_m6_shaft_both_hands() {
    for left in [false, true] {
        shaft_case(Case { groove: iso_external(1.0), p: 1.0, starts: 1, left }, 3.0, 12.0);
    }
}

#[test]
fn iso_m6_tap_drill_bore_both_hands() {
    for left in [false, true] {
        bore_case(Case { groove: iso_internal(1.0), p: 1.0, starts: 1, left }, 2.5 - 0.0, 12.0);
    }
}

#[test]
fn unc_quarter_20_shaft_and_bore() {
    let p = 25.4 / 20.0;
    shaft_case(Case { groove: iso_external(p), p, starts: 1, left: false }, 3.175, 12.0);
    let d1 = 6.35 - 1.082_532 * p;
    bore_case(Case { groove: iso_internal(p), p, starts: 1, left: true }, d1 / 2.0, 12.0);
}

#[test]
fn unf_quarter_28_shaft() {
    let p = 25.4 / 28.0;
    shaft_case(Case { groove: iso_external(p), p, starts: 1, left: true }, 3.175, 12.0);
}

#[test]
fn trapezoidal_tr8x1_5_shaft_and_bore() {
    shaft_case(Case { groove: trapezoidal(1.5, 0.15), p: 1.5, starts: 1, left: false }, 4.0, 12.0);
    bore_case(Case { groove: trapezoidal(1.5, 0.15), p: 1.5, starts: 1, left: true }, 3.25, 12.0);
}

#[test]
fn acme_quarter_16_shaft_and_bore() {
    let p = 25.4 / 16.0;
    shaft_case(Case { groove: acme(p), p, starts: 1, left: true }, 3.175, 12.0);
    bore_case(Case { groove: acme(p), p, starts: 1, left: false }, 3.175 - acme(p).h, 12.0);
}

#[test]
fn left_hand_two_start_tr8x8() {
    shaft_case(Case { groove: trapezoidal(4.0, 0.25), p: 4.0, starts: 2, left: true }, 4.0, 24.0);
}

#[test]
fn right_hand_four_start_tr8x8_lead_screw() {
    shaft_case(Case { groove: trapezoidal(2.0, 0.25), p: 2.0, starts: 4, left: false }, 4.0, 24.0);
}

#[test]
fn print_clearance_moves_the_whole_thread_into_the_material() {
    let g = iso_external(1.0);
    let res = build(
        json!({}),
        vec![shaft(3.0, 12.0), thread(face_at(3.0), g.profile(0.05), 1.0, 1, "right", json!({"clearance": 0.2}))],
    );
    assert!(errors(&res).is_empty(), "{:?}", errors(&res));
    let s = &res.bodies[0].shape;
    assert_eq!(kernel::count(s, kernel::Kind::Solid), 1);
    let zs: Vec<f64> = (0..200).map(|i| -1.0 + i as f64 / 100.0).collect();
    assert!(zs.iter().all(|&z| !inside(s, 0.0, 2.81, z)), "major is above 5.6");
    assert!(zs.iter().any(|&z| inside(s, 0.0, 2.79, z)), "no crest at 5.6");
    assert_root(s, 3.0 - g.h - 0.2 - 0.01, 3.0 - g.h - 0.2 + 0.01, 1.0);
}

#[test]
fn a_ridge_joined_into_a_nominal_bore_makes_the_iso_minor() {
    let p = 1.0;
    let h = 5.0 / 8.0 * 0.866_025_403_784_438_6 * p;
    let b = 0.15 * h;
    let at_major = 0.875 * p;
    let tooth =
        json!([[b, -(at_major / 2.0 + b * TAN30)], [-h, -p / 8.0], [-h, p / 8.0], [b, at_major / 2.0 + b * TAN30]]);
    let mut f = bored_block(json!(3.0), 12.0);
    f.push(thread(face_at(3.0), tooth, p, 1, "right", json!({"operation": "join"})));
    let res = build(json!({}), f);
    assert!(errors(&res).is_empty(), "{:?}", errors(&res));
    assert_eq!(res.bodies.len(), 1);
    assert_eq!(res.bodies[0].id, "body1");
    let s = &res.bodies[0].shape;
    assert_eq!(kernel::count(s, kernel::Kind::Solid), 1);
    let minor = 3.0 - h;
    assert!((minor - 2.458_75).abs() < 1e-3);
    assert_root(s, 3.01, minor + 0.01, p);
    assert!((0..200).all(|i| !inside(s, 0.0, minor - 0.01, -1.0 + i as f64 / 100.0)), "ridge reaches inside the minor");
    assert_pitch_and_hand(s, 3.0 - h / 2.0, p, 1, false, false);
}

#[test]
fn editing_the_hole_diameter_rethreads() {
    let g = iso_internal(1.0);
    for hr in [2.5, 3.5] {
        let mut f = bored_block(json!("hr"), 12.0);
        f.push(thread(face_at(2.5), g.profile(0.05), 1.0, 1, "right", json!({})));
        let res = build(json!({"hr": hr}), f);
        assert!(errors(&res).is_empty(), "hr {hr}: {:?}", errors(&res));
        let s = &res.bodies[0].shape;
        assert_root(s, hr + g.h + 0.01, hr + g.h - 0.01, 1.0);
    }
}

#[test]
fn a_profile_wider_than_the_pitch_is_refused() {
    let g = iso_external(1.0);
    let res =
        build(json!({}), vec![shaft(3.0, 12.0), thread(face_at(3.0), g.profile(0.05), 0.5, 1, "right", json!({}))]);
    assert!(errors(&res).iter().any(|e| e.contains("narrower than")), "{:?}", errors(&res));
}

#[test]
fn a_flat_face_is_refused() {
    let g = iso_external(1.0);
    let top = json!({"kind": "face", "by": "nearest", "point": [0, 0, 6], "body": "body1"});
    let res = build(json!({}), vec![shaft(3.0, 12.0), thread(top, g.profile(0.05), 1.0, 1, "right", json!({}))]);
    assert!(errors(&res).iter().any(|e| e.contains("must be round")), "{:?}", errors(&res));
}
