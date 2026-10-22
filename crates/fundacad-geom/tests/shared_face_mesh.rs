//! A joined body shares the faces the join left alone with the tool it kept,
//! and holds a patterned tool's faces once per copy. The kernel stores one
//! mesh per shared face, so the body must come out whole whichever body was
//! meshed before it and at whatever fineness, in the viewport and in an STL.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::export;
use fundacad_geom::mesh::{self, viewport_profile};
use opencascade::primitives::Shape;
use serde_json::{json, Value};
use std::collections::HashMap;

fn outline(points: [[f64; 2]; 4]) -> Vec<Value> {
    (0..4)
        .map(|i| {
            let (a, b) = (points[i], points[(i + 1) % 4]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        })
        .collect()
}

/// A revolved tube (body1) with a grip bump revolved 14 degrees inside its
/// wall (body2), `copies` of the bump around the axis, joined onto the tube
/// with the bumps kept. `height` only makes each document a new one.
fn tube_with_bumps(copies: usize, height: f64) -> Vec<Shape> {
    let mut features = vec![
        json!({"id": "tubeSk", "type": "sketch", "plane": "XZ",
               "entities": outline([[41.74, 0.0], [43.74, 0.0], [43.74, height], [41.74, height]])}),
        json!({"id": "tube", "type": "revolve", "sketch": "tubeSk", "axis": "Z", "angle": 360, "operation": "new"}),
        json!({"id": "bumpSk", "type": "sketch", "plane": "XZ",
               "entities": outline([[42.34, 10.0], [41.25, 11.0], [41.25, 12.0], [42.34, 13.0]])}),
        json!({"id": "bump", "type": "revolve", "sketch": "bumpSk", "axis": "Z", "angle": 14, "operation": "new"}),
    ];
    if copies > 1 {
        features.push(json!({"id": "pat", "type": "patternCircular", "count": copies, "angle": 360, "axis": "Z",
            "bodies": ["body2"]}));
    }
    features.push(json!({"id": "join", "type": "boolean", "operation": "union", "target": "body1",
        "tools": ["body2"], "keepOriginals": true}));
    let raw = json!({"parameters": {}, "features": features});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    ["body1", "body2"].map(|id| r.bodies.iter().find(|b| b.id == id).expect("the body").shape.clone()).to_vec()
}

/// Triangle sides not met exactly twice, corners joined by exact position.
fn open_sides<T: Copy + Into<f64>>(positions: &[T], indices: &[u32]) -> usize {
    let mut ids: HashMap<[u64; 3], u32> = HashMap::new();
    let node: Vec<u32> = positions
        .chunks_exact(3)
        .map(|c| {
            let key = [0, 1, 2].map(|k| (c[k].into() + 0.0).to_bits());
            let next = ids.len() as u32;
            *ids.entry(key).or_insert(next)
        })
        .collect();
    let mut sides: HashMap<(u32, u32), u32> = HashMap::new();
    for t in indices.chunks_exact(3) {
        let c = [node[t[0] as usize], node[t[1] as usize], node[t[2] as usize]];
        if c[0] == c[1] || c[1] == c[2] || c[2] == c[0] {
            continue;
        }
        for k in 0..3 {
            let (a, b) = (c[k], c[(k + 1) % 3]);
            *sides.entry((a.min(b), a.max(b))).or_insert(0) += 1;
        }
    }
    sides.values().filter(|&&n| n != 2).count()
}

fn view(shape: &Shape) -> usize {
    let v = mesh::body_payload(shape, "body", "body", 0.1, viewport_profile(2));
    open_sides(&v.positions, &v.indices)
}

fn stl(shape: &Shape, fine: bool) -> usize {
    let finer = json!({"surfaceDeviation": 0.005, "normalDeviation": 5});
    let opts = export::mesh_options(fine.then_some(&finer));
    let (positions, indices) = export::export_mesh(shape, &opts);
    let single: Vec<f32> = positions.iter().map(|&v| v as f32).collect();
    open_sides(&single, &indices)
}

#[test]
fn a_body_joined_from_turned_copies_meshes_closed() {
    let b = tube_with_bumps(3, 30.0);
    assert_eq!((view(&b[0]), stl(&b[0], false)), (0, 0), "open sides in the viewport mesh and in the STL");
}

#[test]
fn a_body_meshes_closed_again_after_the_tool_it_kept_was_drawn() {
    let b = tube_with_bumps(1, 31.0);
    let got = (view(&b[0]), view(&b[1]), view(&b[0]), stl(&b[0], false));
    assert_eq!(got, (0, 0, 0, 0), "open sides: joined body, its tool, the joined body again, its STL");
}

#[test]
fn a_body_exports_closed_after_the_tool_it_kept_was_exported_finer() {
    for (copies, height) in [(1, 32.0), (3, 33.0)] {
        let b = tube_with_bumps(copies, height);
        let got = (stl(&b[0], false), stl(&b[1], true), stl(&b[0], false), view(&b[0]), stl(&b[1], false));
        assert_eq!(
            got,
            (0, 0, 0, 0, 0),
            "{copies} bump(s), open sides: STL of the joined body, fine STL of its tool, the joined body's STL again, its viewport mesh, the tool's STL"
        );
    }
}
