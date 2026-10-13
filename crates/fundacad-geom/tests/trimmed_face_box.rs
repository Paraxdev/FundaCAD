//! The exact box of a body is the box of its faces as they are trimmed. A
//! spline face cut off askew has surface left over beyond the cut, and the
//! kernel boxed that as well, so cutting a body made its box grow.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::{inspect, mesh};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r
}

fn corners(bbox: &Value) -> [f64; 6] {
    let at = |k: &str, i: usize| bbox[k][i].as_f64().expect("a number");
    [at("min", 0), at("min", 1), at("min", 2), at("max", 0), at("max", 1), at("max", 2)]
}

/// The box a build picks boolean targets by and the one `inspect` reports,
/// which have to be the same box. `inspect` rounds to a micrometre.
fn exact_box(shape: &Shape) -> [f64; 6] {
    let built = kernel::bbox(shape).expect("a box");
    let body = inspect::InspectBody { id: json!("b"), name: json!("B"), shape: Some(shape) };
    let reported = corners(&inspect::inspect_bodies(&[body], false, 400, 800).expect("inspects")[0]["bbox"]);
    for k in 0..6 {
        assert!((built[k] - reported[k]).abs() < 1e-6, "build {built:?}, inspect {reported:?}");
    }
    built
}

fn mesh_box(shape: &Shape) -> [f64; 6] {
    corners(&mesh::body_payload(shape, "b", "B", 0.01, mesh::viewport_profile(1)).fields["bbox"])
}

/// A mesh has its nodes on the body, so the exact box holds the mesh's and is
/// larger by no more than the sag.
fn assert_wraps_mesh(shape: &Shape) -> [f64; 6] {
    let (exact, meshed) = (exact_box(shape), mesh_box(shape));
    for k in 0..3 {
        let (low, high) = (meshed[k] - exact[k], exact[k + 3] - meshed[k + 3]);
        assert!(
            (-1e-9..0.05).contains(&low) && (-1e-9..0.05).contains(&high),
            "axis {k}: exact {exact:?}, mesh {meshed:?}"
        );
    }
    exact
}

fn assert_sides(got: &[f64], want: &[f64]) {
    for (g, w) in got.iter().zip(want) {
        assert!((g - w).abs() < 1e-6, "{got:?}, expected {want:?}");
    }
}

fn circle(id: &str, z: f64, radius: f64, x: f64) -> Value {
    json!({"id": id, "type": "sketch", "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
        "entities": [{"type": "circle", "radius": radius, "x": x, "y": 0}]})
}

/// A 20 mm block with a duct lofted out of it that leaves through the wall at
/// x = 10 on a slant. The duct's surface goes on to x = 16 outside the block.
fn block_with_duct() -> Value {
    json!({"features": [
        {"id": "block", "type": "box", "length": 20, "width": 20, "height": 20},
        circle("s0", -5.0, 3.0, 0.0),
        circle("s1", 0.0, 3.0, 3.0),
        circle("s2", 5.0, 3.0, 14.0),
        {"id": "duct", "type": "loft", "sketches": ["s0", "s1", "s2"], "operation": "cut", "targets": ["body1"]},
    ]})
}

/// A slab over the whole part, tilted about Y and cut away upwards.
fn slanted_cut(z: f64, degrees: f64) -> [Value; 2] {
    let (sin, cos) = degrees.to_radians().sin_cos();
    [
        json!({"id": "slantSk", "type": "sketch", "plane": {"origin": [0, 0, z], "normal": [sin, 0, cos], "xdir": [cos, 0, -sin]},
            "entities": [{"type": "rectangle", "width": 80, "height": 80, "x": 0, "y": 0}]}),
        json!({"id": "slant", "type": "extrude", "sketch": "slantSk", "distance": 40, "operation": "cut", "targets": ["body1"]}),
    ]
}

