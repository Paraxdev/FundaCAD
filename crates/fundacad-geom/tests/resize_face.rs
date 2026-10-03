//! A round face resized about its own axis: the faces around it keep their
//! own surfaces and are trimmed or extended to meet it, a slot end shrunk
//! below the slot's half width narrows the whole slot, and sizes with no
//! valid result are refused with the reason.

use std::f64::consts::PI;

use fundacad_geom::builder::Fail;
use fundacad_geom::features::resize::{self, describe, plain_cells, Resize};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use fundacad_geom::select::Resolver;
use glam::{dvec3, DVec3};
use opencascade::primitives::{Shape, ShapeType};
use opencascade_sys::face_query as fq;
use serde_json::json;

fn cut(a: &Shape, b: &Shape) -> Shape {
    kernel::unify_body(&kernel::boolean_op(a, &[b], BoolKind::Cut).unwrap())
}

fn fuse(a: &Shape, b: &Shape) -> Shape {
    kernel::unify_body(&kernel::boolean_op(a, &[b], BoolKind::Fuse).unwrap())
}

fn plate(t: f64) -> Shape {
    Shape::box_from_corners(dvec3(-20.0, -20.0, 0.0), dvec3(20.0, 20.0, t))
}

fn hole(r: f64) -> Shape {
    cut(&plate(10.0), &Shape::cylinder(dvec3(0.0, 0.0, -1.0), r, DVec3::Z, 12.0))
}

/// A slot 4 wide with its round ends at x = ±8, through a 40 x 40 x 10 plate.
fn slot() -> Shape {
    let tool = fuse(
        &fuse(
            &Shape::box_from_corners(dvec3(-8.0, -2.0, -1.0), dvec3(8.0, 2.0, 11.0)),
            &Shape::cylinder(dvec3(-8.0, 0.0, -1.0), 2.0, DVec3::Z, 12.0),
        ),
        &Shape::cylinder(dvec3(8.0, 0.0, -1.0), 2.0, DVec3::Z, 12.0),
    );
    cut(&plate(10.0), &tool)
}

/// The slot's volume at width `w`.
fn slot_volume(w: f64) -> f64 {
    16000.0 - 10.0 * (16.0 * w + PI * (w / 2.0) * (w / 2.0))
}

const SLOT_END: [f64; 3] = [10.0, 0.0, 5.0];

fn face_at(body: &Shape, p: [f64; 3]) -> Shape {
    Resolver::new(None, None)
        .faces(body, &json!({"kind": "face", "by": "nearest", "point": p}))
        .expect("a face")
        .remove(0)
}

fn faces(body: &Shape) -> Vec<Shape> {
    body.shape_map(ShapeType::Face).iter().collect()
}

/// (kind, direction, location, radius) as the kernel reports the surface.
fn surface(face: &Shape) -> (i32, DVec3, DVec3, f64) {
    let mut o = [0.0; 13];
    let k = fq::FQ_surface(face.raw(), &mut o).unwrap_or(-1);
    (k, dvec3(o[1], o[2], o[3]), dvec3(o[4], o[5], o[6]), o[7])
}

/// The cylinder faces of `body` on the vertical axis through (x, y), by radius.
fn radii_on_axis(body: &Shape, x: f64, y: f64) -> Vec<f64> {
    faces(body)
        .iter()
        .map(surface)
        .filter(|(k, d, l, _)| *k == 1 && d.cross(DVec3::Z).length() < 1e-9 && (l.x - x).hypot(l.y - y) < 1e-6)
        .map(|(_, _, _, r)| r)
        .collect()
}

fn run(body: &Shape, faces: &[Shape], d: f64, follow: bool) -> Resize {
    resize::resize(body, faces, d, follow)
}

fn built(r: Resize) -> Shape {
    match r {
        Resize::Built(s) => {
            assert!(s.is_valid().unwrap_or(false), "a valid result");
            assert_eq!(kernel::count(&s, Kind::Solid), 1);
            s
        }
        Resize::Refused(f) => panic!("refused: {f:?}"),
        Resize::Failed => panic!("the kernel failed"),
    }
}

