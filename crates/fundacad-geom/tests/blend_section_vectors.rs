//! The sections in tests/vectors/blend_sections.json, which the preview draws too, are what the engine builds: each
//! point lies on the prism at its own parameter on the built surface, and G2 and G3 are not the G1 round.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use opencascade_sys::plugin_ops as ffi;
use serde_json::{json, Value};
use std::path::Path;

type V2 = [f64; 2];

/// A section point's allowance, per mm of radius. A concave G2 or G3 surface sits up to about 1e-4 of the radius off
/// the formula, the rest of the sections far closer.
const ON_SOLID: f64 = 5e-4;

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/blend_sections.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse")
}

/// The prism stands with the edge on Z at the origin, x and y mirrored from the section frame.
fn to_model(p: V2) -> V2 {
    [-p[0], -p[1]]
}

fn line(id: &str, a: V2, b: V2) -> Value {
    let (a, b) = (to_model(a), to_model(b));
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

/// One of the section's two faces, leaving the origin along `dir` and curling toward `side` by `bend`.
struct Face {
    dir: V2,
    side: V2,
    bend: f64,
}

impl Face {
    fn at(&self, s: f64) -> V2 {
        let b = self.bend;
        let (a, c) = if b == 0.0 { (s, 0.0) } else { ((b * s).sin() / b, (1.0 - (b * s).cos()) / b) };
        [a * self.dir[0] + c * self.side[0], a * self.dir[1] + c * self.side[1]]
    }

    fn entity(&self, id: &str, from: f64, to: f64) -> Value {
        let (p, q) = (self.at(from), self.at(to));
        if self.bend == 0.0 {
            return line(id, p, q);
        }
        let (a, b, m) = (to_model(p), to_model(q), to_model(self.at(0.5 * (from + to))));
        json!({"type": "arc", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1], "mx": m[0], "my": m[1]})
    }
}

/// The profile of a prism whose edge at the origin joins the section's faces, its material in the wedge or outside it.
fn prism_entities(s: &Value) -> Vec<Value> {
    let t = s["angle"].as_f64().expect("angle").to_radians();
    let bend = |k: &str| s[k].as_f64().unwrap_or(0.0);
    let f1 = Face { dir: [1.0, 0.0], side: [0.0, 1.0], bend: bend("bend1") };
    let f2 = Face { dir: [t.cos(), t.sin()], side: [t.sin(), -t.cos()], bend: bend("bend2") };
    // Note: the engine trims a concave fill at a neighbouring face's plane, so a flat face runs far past any foot.
    let reach = if f1.bend == 0.0 && f2.bend == 0.0 { 60.0 } else { 30.0 };
    let (a, b) = (f1.at(reach), f2.at(reach));
    let round = if s["corner"] == "convex" {
        vec![a, b]
    } else {
        vec![a, [a[0], -100.0], [-100.0, -100.0], [-100.0, 100.0], [b[0], 100.0], b]
    };
    let mut out = vec![f1.entity("f1", 0.0, reach), f2.entity("f2", reach, 0.0)];
    out.extend(round.windows(2).enumerate().map(|(i, w)| line(&format!("l{i}"), w[0], w[1])));
    out
}

fn fillet(s: &Value, continuity: &str) -> Result<Shape, Vec<String>> {
    let pick = json!({"kind": "edge", "by": "nearest", "point": [0.0, 0.0, 20.0]});
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": prism_entities(s)},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 40.0, "operation": "new"},
        {"id": "f", "type": "fillet", "radius": s["radius"], "continuity": continuity, "edges": [pick]},
    ]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    if !r.errors.is_empty() {
        return Err(r.errors.iter().map(|e| e.message.clone()).collect());
    }
    Ok(r.bodies[0].shape.clone())
}

fn point_of(p: &Value) -> V2 {
    [p[0].as_f64().expect("x"), p[1].as_f64().expect("y")]
}

/// A section point at the prism's mid height.
fn lifted(p: V2) -> [f64; 3] {
    let m = to_model(p);
    [m[0], m[1], 20.0]
}

/// How far a section point sits from the nearest face of the solid.
fn off_boundary(faces: &[Shape], p: V2) -> f64 {
    faces.iter().filter_map(|f| kernel::distance_to_point(f, lifted(p))).fold(f64::INFINITY, f64::min)
}

