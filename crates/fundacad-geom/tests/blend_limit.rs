//! A blend the kernel refuses is built from its sections only where a ball of
//! that size really rolls along the edge: a fill's ball resting on both faces,
//! a cut's running on past a face into the air above it, never into the body.
//! Past that the build says so, with the largest size that fits.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

/// One build at a time, as in blend_overrun.rs.
fn build(doc: &Value) -> (Rebuild, f64) {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let t = std::time::Instant::now();
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    (r, t.elapsed().as_secs_f64())
}

fn built(doc: &Value) -> (Shape, f64) {
    let (r, secs) = build(doc);
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(r.bodies.len(), 1);
    let s = r.bodies[0].shape.clone();
    assert_eq!(kernel::count(&s, Kind::Solid), 1);
    (s, secs)
}

fn refused(doc: &Value) -> (String, Option<String>, f64) {
    let (r, secs) = build(doc);
    let e = r.errors.first().unwrap_or_else(|| panic!("the blend built, {:?}", r.diagnostics));
    (e.message.clone(), e.code.clone(), secs)
}

fn fillet(point: [f64; 3], r: f64) -> Value {
    json!({"id": "round", "type": "fillet", "radius": r,
           "edges": [{"kind": "edge", "by": "nearest", "point": point}]})
}

fn doc(mut features: Vec<Value>, blend: Option<Value>) -> Value {
    features.extend(blend);
    json!({"parameters": {}, "features": features})
}

/// A cup rounded r8 outside, its top pressed 10 and the floor 4.1 further:
/// a recess of radius 22 and 14.1 deep.
fn recess(r: Option<f64>) -> Value {
    doc(
        vec![
            json!({"id": "sk", "type": "sketch", "plane": "XY", "entities": [
                {"type": "circle", "id": "c", "x": 0, "y": 0, "radius": 30}]}),
            json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 30, "operation": "new"}),
            json!({"id": "fi", "type": "fillet", "radius": 8,
                   "edges": [{"kind": "edge", "by": "nearest", "point": [0, 30, 30]}]}),
            json!({"id": "pp1", "type": "press-pull", "distance": -10,
                   "face": {"kind": "face", "by": "nearest", "point": [0, 0, 30]}}),
            json!({"id": "pp2", "type": "press-pull", "distance": -4.1,
                   "face": {"kind": "face", "by": "nearest", "point": [0, 0, 20]}}),
        ],
        r.map(|r| fillet([0.0, 22.0, 15.9], r)),
    )
}