fn refused(r: Resize) -> (&'static str, String) {
    match r {
        Resize::Refused(Fail::Value { message, code: Some(code) }) => (code, message),
        Resize::Refused(f) => panic!("refused without a code: {f:?}"),
        Resize::Built(s) => panic!("built, volume {}", kernel::volume(&s)),
        Resize::Failed => panic!("the kernel failed"),
    }
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

/// Area of a disc of radius `r` on the side x < a of a chord at distance a from its centre.
fn disc_short_of(r: f64, a: f64) -> f64 {
    if r <= a {
        return PI * r * r;
    }
    PI * r * r - (r * r * (a / r).acos() - a * (r * r - a * a).sqrt())
}

#[test]
fn growing_a_slot_end_gives_a_bigger_round_end_and_trims_the_walls_back() {
    let body = slot();
    let v0 = kernel::volume(&body);
    assert!(close(v0, 15234.336, 1e-3), "{v0}");
    let out = built(run(&body, &[face_at(&body, SLOT_END)], -1.0, true));
    let (r, big_r, h) = (2.0f64, 3.0f64, 10.0);
    let want = -h * (PI * big_r * big_r - PI * r * r / 2.0 - r * (big_r * big_r - r * r).sqrt() - big_r * big_r * (r / big_r).asin());
    let dv = kernel::volume(&out) - v0;
    assert!(close(dv, want, 1e-2), "{dv} against {want}");
    assert_eq!(radii_on_axis(&out, 8.0, 0.0), vec![3.0]);
    let radial = faces(&out).iter().map(surface).any(|(k, n, l, _)| {
        k == 0 && n.dot(DVec3::Z).abs() < 1e-9 && (dvec3(8.0, 0.0, l.z) - l).dot(n).abs() < 1e-4
    });
    assert!(!radial, "a wall square to the slot end");
    for y in [-2.0, 2.0] {
        let wall = faces(&out).into_iter().find(|f| {
            let (k, n, l, _) = surface(f);
            k == 0 && n.cross(DVec3::Y).length() < 1e-9 && close(l.y, y, 1e-9)
        });
        let b = kernel::bbox(&wall.expect("the wall")).unwrap();
        assert!(close(b[3], 8.0 - 5f64.sqrt(), 1e-6), "the wall ends where the r3 end crosses it: {b:?}");
    }
}

#[test]
fn shrinking_a_slot_end_narrows_the_whole_slot_when_tangent_faces_follow() {
    let body = slot();
    let out = built(run(&body, &[face_at(&body, SLOT_END)], 0.5, true));
    assert!(close(kernel::volume(&out), slot_volume(3.0), 1e-3), "{}", kernel::volume(&out));
    assert_eq!(radii_on_axis(&out, 8.0, 0.0), vec![1.5]);
    assert_eq!(radii_on_axis(&out, -8.0, 0.0), vec![1.5]);
}

#[test]
fn shrinking_a_slot_end_with_tangent_faces_kept_is_refused_naming_them() {
    let body = slot();
    let (code, message) = refused(run(&body, &[face_at(&body, SLOT_END)], 0.5, false));
    assert_eq!(code, "tangentLost");
    assert!(message.contains("2 flat faces"), "{message}");
    assert!(message.contains("Tangent faces follow"), "{message}");
    assert!(message.contains("smaller"), "{message}");
}

/// The slot with its +x end grown to r 3, so its walls meet the end at an angle.
fn bulged() -> Shape {
    let body = slot();
    let out = built(run(&body, &[face_at(&body, SLOT_END)], -1.0, true));
    assert!(close(kernel::volume(&out), 15124.822, 1e-2), "{}", kernel::volume(&out));
    out
}

#[test]
fn a_bulged_end_shrunk_past_the_walls_narrows_the_slot() {
    let b1 = bulged();
    let f1 = face_at(&b1, [11.0, 0.0, 5.0]);
    let out = built(run(&b1, &[f1.clone()], 1.5, true));
    assert!(close(kernel::volume(&out), slot_volume(3.0), 1e-3), "{}", kernel::volume(&out));
    // Without the rule a stale strip of the r 3 surface is left inside the slot.
    match plain_cells(&b1, &f1, 1.5) {
        Resize::Built(s) => panic!("the stale strip was built, volume {}", kernel::volume(&s)),
        Resize::Refused(Fail::Value { code, .. }) => assert_eq!(code, Some("stepLeft")),
        _ => panic!("expected the step guard"),
    }
    let (code, message) = refused(run(&b1, &[face_at(&b1, [11.0, 0.0, 5.0])], 1.5, false));
    assert_eq!(code, "tangentLost");
    assert!(message.contains("2 flat faces"), "{message}");
}

#[test]
fn a_bulged_end_shrunk_short_of_the_walls_extends_them() {
    let b1 = bulged();
    let out = built(run(&b1, &[face_at(&b1, [11.0, 0.0, 5.0])], 0.5, false));
    let r = 2.5f64;
    let strip = 2.0 * (2.0 * (r * r - 4.0).sqrt() + r * r * (2.0 / r).asin());
    let union = 64.0 + 2.0 * PI + PI * r * r - strip / 2.0;
    let want = 16000.0 - 10.0 * union;
    assert!(close(kernel::volume(&out), want, 1e-2), "{} against {want}", kernel::volume(&out));
    assert_eq!(radii_on_axis(&out, 8.0, 0.0), vec![2.5]);
    assert_eq!(radii_on_axis(&out, -8.0, 0.0), vec![2.0], "the other end stays");
    let wall = faces(&out).into_iter().find(|f| {
        let (k, n, l, _) = surface(f);
        k == 0 && n.cross(DVec3::Y).length() < 1e-9 && close(l.y, 2.0, 1e-9)
    });
    let b = kernel::bbox(&wall.expect("the wall")).unwrap();
    assert!(close(b[3], 8.0 - (r * r - 4.0).sqrt(), 1e-6), "{b:?}");
}

#[test]
fn every_face_of_a_slot_selected_widens_the_slot_once() {
    let body = slot();
    let picks = [SLOT_END, [-10.0, 0.0, 5.0], [0.0, 2.0, 5.0], [0.0, -2.0, 5.0]];
    let all: Vec<Shape> = picks.iter().map(|p| face_at(&body, *p)).collect();
    for follow in [true, false] {
        let out = built(run(&body, &all, -0.5, follow));
        let v = kernel::volume(&out);
        assert!(close(v, slot_volume(5.0), 1e-2), "{v}");
        assert!(close(v - kernel::volume(&body), -230.69, 1e-2), "{v}");
    }
}

fn d_hole() -> Shape {
    let tool = kernel::boolean_op(
        &Shape::cylinder(dvec3(0.0, 0.0, -1.0), 3.0, DVec3::Z, 12.0),
        &[&Shape::box_from_corners(dvec3(-5.0, -5.0, -2.0), dvec3(2.0, 5.0, 13.0))],
        BoolKind::Common,
    )
    .unwrap();
    cut(&plate(10.0), &tool)
}

#[test]
fn a_d_hole_keeps_its_flat_until_the_round_wall_passes_it() {
    let body = d_hole();
    let v0 = kernel::volume(&body);
    for (d, flat) in [(-1.0, true), (0.5, true), (1.5, false)] {
        let out = built(run(&body, &[face_at(&body, [-3.0, 0.0, 5.0])], d, true));
        let r = 3.0 - d;
        let want = -10.0 * (disc_short_of(r, 2.0) - disc_short_of(3.0, 2.0));
        let dv = kernel::volume(&out) - v0;
        assert!(close(dv, want, 1e-2), "{d}: {dv} against {want}");
        let has_flat = faces(&out).iter().map(surface).any(|(k, n, l, _)| k == 0 && n.cross(DVec3::X).length() < 1e-9 && close(l.x, 2.0, 1e-9));
        assert_eq!(has_flat, flat, "{d}");
        assert_eq!(radii_on_axis(&out, 0.0, 0.0), vec![r], "{d}");
    }
}

#[test]
fn a_round_hole_grows_by_the_full_amount_asked() {
    let body = hole(3.0);
    let out = built(run(&body, &[face_at(&body, [-3.0, 0.0, 5.0])], -3.0, true));
    let dv = kernel::volume(&out) - kernel::volume(&body);
    assert!(close(dv, -PI * (36.0 - 9.0) * 10.0, 1e-2), "{dv}");
}

fn pin(body: &Shape, at: [f64; 3], d: f64, want: f64) {
    let out = built(run(body, &[face_at(body, at)], d, true));
    let dv = kernel::volume(&out) - kernel::volume(body);
    assert!(close(dv, want, 1e-2), "{at:?} {d}: {dv} against {want}");
}

#[test]
fn holes_bosses_countersinks_and_dimples_match_the_kernel_offset() {
    let blind = cut(&plate(10.0), &Shape::cylinder(dvec3(0.0, 0.0, 4.0), 3.0, DVec3::Z, 7.0));
    pin(&blind, [-3.0, 0.0, 7.0], -1.0, -PI * 7.0 * 6.0);
    pin(&blind, [-3.0, 0.0, 7.0], 1.0, PI * 5.0 * 6.0);
    let boss = fuse(&plate(5.0), &Shape::cylinder(dvec3(0.0, 0.0, 4.0), 5.0, DVec3::Z, 11.0));
    pin(&boss, [5.0, 0.0, 10.0], 1.0, PI * 11.0 * 10.0);
    pin(&boss, [5.0, 0.0, 10.0], -1.0, -PI * 9.0 * 10.0);
    let cone = Shape::cone().at(dvec3(0.0, 0.0, 7.0)).bottom_radius(2.0).top_radius(6.0).height(4.0).build();
    let sink = cut(&hole(2.0), &cone);
    pin(&sink, [3.5, 0.0, 8.5], -0.5, -54.874);
    pin(&sink, [3.5, 0.0, 8.5], 0.5, 39.167);
    let dimple = cut(&plate(10.0), &Shape::sphere(5.0).at(dvec3(0.0, 0.0, 13.0)).build());
    let on = [2.0, 0.0, 13.0 - 21f64.sqrt()];
    pin(&dimple, on, -1.0, -86.917);
    pin(&dimple, on, 1.0, 42.935);
}

/// The hole runs out through a curved top: the top keeps its curve over the
/// new hole, so the change is the annulus under it.
#[test]
fn a_hole_under_a_curved_top_is_filled_up_to_the_curve() {
    let top = Shape::cylinder(dvec3(0.0, -30.0, -20.0), 30.0, DVec3::Y, 60.0);
    let solid = kernel::boolean_op(&plate(30.0), &[&top], BoolKind::Common).unwrap();
    let body = cut(&solid, &Shape::cylinder(dvec3(4.0, 0.0, -1.0), 2.5, DVec3::Z, 40.0));
    let height = |x: f64| -20.0 + (900.0 - x * x).sqrt();
    for (d, r0, r1) in [(-1.0, 2.5, 3.5), (1.0, 1.5, 2.5)] {
        let (nr, nt) = (200, 720);
        let (dr, dt) = ((r1 - r0) / f64::from(nr), 2.0 * PI / f64::from(nt));
        let mut annulus = 0.0;
        for i in 0..nr {
            let rho = r0 + (f64::from(i) + 0.5) * dr;
            for j in 0..nt {
                let t = (f64::from(j) + 0.5) * dt;
                annulus += height(4.0 + rho * t.cos()) * rho * dr * dt;
            }
        }
        let want = if d < 0.0 { -annulus } else { annulus };
        let out = built(run(&body, &[face_at(&body, [1.5, 0.0, 3.0])], d, true));
        // The quick volume misses this curved top by a few hundredths.
        let dv = kernel::volume_precise(&out) - kernel::volume_precise(&body);
        assert!(close(dv, want, 1e-3), "{d}: {dv} against {want}");
    }
}

#[test]
fn sizes_with_no_valid_result_are_refused_with_the_reason() {
    let small = hole(2.0);
    let (code, message) = refused(run(&small, &[face_at(&small, [-2.0, 0.0, 5.0])], 2.0, true));
    assert_eq!(code, "sizeAtZero", "{message}");
    let body = hole(3.0);
    let (code, message) = refused(run(&body, &[face_at(&body, [-3.0, 0.0, 5.0])], -18.0, true));
    assert_eq!(code, "cutsApart", "{message}");
    let dimple = cut(&plate(10.0), &Shape::sphere(5.0).at(dvec3(0.0, 0.0, 13.0)).build());
    let (code, message) = refused(run(&dimple, &[face_at(&dimple, [2.0, 0.0, 13.0 - 21f64.sqrt()])], 4.5, true));
    assert_eq!(code, "faceVanishes", "{message}");
}

/// A 30 x 20 x 20 block with its top +x edge rounded r 5.
fn filleted_block() -> Shape {
    let block = Shape::box_from_corners(dvec3(0.0, -10.0, 0.0), dvec3(30.0, 10.0, 20.0));
    let corner = cut(
        &Shape::box_from_corners(dvec3(25.0, -11.0, 15.0), dvec3(31.0, 11.0, 21.0)),
        &Shape::cylinder(dvec3(25.0, -12.0, 15.0), 5.0, DVec3::Y, 24.0),
    );
    cut(&block, &corner)
}

const ROUND: [f64; 3] = [25.0 + 5.0 * std::f64::consts::FRAC_1_SQRT_2, 0.0, 15.0 + 5.0 * std::f64::consts::FRAC_1_SQRT_2];

#[test]
fn a_lone_round_edge_shrunk_is_refused_since_its_faces_do_not_close_a_loop() {
    let body = filleted_block();
    let (code, message) = refused(run(&body, &[face_at(&body, ROUND)], -1.0, true));
    assert_eq!(code, "runUnsupported");
    assert!(message.contains("smallest it goes on its own is R5.00"), "{message}");
    let (code, message) = refused(run(&body, &[face_at(&body, ROUND)], -1.0, false));
    assert_eq!(code, "tangentLost");
    assert!(message.contains("2 flat faces"), "{message}");
}

/// A bore r 3 from the top of a 20 thick plate, ending in a ball at z = 8.
fn ball_end_bore() -> Shape {
    let bore = fuse(
        &Shape::cylinder(dvec3(0.0, 0.0, 8.0), 3.0, DVec3::Z, 13.0),
        &Shape::sphere(3.0).at(dvec3(0.0, 0.0, 8.0)).build(),
    );
    cut(&Shape::box_from_corners(dvec3(-20.0, -20.0, 0.0), dvec3(20.0, 20.0, 20.0)), &bore)
}

#[test]
fn a_ball_ended_bore_grown_leaves_the_ball_behind_and_narrowed_keeps_it_whole() {
    let body = ball_end_bore();
    let at = [3.0, 0.0, 15.0];
    let (code, message) = refused(run(&body, &[face_at(&body, at)], -0.5, false));
    assert_eq!(code, "tangentLost");
    assert!(message.contains("the ball face") && message.contains("bigger"), "{message}");
    let (code, message) = refused(run(&body, &[face_at(&body, at)], -0.5, true));
    assert_eq!(code, "runUnsupported");
    assert!(message.contains("largest it goes on its own is R3.00"), "{message}");
    // Narrowed to r 2: the ball stays a whole sphere, so the bore fills only above it.
    let want = PI * (60.0 - 10.0 / 3.0 * 5f64.sqrt());
    pin(&body, at, 1.0, want);
}

/// The same block with its edge rounded by a fillet feature, whose faces share
/// geometry the way a rebuilt document's do.
fn fillet_feature_block() -> Shape {
    let pts = [[0.0, 0.0], [30.0, 0.0], [30.0, 20.0], [0.0, 20.0]];
    let lines: Vec<_> = (0..4)
        .map(|i| {
            let (a, b): ([f64; 2], [f64; 2]) = (pts[i], pts[(i + 1) % 4]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        })
        .collect();
    let raw = json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": "XZ", "entities": lines},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 20, "symmetric": true, "operation": "new"},
        {"id": "fl", "type": "fillet", "radius": 5, "edges": [{"kind": "edge", "by": "nearest", "point": [30.0, 0.0, 20.0]}]}
    ]});
    let doc: fundacad_core::CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let r = fundacad_geom::builder::rebuild(&doc, &raw, &fundacad_geom::builder::NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r.bodies[0].shape.clone()
}

