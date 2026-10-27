//! A round on a box's vertical edge after its top edges were rounded, sent with the mitre the two top rounds leave
//! above it, whose faces turn tangent at the top: it must build smooth or be refused with a size that does.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::blend::{ops, smooth};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::select::entity::edges_of;
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const W: f64 = 40.0;
const D: f64 = 30.0;
const H: f64 = 20.0;
const CORNERS: [f64; 5] = [1.0, 2.0, 3.0, 3.85, 5.0];

fn doc(top_cont: &str, top_r: f64, corner: Option<(f64, &[[f64; 3]])>) -> Value {
    let top: Vec<Value> = [[-W / 2.0, 0.0, H], [0.0, D / 2.0, H], [W / 2.0, 0.0, H], [0.0, -D / 2.0, H]]
        .iter()
        .map(|p| json!({"kind": "edge", "by": "nearest", "point": p, "body": "body1"}))
        .collect();
    let mut features = vec![
        json!({"id": "f1", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "e0", "width": W, "height": D, "x": 0, "y": 0}]}),
        json!({"id": "f2", "type": "extrude", "sketch": "f1", "distance": H, "operation": "new", "regions": [[0, 0, 0]]}),
        json!({"id": "f3", "type": "fillet", "radius": top_r, "continuity": top_cont, "edges": top}),
    ];
    if let Some((r, at)) = corner {
        let edges: Vec<Value> =
            at.iter().map(|p| json!({"kind": "edge", "by": "nearest", "point": p, "body": "body1"})).collect();
        features.push(json!({"id": "f4", "type": "fillet", "radius": r, "edges": edges}));
    }
    json!({"parameters": {}, "features": features, "bodyIds": {"f2:0": "body1"}})
}

/// One build at a time: OCCT has refused blends on parallel test threads that it builds alone.
fn build(d: &Value) -> Rebuild {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let typed: CadDocument = serde_json::from_value(d.clone()).expect("document parses");
    builder::rebuild(&typed, d, &NoWatch).expect("not cancelled")
}

/// The vertical edge at the (+x, +y) corner and the mitre that runs on from its top, as the app's tangent chain
/// picks them, by a point on each.
fn chain_points(base: &Shape) -> Vec<[f64; 3]> {
    let vertical = edges_of(base)
        .unwrap()
        .into_iter()
        .find(|e| e.dir().z.abs() > 0.99 && (e.mid.x - W / 2.0).abs() < 1e-3 && (e.mid.y - D / 2.0).abs() < 1e-3)
        .expect("the vertical edge");
    let top = vertical.mid + glam::DVec3::Z * (0.5 * vertical.length);
    let mitre = edges_of(base)
        .unwrap()
        .into_iter()
        .find(|e| {
            e.mid.z > top.z + 1e-2
                && kernel::subshapes(&e.shape, Kind::Vertex)
                    .iter()
                    .filter_map(kernel::bbox)
                    .any(|b| glam::DVec3::new(b[0], b[1], b[2]).distance(top) < 1e-3)
        })
        .expect("the mitre");
    vec![vertical.mid.to_array(), mitre.mid.to_array()]
}

/// The size a refusal offers, the number before "mm" in its last sentence that offers one.
fn offered(message: &str) -> Option<f64> {
    let at = message.rfind("mm, so try")?;
    let head = &message[..at];
    let start = head.rfind(|c: char| !(c.is_ascii_digit() || c == '.'))? + 1;
    head[start..].parse().ok()
}

fn smooth_build(base: &Shape, r: &Rebuild, size: f64) -> Result<(), String> {
    if !r.errors.is_empty() {
        return Err(r.errors.iter().map(|e| e.message.clone()).collect::<Vec<_>>().join(" | "));
    }
    let s = &r.bodies[0].shape;
    let lumps = smooth::Gauge::new(base).lumps(s, size);
    if !(lumps.smooth() && ops::is_valid(s)) {
        return Err(format!("built but not smooth: {lumps:?}, valid {}", ops::is_valid(s)));
    }
    Ok(())
}

/// Built smooth, or refused with no claim it did not test and a size that does build smooth.
fn smooth_or_offers_one(cont: &str, top: f64, base: &Shape, at: &[[f64; 3]], r: f64) -> Result<(), String> {
    let got = build(&doc(cont, top, Some((r, at))));
    let Some(e) = got.errors.first() else {
        return smooth_build(base, &got, r);
    };
    let m = &e.message;
    if m.contains("ANY size") || m.contains("together they build") {
        return Err(format!("claims what it did not try: {m}"));
    }
    let fits = offered(m).ok_or_else(|| format!("refused with no size: {m}"))?;
    smooth_build(base, &build(&doc(cont, top, Some((fits, at)))), fits)
        .map_err(|why| format!("offered {fits}mm, which does not build smooth: {why}"))
}

/// `(continuity, top round, corner round, whether it must build)` checked together.
fn check(cases: &[(&str, f64, f64, bool)]) {
    let mut wrong = Vec::new();
    for &(cont, top, r, must_build) in cases {
        let base_build = build(&doc(cont, top, None));
        assert!(base_build.errors.is_empty(), "{cont} top {top}: {:?}", base_build.errors);
        let base = base_build.bodies[0].shape.clone();
        let at = chain_points(&base);
        let got = if must_build {
            smooth_build(&base, &build(&doc(cont, top, Some((r, &at)))), r)
        } else {
            smooth_or_offers_one(cont, top, &base, &at, r)
        };
        if let Err(why) = got {
            wrong.push(format!("{cont} top {top} corner {r}: {why}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn a_corner_round_that_fits_its_top_rounds_builds_smooth() {
    check(&[("G1", 5.0, 3.85, true), ("G2", 5.0, 3.0, true), ("G2", 8.0, 3.85, true)]);
}

/// A G1 round as large as the top round has no room, and a G2 top round of 5 mm curves tighter than a 3.85 mm
/// ball near its middle (1.37 / 5 per mm), so no rolling ball round of that size rests on it.
#[test]
fn a_corner_round_too_large_for_its_top_rounds_offers_a_size_that_builds_smooth() {
    check(&[("G1", 3.0, 3.0, false), ("G2", 5.0, 3.85, false), ("G3", 5.0, 3.85, false)]);
}

/// Every size the bug was probed at. Slow, and still failing where an 8 mm G2 or G3 top round meets corner
/// rounds of 1 to 5 mm: the section build leaves slivers or ripples there and no smaller size it tries is clean.
#[test]
#[ignore = "takes about 25 minutes, and 8 mm G2 and G3 tops are still refused with no size, see nky9bmc4"]
fn every_probed_corner_round_builds_smooth_or_offers_a_size() {
    let mut cases = Vec::new();
    for cont in ["G1", "G2", "G3"] {
        for top in [3.0, 5.0, 8.0] {
            for r in CORNERS {
                cases.push((cont, top, r, false));
            }
        }
    }
    check(&cases);
}

/// The reported round on 8 mm G3 top rounds, which have room for it. OCCT ripples it and the section build leaves
/// slivers where its loft grazes the top rounds.
#[test]
#[ignore = "still refused, see nky9bmc4"]
fn the_reported_corner_round_on_g3_top_rounds_builds_smooth() {
    check(&[("G3", 8.0, 3.85, true)]);
}