#[test]
fn a_floor_round_deeper_than_its_recess_refuses_with_the_size_that_fits() {
    for r in [32.9, 20.0, 14.5] {
        let (msg, code, secs) = refused(&recess(Some(r)));
        assert_eq!(code.as_deref(), Some("blendTooLarge"), "{msg}");
        assert!(msg.contains(&format!("at {r}mm")) && msg.contains("up to 14.09mm"), "{msg}");
        assert!(secs < 5.0, "{r}: took {secs} s");
    }

    let (base, _) = built(&recess(None));
    let r = 14.09;
    let (out, _) = built(&recess(Some(r)));
    assert_eq!(kernel::count(&out, Kind::Face), kernel::count(&base, Kind::Face) + 1);
    // The fill is the square corner less the quarter disc, its centroid that
    // far in from the wall, revolved.
    let area = r * r * (1.0 - PI / 4.0);
    let inward = r * (5.0 / 6.0 - PI / 4.0) / (1.0 - PI / 4.0);
    let want = kernel::volume(&base) + 2.0 * PI * (22.0 - inward) * area;
    let got = kernel::volume(&out);
    assert!((got - want).abs() < 1e-3 * want, "volume {got}, a {r}mm fill holds {want}");
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

/// A profile on XZ spun about Z: `pts` joined by lines, except the arc from
/// `pts[arc]` to the next one about `centre`.
fn turned(pts: &[[f64; 2]], arc: usize, centre: [f64; 2]) -> Vec<Value> {
    let mut entities = Vec::new();
    for i in 0..pts.len() {
        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
        if i != arc {
            entities.push(line(&format!("l{i}"), a, b));
            continue;
        }
        let rad = (a[0] - centre[0]).hypot(a[1] - centre[1]);
        let mid = [0.5 * (a[0] + b[0]) - centre[0], 0.5 * (a[1] + b[1]) - centre[1]];
        let k = rad / mid[0].hypot(mid[1]);
        entities.push(json!({"type": "arc", "id": "a", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1],
                             "mx": centre[0] + mid[0] * k, "my": centre[1] + mid[1] * k}));
    }
    vec![
        json!({"id": "sk", "type": "sketch", "plane": "XZ", "entities": entities}),
        json!({"id": "part", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"}),
    ]
}

/// What a ball resting on the rim's inner face and its top plane cuts away,
/// revolved: the part of the ring between the two contacts that lies outside
/// the ball.
fn carved(base: &Shape, inner: [f64; 2], centre: [f64; 2], r: f64) -> f64 {
    let (x0, x1, z0, z1) = (inner[0] - 1e-3, centre[0], inner[1], centre[1] + r + 1.0);
    let ring = kernel::polygon_face(&[[x0, 0.0, z0], [x1, 0.0, z0], [x1, 0.0, z1], [x0, 0.0, z1]])
        .and_then(|f| kernel::revolve(&f, [0.0; 3], [0.0, 0.0, 1.0], 360.0))
        .expect("ring");
    let ball = kernel::translated(&kernel::make_torus(centre[0], r).expect("torus"), [0.0, 0.0, centre[1]])
        .expect("moved");
    let tool = kernel::boolean_op(&ring, &[&ball], BoolKind::Cut).expect("tool");
    kernel::volume(&kernel::boolean_op(base, &[&tool], BoolKind::Cut).expect("carve"))
}

/// The ball on the inner face: `bend` the centre of that face's arc in the
/// profile and `radius` its radius, the ball `r` outside it and under the top
/// plane at `top`. Its centre and its contact with the arc.
fn ball_on(bend: [f64; 2], radius: f64, top: f64, r: f64) -> ([f64; 2], [f64; 2]) {
    let cz = top - r;
    let cx = bend[0] + ((radius + r).powi(2) - (cz - bend[1]).powi(2)).sqrt();
    let (dx, dz) = (cx - bend[0], cz - bend[1]);
    let d = dx.hypot(dz);
    ([cx, cz], [bend[0] + dx / d * radius, bend[1] + dz / d * radius])
}

/// Past the top face's outer edge the round takes that whole face's place.
fn check_rim(features: &[Value], rim: [f64; 3], outer: f64, bend: [f64; 2], radius: f64, r: f64) {
    let (base, _) = built(&doc(features.to_vec(), None));
    let (out, secs) = built(&doc(features.to_vec(), Some(fillet(rim, r))));
    let (centre, contact) = ball_on(bend, radius, rim[2], r);
    let faces = kernel::count(&base, Kind::Face) + usize::from(centre[0] < outer);
    assert_eq!(kernel::count(&out, Kind::Face), faces, "{r}");
    let want = carved(&base, contact, centre, r);
    let got = kernel::volume(&out);
    assert!((got - want).abs() < 1e-3 * want, "{r}: volume {got}, the ball carves to {want}");
    assert!(secs < 10.0, "{r}: took {secs} s");
}

/// A pocket whose wall is a quarter round, a concave torus from the top face
/// down to the floor. The rim's ball stays on the torus at every size, past
/// the top face's outer edge it carves the rim away.
#[test]
fn a_rim_next_to_a_concave_torus_rounds_and_carves() {
    let features = turned(
        &[[0.0, 0.0], [30.0, 0.0], [30.0, 20.0], [20.0, 20.0], [12.0, 12.0], [0.0, 12.0]],
        3,
        [12.0, 20.0],
    );
    for r in [4.0, 18.0] {
        check_rim(&features, [20.0, 0.0, 20.0], 30.0, [12.0, 20.0], 8.0, r);
    }
}

/// A pocket whose floor is a spherical bowl running up to the top face.
#[test]
fn a_rim_next_to_a_sphere_cap_rounds_and_carves() {
    let rs = 325f64.sqrt();
    let features = turned(&[[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [15.0, 20.0], [0.0, 30.0 - rs]], 3, [0.0, 30.0]);
    for r in [3.0, 14.0] {
        check_rim(&features, [15.0, 0.0, 20.0], 20.0, [0.0, 30.0], rs, r);
    }
}

/// A boss on a plate: its rim rounded taller than the boss would dig a groove
/// into the plate, which is no corner of that rim.
#[test]
fn a_boss_rim_rounded_past_the_boss_refuses() {
    let features = vec![
        json!({"id": "s1", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "id": "c", "x": 0, "y": 0, "radius": 30}]}),
        json!({"id": "plate", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"}),
        json!({"id": "s2", "type": "sketch", "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
               "entities": [{"type": "circle", "id": "b", "x": 0, "y": 0, "radius": 10}]}),
        json!({"id": "boss", "type": "extrude", "sketch": "s2", "distance": 5, "operation": "join"}),
    ];
    let (msg, code, _) = refused(&doc(features.clone(), Some(fillet([10.0, 0.0, 15.0], 8.0))));
    assert_eq!(code.as_deref(), Some("blendTooLarge"), "{msg}");
    assert!(msg.contains("into the body") && msg.contains("up to 4.99mm"), "{msg}");
    built(&doc(features, Some(fillet([10.0, 0.0, 15.0], 4.99))));
}
