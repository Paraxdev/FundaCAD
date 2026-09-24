//! The FundaCAD.Organic component through the plugin host: node bodies built
//! from the generic loft, ellipse, affine map and combine calls.
//! Needs `python scripts/build-plugin-wasm.py FundaCAD.Organic` first.
#![cfg(feature = "plugins")]

use std::f64::consts::PI;
use std::path::Path;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn built() -> bool {
    fundacad_geom::plugins::load();
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/FundaCAD.Organic/geometry.wasm");
    if !p.is_file() {
        eprintln!("skipped: build FundaCAD.Organic with scripts/build-plugin-wasm.py");
    }
    p.is_file()
}

fn build_with(parameters: Value, features: Vec<Value>) -> Rebuild {
    let doc = json!({"parameters": parameters, "features": features});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn build(features: Vec<Value>) -> Rebuild {
    build_with(json!({}), features)
}

fn node(id: &str, at: [f64; 3], s: [f64; 3]) -> Value {
    json!({"id": id, "x": at[0], "y": at[1], "z": at[2], "sx": s[0], "sy": s[1], "sz": s[2]})
}

fn body(nodes: Vec<Value>, chains: Value) -> Value {
    json!({"id": "o1", "type": "organic", "nodes": nodes, "chains": chains, "operation": "new"})
}

fn one_solid(r: &Rebuild) -> f64 {
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1);
    let s = &r.bodies[0].shape;
    assert!(opencascade_sys::plugin_ops::po_is_valid(s.raw()), "the solid is not valid");
    let v = kernel::volume(s);
    assert!(v > 0.0, "{v}");
    v
}

fn ellipsoid_volume(s: [f64; 3]) -> f64 {
    4.0 / 3.0 * PI * s[0] * s[1] * s[2]
}

#[test]
fn a_lone_node_is_its_ellipsoid() {
    if !built() {
        return;
    }
    for s in [[5.0, 5.0, 5.0], [8.0, 3.0, 5.0]] {
        let v = one_solid(&build(vec![body(vec![node("n1", [1.0, 2.0, 3.0], s)], json!([]))]));
        let want = ellipsoid_volume(s);
        assert!((v - want).abs() < 0.01 * want, "{s:?}: {v} vs {want}");
    }
}

#[test]
fn a_turned_node_keeps_its_volume_and_turns_its_extent() {
    if !built() {
        return;
    }
    let mut n = node("n1", [0.0, 0.0, 0.0], [10.0, 2.0, 2.0]);
    n["rz"] = json!(90);
    let r = build(vec![body(vec![n], json!([]))]);
    let v = one_solid(&r);
    let want = ellipsoid_volume([10.0, 2.0, 2.0]);
    assert!((v - want).abs() < 0.01 * want, "{v} vs {want}");
    let b = kernel::bbox(&r.bodies[0].shape).expect("a box");
    assert!((b[4] - b[1] - 20.0).abs() < 0.2, "y extent {:?}", b);
    assert!((b[3] - b[0] - 4.0).abs() < 0.2, "x extent {:?}", b);
}

fn three_chain() -> Value {
    body(
        vec![
            node("a", [0.0, 0.0, 0.0], [6.0, 6.0, 6.0]),
            node("b", [20.0, 5.0, 4.0], [4.0, 5.0, 4.0]),
            node("c", [38.0, 0.0, 12.0], [3.0, 3.0, 3.0]),
        ],
        json!([["a", "b", "c"]]),
    )
}

#[test]
fn a_chain_is_one_closed_smooth_solid_a_box_can_cut() {
    if !built() {
        return;
    }
    let r = build(vec![three_chain()]);
    let whole = one_solid(&r);
    // Each end rounds past its node, so the limb reaches beyond both centres.
    let b = kernel::bbox(&r.bodies[0].shape).unwrap();
    assert!(b[0] < -5.0 && b[3] > 40.0, "{b:?}");
    assert!(whole > ellipsoid_volume([6.0, 6.0, 6.0]), "{whole}");

    let cutter = json!({"id": "k", "type": "box", "length": 20, "width": 40, "height": 40, "operation": "cut"});
    let r = build(vec![three_chain(), cutter]);
    let cut = one_solid(&r);
    assert!(cut < whole - 1.0 && cut > 0.2 * whole, "{cut} of {whole}");
}

