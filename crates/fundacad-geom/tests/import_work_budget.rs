//! Mesh readers keep a work budget: a small file that declares or instances
//! far more geometry than it carries is refused quickly.

use std::borrow::Cow;
use std::sync::mpsc;
use std::time::Duration;

use fundacad_geom::import::gltf;
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
