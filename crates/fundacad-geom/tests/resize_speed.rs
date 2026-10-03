//! A round face resize is fast enough to drag: on the c1 report each lone
//! face step builds in under 400 ms and a whole slot narrowing in under a
//! second, and a drag asking the same face again at new sizes gets the same
//! answers as fresh resizes. The timings only mean something in a release
//! build, so that test is ignored by default:
//! `cargo test --release -p fundacad-geom --test resize_speed -- --ignored`.

use std::f64::consts::PI;
use std::time::{Duration, Instant};

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, Fail, NoWatch};
use fundacad_geom::features::resize::{self, Resize};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use fundacad_geom::select::Resolver;
use glam::{dvec3, DVec3};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const C1: &str = include_str!("press_pull/c1_slot_end.json");

fn cut(a: &Shape, b: &Shape) -> Shape {
    kernel::unify_body(&kernel::boolean_op(a, &[b], BoolKind::Cut).unwrap())
}

fn fuse(a: &Shape, b: &Shape) -> Shape {
    kernel::unify_body(&kernel::boolean_op(a, &[b], BoolKind::Fuse).unwrap())
}

/// A slot `w` wide with its round ends at x = ±8, through a 40 x 40 x 10 plate.
fn slot(w: f64) -> Shape {
    let r = w / 2.0;
    let tool = fuse(
        &fuse(
            &Shape::box_from_corners(dvec3(-8.0, -r, -1.0), dvec3(8.0, r, 11.0)),
            &Shape::cylinder(dvec3(-8.0, 0.0, -1.0), r, DVec3::Z, 12.0),
        ),
        &Shape::cylinder(dvec3(8.0, 0.0, -1.0), r, DVec3::Z, 12.0),
    );
    cut(&Shape::box_from_corners(dvec3(-20.0, -20.0, 0.0), dvec3(20.0, 20.0, 10.0)), &tool)
}

fn slot_volume(w: f64) -> f64 {
    16000.0 - 10.0 * (16.0 * w + PI * (w / 2.0) * (w / 2.0))
}

fn face_at(body: &Shape, sel: &Value) -> Shape {
    Resolver::new(None, None).faces(body, sel).expect("a face").remove(0)
}

fn nearest(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p})
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

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

/// The slot `w` wide with a r 2 hole beside it, centred at (0, 12).
fn slot_and_hole(w: f64) -> Shape {
    cut(&slot(w), &Shape::cylinder(dvec3(0.0, 12.0, -1.0), 2.0, DVec3::Z, 12.0))
}