#[test]
fn turned_nodes_turn_their_sections() {
    if !built() {
        return;
    }
    let flat = |rx: f64| {
        let mut a = node("a", [0.0, 0.0, 0.0], [4.0, 8.0, 2.0]);
        let mut b = node("b", [0.0, 30.0, 0.0], [4.0, 8.0, 2.0]);
        a["ry"] = json!(rx);
        b["ry"] = json!(rx);
        body(vec![a, b], json!([["a", "b"]]))
    };
    let r0 = build(vec![flat(0.0)]);
    let r90 = build(vec![flat(90.0)]);
    let (v0, v90) = (one_solid(&r0), one_solid(&r90));
    assert!((v0 - v90).abs() < 0.02 * v0, "{v0} vs {v90}");
    let (b0, b90) = (kernel::bbox(&r0.bodies[0].shape).unwrap(), kernel::bbox(&r90.bodies[0].shape).unwrap());
    // A node 4 wide and 2 tall, turned a quarter about Y, is 2 wide and 4 tall.
    assert!((b0[3] - b0[0] - 8.0).abs() < 0.3 && (b0[5] - b0[2] - 4.0).abs() < 0.3, "{b0:?}");
    assert!((b90[3] - b90[0] - 4.0).abs() < 0.3 && (b90[5] - b90[2] - 8.0).abs() < 0.3, "{b90:?}");
}

/// The viewport mesh's area at `tolerance`, meshed from scratch.
fn mesh_area(r: &Rebuild, tolerance: f64) -> f64 {
    let b = &r.bodies[0];
    let mb = fundacad_geom::mesh::MeshBody {
        id: b.id.clone(),
        name: b.name.clone(),
        shape: Some(&b.shape),
        ..Default::default()
    };
    let out = fundacad_geom::mesh::mesh_result(&[mb], tolerance, &Default::default());
    let Some(fundacad_protocol::WireBody::Full(m)) = out.bodies.into_iter().next() else {
        panic!("a full body");
    };
    let p = |i: u32| {
        let k = i as usize * 3;
        [m.positions[k] as f64, m.positions[k + 1] as f64, m.positions[k + 2] as f64]
    };
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
        })
        .sum()
}

#[test]
fn a_long_span_meshes_whole() {
    if !built() {
        return;
    }
    // Two spans ten radii long. Unsmoothed, the loft through this many
    // sections came out a surface the mesher left a sixth of uncovered at
    // 0.05 mm, a limb with a gap through its middle.
    let spine = [[0.0, 0.0, 0.0], [32.23, -36.79, 12.0], [62.35, -47.77, 12.0]];
    let nodes = spine.iter().enumerate().map(|(i, c)| node(&format!("n{i}"), *c, [5.0; 3])).collect();
    let r = build(vec![body(nodes, json!([["n0", "n1", "n2"]]))]);
    one_solid(&r);
    let brep = kernel::area(&r.bodies[0].shape);
    let mesh = mesh_area(&r, 0.05);
    assert!((mesh - brep).abs() < 0.01 * brep, "mesh {mesh} vs {brep}");
}

fn y_shape(blend: Option<f64>) -> Value {
    let mut f = body(
        vec![
            node("root", [0.0, 0.0, 0.0], [5.0, 5.0, 5.0]),
            node("fork", [0.0, 0.0, 20.0], [5.0, 5.0, 5.0]),
            node("left", [-14.0, 0.0, 34.0], [3.0, 3.0, 3.0]),
            node("right", [14.0, 0.0, 34.0], [3.0, 3.0, 3.0]),
        ],
        json!([["root", "fork", "left"], ["fork", "right"]]),
    );
    if let Some(b) = blend {
        f["blend"] = json!(b);
    }
    f
}

#[test]
fn a_fork_fuses_and_blends_or_says_why_not() {
    if !built() {
        return;
    }
    let plain = one_solid(&build(vec![y_shape(None)]));
    let r = build(vec![y_shape(Some(2.0))]);
    let blended = one_solid(&r);
    let warned = r
        .diagnostics
        .iter()
        .any(|d| d.get("kind").and_then(Value::as_str) == Some("edgeOpFailed"));
    if !warned {
        // A concave junction rounded over adds material.
        assert!(blended > plain, "{blended} vs {plain}");
    }
    assert!((blended - plain).abs() < 0.1 * plain, "{blended} vs {plain}");
}

#[test]
fn a_size_bound_to_a_parameter_follows_it() {
    if !built() {
        return;
    }
    let f = || {
        let mut n = node("n1", [0.0, 0.0, 0.0], [5.0, 5.0, 5.0]);
        n["sx"] = json!("r");
        n["sy"] = json!("q");
        body(vec![n], json!([]))
    };
    let small = one_solid(&build_with(json!({"r": 4, "q": 8}), vec![f()]));
    let large = one_solid(&build_with(json!({"r": 6, "q": 12}), vec![f()]));
    assert!((small - ellipsoid_volume([4.0, 8.0, 5.0])).abs() < 0.01 * small, "{small}");
    assert!((large - ellipsoid_volume([6.0, 12.0, 5.0])).abs() < 0.01 * large, "{large}");
}

#[test]
fn bad_chains_are_named() {
    if !built() {
        return;
    }
    let r = build(vec![body(vec![node("a", [0.0; 3], [5.0; 3])], json!([["a", "zz"]]))]);
    assert!(r.errors[0].message.contains("zz"), "{}", r.errors[0].message);
    let r = build(vec![body(vec![], json!([]))]);
    assert!(r.errors[0].message.contains("node"), "{}", r.errors[0].message);
}
