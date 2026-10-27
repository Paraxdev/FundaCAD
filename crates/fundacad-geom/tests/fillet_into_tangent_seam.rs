//! A round on a box's vertical edge after its top edges were rounded, sent with the mitre the two top rounds leave
//! above it, whose faces turn tangent at the top: it must build smooth or be refused with a size that does.
//!
//! Smooth is judged here apart from the engine's own gauge: a rolling ball round of radius r is the surface a ball
//! of radius r traces resting on both faces, so that ball, set on any point of the round, stays inside the body.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::blend::ops;
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::mesh::{self, viewport_profile};
use fundacad_geom::select::entity::edges_of;
use glam::DVec3;
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const W: f64 = 40.0;
const D: f64 = 30.0;
const H: f64 = 20.0;
const CORNERS: [f64; 5] = [1.0, 2.0, 3.0, 3.85, 5.0];
/// How far the resting ball may stand out of the body, as a share of its radius.
const BALL_SLACK: f64 = 0.02;
/// The most mesh nodes each result is checked at, by exact distances.
const SAMPLES: usize = 800;

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
    let top = vertical.mid + DVec3::Z * (0.5 * vertical.length);
    let mitre = edges_of(base)
        .unwrap()
        .into_iter()
        .find(|e| {
            e.mid.z > top.z + 1e-2
                && kernel::subshapes(&e.shape, Kind::Vertex)
                    .iter()
                    .filter_map(kernel::bbox)
                    .any(|b| DVec3::new(b[0], b[1], b[2]).distance(top) < 1e-3)
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

/// Rests a ball of radius `r` on mesh nodes of the curved faces near the corner that lie off `base`, so on the new
/// round, and finds how far the ball reaches past the body's faces. Exact distances, so a sample of the nodes.
fn ball_rests(base: &Shape, s: &Shape, r: f64) -> Result<(), String> {
    let faces = kernel::subshapes(s, Kind::Face);
    let skin = kernel::compound(&faces);
    let base_skin = kernel::compound(&kernel::subshapes(base, Kind::Face));
    let view = mesh::body_payload(s, "check", "check", 0.01, viewport_profile(1));
    let normals = view.normals.clone().expect("normals");
    let at = |v: &[f32], i: usize| DVec3::new(v[3 * i] as f64, v[3 * i + 1] as f64, v[3 * i + 2] as f64);
    let corner = DVec3::new(W / 2.0, D / 2.0, H);
    let mut on_curved = vec![false; view.positions.len() / 3];
    for (t, &f) in view.face_ids.iter().enumerate() {
        if !kernel::face_is_planar(&faces[f as usize]) {
            for k in 0..3 {
                on_curved[view.indices[3 * t + k] as usize] = true;
            }
        }
    }
    let near: Vec<usize> = (0..on_curved.len())
        .filter(|&i| on_curved[i] && at(&view.positions, i).distance(corner) < 3.0 * H / 2.0)
        .collect();
    let step = near.len().div_ceil(SAMPLES).max(1);
    let (mut worst, mut tried) = ((0.0f64, DVec3::ZERO), 0);
    for &i in near.iter().step_by(step) {
        let p = at(&view.positions, i);
        if kernel::distance_to_point(&base_skin, p.to_array()).is_none_or(|d| d < 0.01) {
            continue;
        }
        tried += 1;
        let centre = p - r * at(&normals, i).normalize();
        let reach = r - kernel::distance_to_point(&skin, centre.to_array()).unwrap_or(0.0);
        if reach > worst.0 {
            worst = (reach, p);
        }
    }
    if tried == 0 {
        return Err("no node of the round was found to rest a ball on".into());
    }
    if worst.0 > BALL_SLACK * r {
        return Err(format!(
            "a {r}mm ball resting at {:.3?} stands {:.4}mm out of the body, over {tried} nodes",
            worst.1.to_array(),
            worst.0
        ));
    }
    Ok(())
}

fn smooth_build(base: &Shape, r: &Rebuild, size: f64) -> Result<(), String> {
    if !r.errors.is_empty() {
        return Err(r.errors.iter().map(|e| e.message.clone()).collect::<Vec<_>>().join(" | "));
    }
    let s = &r.bodies[0].shape;
    if !ops::is_valid(s) {
        return Err("built an invalid solid".into());
    }
    meshes_to_its_area(s).map_err(|why| format!("built but torn: {why}"))?;
    ball_rests(base, s, size).map_err(|why| format!("built but not smooth: {why}"))
}

/// Each face's mesh covers its exact area, within half a square mm and 2 percent, so no face is torn, folded or
/// left as a flap the resting ball never reaches.
fn meshes_to_its_area(s: &Shape) -> Result<(), String> {
    let faces = kernel::subshapes(s, Kind::Face);
    let view = mesh::body_payload(s, "check", "check", 0.01, viewport_profile(1));
    let at = |i: u32| DVec3::from_array([0, 1, 2].map(|c| view.positions[3 * i as usize + c] as f64));
    let mut meshed = vec![0.0f64; faces.len()];
    for (t, &f) in view.face_ids.iter().enumerate() {
        let [a, b, c] = [0, 1, 2].map(|k| at(view.indices[3 * t + k]));
        meshed[f as usize] += 0.5 * (b - a).cross(c - a).length();
    }
    let off: Vec<String> = faces
        .iter()
        .zip(&meshed)
        .enumerate()
        .filter_map(|(i, (f, &m))| {
            let exact = kernel::face_area_centre(f).map_or(0.0, |a| a[0]);
            ((m - exact).abs() > 0.5 + 0.02 * exact).then(|| format!("face {i} meshes to {m:.3} of {exact:.3} mm2"))
        })
        .collect();
    if off.is_empty() {
        Ok(())
    } else {
        Err(off.join(", "))
    }
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

/// The kernel builds these smooth, up to a cap a few microns wide or a triangle too small to see where the round
/// runs out to a point.
#[test]
fn a_corner_round_whose_end_narrows_to_a_point_builds_smooth() {
    check(&[("G2", 5.0, 1.0, true), ("G2", 8.0, 3.0, true), ("G2", 8.0, 5.0, true)]);
}

/// The reported round on 8 mm G3 top rounds, which have room for it. The kernel built this same body before the
/// seam gauge existed, its only area error on a cap of no area, so this guards the gauge against refusing it.
#[test]
fn the_reported_corner_round_on_g3_top_rounds_builds_smooth() {
    check(&[("G3", 8.0, 3.85, true)]);
}

/// A G1 round as large as the top round has no room, and a G2 top round of 5 mm curves tighter than a 3.85 mm
/// ball near its middle (1.37 / 5 per mm), so no rolling ball round of that size rests on it.
#[test]
fn a_corner_round_too_large_for_its_top_rounds_offers_a_size_that_builds_smooth() {
    check(&[("G1", 3.0, 3.0, false), ("G2", 5.0, 3.85, false), ("G3", 5.0, 3.85, false)]);
}

/// A smaller size is tried with the second distance scaled with it, so the size a refusal offers builds with the
/// second distance scaled the same way.
#[test]
fn a_two_distance_chamfer_into_the_seam_builds_or_offers_a_size_that_builds() {
    let mut wrong = Vec::new();
    for (cont, top, d, d2) in [("G1", 3.0, 3.0, 1.5), ("G2", 5.0, 5.0, 2.5)] {
        let base = build(&doc(cont, top, None)).bodies[0].shape.clone();
        let at = chain_points(&base);
        let chamfer = |size: f64, second: f64| {
            let mut v = doc(cont, top, Some((size, &at)));
            v["features"][3] = json!({"id": "f4", "type": "chamfer", "distance": size, "chamferType": "twoDistance",
                "distance2": second, "edges": v["features"][3]["edges"].clone()});
            build(&v)
        };
        let got = chamfer(d, d2);
        let Some(e) = got.errors.first() else {
            if !ops::is_valid(&got.bodies[0].shape) {
                wrong.push(format!("{cont} top {top}: built an invalid solid"));
            }
            continue;
        };
        let Some(fits) = offered(&e.message) else {
            wrong.push(format!("{cont} top {top}: refused with no size: {}", e.message));
            continue;
        };
        let again = chamfer(fits, d2 * fits / d);
        if !again.errors.is_empty() || !ops::is_valid(&again.bodies[0].shape) {
            wrong.push(format!("{cont} top {top}: offered {fits}mm, which does not build: {:?}", again.errors));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Every size the bug was probed at.
#[test]
#[ignore = "takes about 7 minutes"]
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