#[derive(Debug)]
enum Answer {
    Built(f64, DVec3),
    Refused(&'static str),
    Failed,
}

fn answer(r: Resize) -> Answer {
    match r {
        Resize::Built(s) => Answer::Built(kernel::volume(&s), DVec3::from(kernel::center_of_mass(&s).expect("a centre"))),
        Resize::Refused(Fail::Value { code: Some(code), .. }) => Answer::Refused(code),
        Resize::Refused(f) => panic!("refused without a code: {f:?}"),
        Resize::Failed => Answer::Failed,
    }
}

fn same(a: &Answer, b: &Answer) -> bool {
    match (a, b) {
        (Answer::Built(v, c), Answer::Built(v2, c2)) => close(*v, *v2, 1e-6) && c.distance(*c2) < 1e-6,
        (Answer::Refused(x), Answer::Refused(y)) => x == y,
        (Answer::Failed, Answer::Failed) => true,
        _ => false,
    }
}

#[test]
fn a_drag_over_one_face_gets_the_same_answers_as_fresh_resizes() {
    let (end, far_end, hole) = ([10.0, 0.0, 5.0], [-10.0, 0.0, 5.0], [0.0, 10.0, 5.0]);
    let (body, other) = (slot_and_hole(4.0), slot_and_hole(6.0));
    // As a drag asks: one face again and again, another face of the same
    // body, then another body.
    let steps = [
        (&body, end, -1.0, true),
        (&body, end, 0.5, true),
        (&body, end, -1.0, true),
        (&body, end, 0.5, false),
        (&body, far_end, -1.0, true),
        (&body, hole, 0.5, true),
        (&body, end, -0.8, true),
        (&other, end, 0.5, true),
        (&other, hole, -0.5, true),
    ];
    let ask = |i: usize| {
        let (b, at, d, follow) = steps[i];
        answer(resize::resize(b, &[face_at(b, &nearest(at))], d, follow))
    };
    let fresh: Vec<(Answer, bool)> = (0..steps.len())
        .map(|i| {
            resize::forget();
            let glued = resize::seen().glued;
            let a = ask(i);
            (a, resize::seen().glued > glued)
        })
        .collect();
    match &fresh[1].0 {
        Answer::Built(v, _) => assert!(close(*v, slot_volume(3.0) - 40.0 * PI, 1e-3), "{v}"),
        a => panic!("narrowing gave {a:?}"),
    }
    assert!(matches!(fresh[3].0, Answer::Refused("tangentLost")), "{:?}", fresh[3].0);
    resize::forget();
    for i in 0..steps.len() {
        let before = resize::seen();
        let got = ask(i);
        let after = resize::seen();
        assert!(same(&got, &fresh[i].0), "step {i}: {got:?} against fresh {:?}", fresh[i].0);
        let (b, at, ..) = steps[i];
        let again = steps[..i].iter().any(|(b2, at2, ..)| std::ptr::eq(*b2, b) && *at2 == at);
        let body_again = steps[..i].iter().any(|(b2, ..)| std::ptr::eq(*b2, b));
        if again {
            assert!(after.around > before.around, "step {i} worked its face out again");
        }
        if body_again && matches!(got, Answer::Built(..)) {
            assert!(after.volumes > before.volumes, "step {i} measured its body again");
        }
        if fresh[i].1 {
            assert_eq!(after.glued, before.glued + 1, "step {i} took the full boolean, fresh it did not");
        }
    }
    assert!(fresh.iter().filter(|(_, glued)| *glued).count() >= 5, "{fresh:?}");
}

fn c1() -> Value {
    serde_json::from_str(C1).expect("the c1 document")
}

/// The c1 body with every feature after `last` dropped.
fn through(last: &str) -> Shape {
    let mut raw = c1();
    let features = raw["features"].as_array_mut().unwrap();
    let at = features.iter().position(|f| f["id"] == last).expect("the feature");
    features.truncate(at + 1);
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty());
    r.bodies[0].shape.clone()
}

fn timed(body: &Shape, sel: &Value, d: f64) -> (Shape, Duration) {
    let face = face_at(body, sel);
    let t = Instant::now();
    let out = built(resize::resize(body, &[face], d, true));
    (out, t.elapsed())
}

#[test]
#[ignore = "timings, run in a release build"]
fn c1_resizes_within_the_drag_budget() {
    let (c1, body) = (c1(), through("f5"));
    let step = |id: usize| (c1["features"][id]["face"].clone(), c1["features"][id]["distance"].as_f64().unwrap());
    let mut shape = body.clone();
    let mut times = Vec::new();
    for id in 5..8 {
        let (sel, d) = step(id);
        let (out, took) = timed(&shape, &sel, d);
        times.push(took);
        shape = out;
    }
    assert!(close(kernel::volume(&shape), 50967.729, 1e-2), "{}", kernel::volume(&shape));
    let (sel, _) = step(5);
    let (_, run) = timed(&body, &sel, 0.5);
    let (_, again) = timed(&body, &sel, 0.45);
    eprintln!("c1 steps {times:?}, slot narrowed {run:?}, then dragged on {again:?}");
    for t in &times {
        assert!(*t < Duration::from_millis(400), "a step took {t:?}");
    }
    assert!(run < Duration::from_secs(1), "narrowing the slot took {run:?}");
    assert!(again < Duration::from_secs(1), "narrowing it again took {again:?}");
}