#[test]
fn checking_a_result_in_pieces_leaves_the_input_alone() {
    let body = fillet_feature_block();
    let v0 = kernel::volume(&body);
    assert!(close(v0, 23785.398, 1e-2), "{v0}");
    let ring = |r: f64| Shape::cylinder(dvec3(25.0, 60.0, 15.0), r, -DVec3::Y, 120.0);
    let band = kernel::boolean_op(&ring(5.0), &[&ring(4.0)], BoolKind::Cut).unwrap();
    let pieces = kernel::boolean_op(&body, &[&band], BoolKind::Common).unwrap();
    let out = kernel::boolean_op(&body, &[&pieces], BoolKind::Cut).unwrap();
    assert_eq!(kernel::count(&kernel::unwrap_compound(&out), Kind::Solid), 2);
    match resize::checked_solid(&body, &out, true) {
        Err(resize::Bad::Refused(Fail::Value { code, .. })) => assert_eq!(code, Some("cutsApart")),
        _ => panic!("a result in two pieces was accepted"),
    }
    assert!(close(kernel::volume(&body), v0, 1e-9), "{} against {v0}", kernel::volume(&body));
}

#[test]
fn describe_reads_a_slot_end_and_a_round_hole() {
    let body = slot();
    let info = describe(&body, &face_at(&body, SLOT_END)).expect("a round face");
    assert_eq!(info.kind, "cylinder");
    assert!(close(info.size, 2.0, 1e-9) && info.concave && !info.full);
    assert_eq!(info.contact, Some(2.0));
    assert_eq!(info.tangent.faces, 2);
    assert_eq!(info.tangent.lost_when, Some("shrink"));
    assert_eq!(info.tangent.run.len(), 4);
    assert!(info.tangent.closed && info.tangent.followable);
    let body = hole(3.0);
    let info = describe(&body, &face_at(&body, [-3.0, 0.0, 5.0])).expect("a round face");
    assert!(info.full && info.concave);
    assert_eq!(info.tangent.faces, 0);
    assert_eq!(info.contact, None);
    let block = filleted_block();
    let info = describe(&block, &face_at(&block, ROUND)).expect("a round face");
    assert!(!info.concave && info.tangent.faces == 2 && !info.tangent.closed && !info.tangent.followable);
}