fn lofted(sections: &[(f64, f64)], cut: [Value; 2]) -> Value {
    let ids: Vec<String> = (0..sections.len()).map(|i| format!("s{i}")).collect();
    let mut features: Vec<Value> = sections.iter().zip(&ids).map(|(&(z, r), id)| circle(id, z, r, 0.0)).collect();
    features.push(json!({"id": "body", "type": "loft", "sketches": ids, "operation": "new"}));
    features.extend(cut);
    json!({ "features": features })
}

#[test]
fn a_duct_cut_out_through_a_wall_leaves_the_block_its_box() {
    let r = build(&block_with_duct());
    let block = &r.bodies[0].shape;
    assert!(kernel::volume(block) < 7800.0, "the duct was not cut: {}", kernel::volume(block));
    assert_sides(&assert_wraps_mesh(block), &[-10.0, -10.0, -10.0, 10.0, 10.0, 10.0]);
}

/// Without targets a join takes every body whose box it meets. The pad stands
/// 2 mm clear of the block, and was fused into it as a second loose solid.
#[test]
fn an_untargeted_join_passes_a_body_it_stands_clear_of() {
    let mut doc = block_with_duct();
    doc["features"].as_array_mut().unwrap().extend([
        json!({"id": "padSk", "type": "sketch", "plane": {"origin": [13, 0, -1], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
            "entities": [{"type": "rectangle", "width": 2, "height": 2, "x": 0, "y": 0}]}),
        json!({"id": "pad", "type": "extrude", "sketch": "padSk", "distance": 2, "operation": "join"}),
    ]);
    let r = build(&doc);
    let solids: Vec<usize> = r.bodies.iter().map(|b| kernel::count(&b.shape, Kind::Solid)).collect();
    assert_eq!(solids, [1, 1], "bodies and their solids");
}

/// The vase flares to radius 9 above the cut. On the low side of the cut the
/// flare is gone and the belly lower down is the widest point left, which is
/// neither on an edge nor where the whole surface is widest.
#[test]
fn a_face_cut_below_a_wider_part_of_its_surface_is_boxed_by_what_is_left() {
    let sections = [(0.0, 3.0), (10.0, 5.0), (20.0, 3.0), (26.0, 9.0)];
    let r = build(&lofted(&sections, slanted_cut(22.0, 40.0)));
    let got = assert_wraps_mesh(&r.bodies[0].shape);
    assert!((got[0] + 9.0).abs() < 1e-6, "the rim left on the high side: {got:?}");

    let flat = [
        json!({"id": "flatSk", "type": "sketch", "plane": {"origin": [0, 0, 15], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
            "entities": [{"type": "rectangle", "width": 80, "height": 80, "x": 0, "y": 0}]}),
        json!({"id": "flat", "type": "extrude", "sketch": "flatSk", "distance": 40, "operation": "cut", "targets": ["body1"]}),
    ];
    let belly = exact_box(&build(&lofted(&sections, flat)).bodies[0].shape)[3];
    assert!((got[3] - belly).abs() < 1e-6, "x reaches {}, the belly is {belly}", got[3]);
}

/// The widest point of these is inside a face, past all of its edges, and a
/// box taken from the edges alone would be short.
#[test]
fn a_face_wider_than_its_edges_keeps_its_bulge() {
    let ball = build(&json!({"features": [
        {"id": "ball", "type": "sphere", "radius": 10},
        {"id": "capSk", "type": "sketch", "plane": {"origin": [0, 0, -12], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
            "entities": [{"type": "rectangle", "width": 30, "height": 30, "x": 0, "y": 0}]},
        {"id": "cap", "type": "extrude", "sketch": "capSk", "distance": 9, "operation": "cut", "targets": ["body1"]},
    ]}));
    assert_sides(&assert_wraps_mesh(&ball.bodies[0].shape), &[-10.0, -10.0, -3.0, 10.0, 10.0, 10.0]);

    let barrel = build(&lofted(&[(0.0, 3.0), (10.0, 6.0), (20.0, 3.0)], slanted_cut(14.0, 25.0)));
    let got = assert_wraps_mesh(&barrel.bodies[0].shape);
    assert_sides(&got[..5], &[-6.0, -6.0, 0.0, 6.0, 6.0]);
}
