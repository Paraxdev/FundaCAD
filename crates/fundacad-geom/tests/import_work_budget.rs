//! Mesh readers keep a work budget: a small file that declares or instances
//! far more geometry than it carries is refused quickly.

use std::borrow::Cow;
use std::sync::mpsc;
use std::time::Duration;

use fundacad_geom::import::{gltf, x3d};
use serde_json::{json, Value};

/// Runs `f` on its own thread and fails the test if it takes longer than `secs`.
fn within<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(secs)).expect("the reader did not finish in time")
}

fn triangle_bin() -> Vec<u8> {
    [[0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]].iter().flatten().flat_map(|f| f.to_le_bytes()).collect()
}

fn gltf_doc(accessor: Value, nodes: Value, bin_len: usize) -> Value {
    json!({
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [accessor],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": bin_len}],
        "buffers": [{"byteLength": bin_len}],
    })
}

fn read(doc: Value, bin: Vec<u8>) -> Result<(Vec<f64>, Vec<u32>), String> {
    gltf::read_gltf(&doc, &[Cow::Owned(bin)], 1.0)
}

#[test]
fn a_plain_gltf_triangle_still_imports() {
    let bin = triangle_bin();
    let acc = json!({"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"});
    let (pos, idx) = read(gltf_doc(acc, json!([{"mesh": 0}]), bin.len()), bin).unwrap();
    assert_eq!((pos.len(), idx.len()), (9, 3));
}

#[test]
fn a_gltf_accessor_larger_than_its_buffer_is_refused() {
    let bin = triangle_bin();
    let acc = json!({"bufferView": 0, "componentType": 5126, "count": 1u64 << 62, "type": "VEC3"});
    assert!(within(10, move || read(gltf_doc(acc, json!([{"mesh": 0}]), 36), bin)).is_err());
}

#[test]
fn a_gltf_accessor_without_a_buffer_view_is_held_to_the_vertex_budget() {
    let acc = json!({"componentType": 5126, "count": 1u64 << 62, "type": "VEC3"});
    assert!(within(10, move || read(gltf_doc(acc, json!([{"mesh": 0}]), 36), triangle_bin())).is_err());
}

#[test]
fn a_gltf_stride_shorter_than_an_element_is_refused() {
    let mut view = gltf_doc(json!({}), json!([{"mesh": 0}]), 36);
    view["bufferViews"][0]["byteStride"] = json!(0);
    view["accessors"] = json!([{"bufferView": 0, "componentType": 5126, "count": 30, "type": "VEC3"}]);
    assert!(read(view, triangle_bin()).is_err());
}

#[test]
fn a_gltf_node_reached_through_many_parents_is_held_to_a_visit_budget() {
    let depth = 22;
    let mut nodes: Vec<Value> = (0..depth).map(|i| json!({"children": [i + 1, i + 1]})).collect();
    nodes.push(json!({"mesh": 0}));
    let acc = json!({"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"});
    let doc = gltf_doc(acc, Value::Array(nodes), 36);
    assert!(within(30, move || read(doc, triangle_bin())).is_err());
}

/// `levels` VRML groups, each listing the one before it twice, over `leaf`.
fn vrml_doubling(leaf: &str, levels: usize) -> String {
    let mut s = format!("#VRML V2.0 utf8\nDEF L0 {leaf}\n");
    for i in 1..=levels {
        s += &format!("DEF L{i} Group {{ children [ USE L{} USE L{} ] }}\n", i - 1, i - 1);
    }
    s
}

fn x3d_doubling(leaf: &str, levels: usize) -> String {
    let mut s = format!("<X3D><Scene><Group DEF=\"L0\">{leaf}</Group>");
    for i in 1..=levels {
        s += &format!("<Group DEF=\"L{i}\"><Group USE=\"L{}\"/><Group USE=\"L{}\"/></Group>", i - 1, i - 1);
    }
    s + "</Scene></X3D>"
}

/// 2000 triangles over four shared points.
fn dense_index() -> String {
    (0..2000).map(|_| "0 1 2").collect::<Vec<_>>().join(" ")
}

#[test]
fn a_vrml_scene_still_imports_through_def_and_use() {
    let wrl = vrml_doubling("Shape { geometry Box { } }", 3);
    let (objects, _) = x3d::read_vrml(&wrl, Some(1.0)).unwrap();
    let tris: usize = objects.iter().map(|o| o.idx.len() / 3).sum();
    assert_eq!(tris, 12 * (1 + 2 + 4 + 8));
}

#[test]
fn vrml_groups_reused_through_many_parents_are_held_to_a_visit_budget() {
    let wrl = vrml_doubling("Group { }", 40);
    assert!(within(30, move || x3d::read_vrml(&wrl, Some(1.0))).is_err());
}

#[test]
fn x3d_groups_reused_through_many_parents_are_held_to_a_visit_budget() {
    let xml = x3d_doubling("", 40);
    assert!(within(30, move || x3d::read_x3d(&xml, Some(1.0))).is_err());
}

#[test]
fn vrml_shapes_reused_past_the_triangle_budget_are_refused() {
    let leaf = format!(
        "Shape {{ geometry IndexedTriangleSet {{ coord Coordinate {{ point [ 0 0 0, 1 0 0, 0 1 0, 0 0 1 ] }} index [ {} ] }} }}",
        dense_index()
    );
    let wrl = vrml_doubling(&leaf, 12);
    let e = within(60, move || x3d::read_vrml(&wrl, Some(1.0)).err()).expect("a scene past the budget is refused");
    assert!(e.contains("triangles"), "{e}");
}

#[test]
fn x3d_shapes_reused_past_the_triangle_budget_are_refused() {
    let leaf = format!(
        "<Shape><IndexedTriangleSet index=\"{}\"><Coordinate point=\"0 0 0 1 0 0 0 1 0 0 0 1\"/></IndexedTriangleSet></Shape>",
        dense_index()
    );
    let xml = x3d_doubling(&leaf, 12);
    let e = within(60, move || x3d::read_x3d(&xml, Some(1.0)).err()).expect("a scene past the budget is refused");
    assert!(e.contains("triangles"), "{e}");
}