/// The surface of the face holding the section's middle, at mid height and `count` even steps of its section parameter:
/// the Bezier's 0 to 1 for G2 and G3, whatever a fill's trim left of it, and the face's angles for the G1 round.
fn built_section(faces: &[Shape], mid: V2, tol: f64, count: usize, bezier: bool) -> Vec<V2> {
    let on = |f: &&Shape| kernel::distance_to_point(f, lifted(mid)).is_some_and(|d| d < tol);
    let face = faces.iter().find(on).expect("the blend face");
    let mut frame = [0.0; 18];
    ffi::po_surface_frame(face.raw(), &mut frame);
    let (u0, u1) = if bezier { (0.0, 1.0) } else { (frame[14], frame[15]) };
    let v = 0.5 * (frame[16] + frame[17]);
    let uvs: Vec<f64> = (0..count).flat_map(|k| [u0 + (u1 - u0) * k as f64 / (count - 1) as f64, v]).collect();
    let samples = ffi::po_surface_samples(face.raw(), &uvs, 1e-6);
    samples
        .chunks_exact(13)
        .map(|c| {
            assert!((c[2] - 20.0).abs() < 1e-6, "the section parameter is not u: z {}", c[2]);
            to_model([c[0], c[1]])
        })
        .collect()
}

fn gap(a: &[V2], b: &[V2]) -> f64 {
    a.iter().zip(b).map(|(p, q)| (p[0] - q[0]).hypot(p[1] - q[1])).fold(0.0, f64::max)
}

fn name(s: &Value) -> String {
    let (c, a, r) = (&s["corner"], &s["angle"], &s["radius"]);
    format!("{c} {} at {a} degrees, radius {r}, bends {} {}", s["continuity"], s["bend1"], s["bend2"])
}

#[test]
fn the_engine_builds_the_shared_blend_sections() {
    let v = vectors();
    let sections = v["sections"].as_array().expect("sections");
    assert_eq!(sections.len(), 48);
    let mut wrong = Vec::new();
    for s in sections {
        let radius = s["radius"].as_f64().expect("radius");
        let cont = s["continuity"].as_str().expect("continuity");
        let solid = fillet(s, cont).unwrap_or_else(|e| panic!("{}: {e:?}", name(s)));
        let faces = kernel::subshapes(&solid, Kind::Face);
        let points: Vec<V2> = s["points"].as_array().expect("points").iter().map(point_of).collect();
        let off = points.iter().map(|&p| off_boundary(&faces, p)).fold(0.0, f64::max);
        if off >= ON_SOLID * radius {
            wrong.push(format!("{}: {off} off the solid", name(s)));
        }
        // The surface may run either way along the section, the sample positions may not. Between curved faces the
        // engine's G1 surface has its own parameter, there the even angles are only how the vector samples the round.
        if s.get("bend1").is_none() {
            let built = built_section(&faces, points[4], ON_SOLID * radius, points.len(), cont != "G1");
            let back: Vec<V2> = built.iter().rev().copied().collect();
            let apart = gap(&built, &points).min(gap(&back, &points));
            if apart >= ON_SOLID * radius {
                wrong.push(format!("{}: {apart} from the surface by parameter", name(s)));
            }
        }
        if cont == "G1" {
            continue;
        }
        let same = |g: &&Value| ["corner", "angle", "radius"].iter().all(|k| g[k] == s[k]) && g["continuity"] == "G1";
        let round = sections.iter().find(same).expect("the G1 section");
        let far = round["points"].as_array().expect("points").iter().map(|p| off_boundary(&faces, point_of(p)));
        let far = far.fold(0.0, f64::max);
        if far <= 0.01 * radius {
            wrong.push(format!("{} is the G1 round: {far}", name(s)));
        }
    }
    assert_eq!(wrong, Vec::<String>::new());
}

#[test]
fn the_engine_refuses_g2_and_g3_on_a_face_curved_across_the_edge() {
    let v = vectors();
    for s in v["sections"].as_array().expect("sections").iter().filter(|s| s.get("bend1").is_some()) {
        for cont in ["G2", "G3"] {
            assert!(fillet(s, cont).is_err(), "{cont} built on {}", name(s));
        }
    }
}
