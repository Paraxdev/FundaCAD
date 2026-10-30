//! Mesh readers keep a work budget: a small file that declares or instances
//! far more geometry than it carries is refused quickly.

use std::borrow::Cow;
use std::sync::mpsc;
use std::time::Duration;

use fundacad_geom::import::{self, blobstore::BlobStore, dxf, gltf, x3d};
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

/// A one part 3MF zip written by hand, so the sizes it declares can differ from the data.
fn threemf_zip(deflated: &[u8], crc: u32, declared: u32) -> Vec<u8> {
    let name = b"3D/3dmodel.model";
    let head = |sig: u32, central: bool| {
        let mut h = sig.to_le_bytes().to_vec();
        if central {
            h.extend(20u16.to_le_bytes());
        }
        for v in [20u16, 0, 8, 0, 0x21] {
            h.extend(v.to_le_bytes());
        }
        for v in [crc, deflated.len() as u32, declared] {
            h.extend(v.to_le_bytes());
        }
        h.extend((name.len() as u16).to_le_bytes());
        h.extend(0u16.to_le_bytes());
        if central {
            h.extend([0u8; 10]);
            h.extend(0u32.to_le_bytes());
        }
        h.extend(name);
        h
    };
    let mut z = head(0x0403_4b50, false);
    z.extend(deflated);
    let cd_at = z.len() as u32;
    let cd = head(0x0201_4b50, true);
    z.extend(&cd);
    z.extend(0x0605_4b50u32.to_le_bytes());
    for v in [0u16, 0, 1, 1] {
        z.extend(v.to_le_bytes());
    }
    z.extend((cd.len() as u32).to_le_bytes());
    z.extend(cd_at.to_le_bytes());
    z.extend(0u16.to_le_bytes());
    z
}

fn deflate(data: &[u8], flush: flate2::FlushCompress) -> Vec<u8> {
    let mut c = flate2::Compress::new(flate2::Compression::fast(), false);
    let mut out = Vec::with_capacity(data.len() / 8 + 1024);
    c.compress_vec(data, &mut out, flush).unwrap();
    out
}

const CUBE_MODEL: &str = r#"<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/><vertex x="10" y="0" z="10"/><vertex x="10" y="10" z="10"/><vertex x="0" y="10" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#;

fn import_3mf(tag: &str, zip: Vec<u8>) -> Result<serde_json::Map<String, Value>, String> {
    let dir = std::env::temp_dir().join(format!("fundacad-3mf-budget-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("part.3mf");
    std::fs::write(&path, zip).unwrap();
    let store = BlobStore::open(dir.join("blobs")).unwrap();
    let out = import::import_geometry(path.to_str().unwrap(), "3mf", &store);
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[test]
fn a_small_3mf_still_imports() {
    let mut crc = flate2::Crc::new();
    crc.update(CUBE_MODEL.as_bytes());
    let zip =
        threemf_zip(&deflate(CUBE_MODEL.as_bytes(), flate2::FlushCompress::Finish), crc.sum(), CUBE_MODEL.len() as u32);
    import_3mf("cube", zip).unwrap();
}

#[test]
fn a_3mf_part_that_unpacks_past_the_budget_is_refused() {
    let spaces = vec![b' '; 1 << 20];
    let block = deflate(&spaces, flate2::FlushCompress::Sync);
    let mut data: Vec<u8> = std::iter::repeat_n(&block[..], 300).flatten().copied().collect();
    data.extend([0x03, 0x00]);
    let (mut crc, mut one) = (flate2::Crc::new(), flate2::Crc::new());
    one.update(&spaces);
    for _ in 0..300 {
        crc.combine(&one);
    }
    let zip = threemf_zip(&data, crc.sum(), 300 << 20);
    let e = within(120, move || import_3mf("unpacked", zip).err()).expect("a part past the budget is refused");
    assert!(e.contains("unpacks past"), "{e}");
}

fn dxf_with(blocks: &[(&str, &str)], entities: &str) -> Vec<u8> {
    let mut t = String::from("0\nSECTION\n2\nBLOCKS\n");
    for (name, body) in blocks {
        t += &format!("0\nBLOCK\n8\n0\n2\n{name}\n70\n0\n10\n0\n20\n0\n30\n0\n{body}0\nENDBLK\n");
    }
    t += &format!("0\nENDSEC\n0\nSECTION\n2\nENTITIES\n{entities}0\nENDSEC\n0\nEOF\n");
    t.into_bytes()
}

fn insert_array(block: &str, cols: &str, rows: &str) -> String {
    format!("0\nINSERT\n8\n0\n2\n{block}\n10\n0\n20\n0\n30\n0\n70\n{cols}\n71\n{rows}\n44\n1\n45\n1\n")
}

const TEXT: &str = "0\nTEXT\n8\n0\n10\n0\n20\n0\n30\n0\n40\n1\n1\nA\n";
const LINE: &str = "0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n0\n31\n0\n";

#[test]
fn a_dxf_insert_array_of_lines_still_imports() {
    let data = dxf_with(&[("L", LINE)], &insert_array("L", "3", "3"));
    let read = dxf::read_dxf(&data).expect("a small array imports");
    let lines: usize = read.sketches.iter().map(|(_, e)| e.len()).sum();
    assert_eq!(lines, 9);
}

#[test]
fn nested_dxf_insert_arrays_are_held_to_a_work_budget() {
    let mid = insert_array("LEAF", "1000", "1000");
    let data = dxf_with(&[("LEAF", TEXT), ("MID", &mid)], &insert_array("MID", "1000", "1000"));
    let e = within(30, move || dxf::read_dxf(&data).err()).expect("the nested arrays are refused");
    assert!(e.contains("array cells"), "{e}");
}

#[test]
fn a_dxf_insert_array_past_the_work_budget_is_refused_before_walking() {
    let n = i64::MAX.to_string();
    let data = dxf_with(&[("EMPTY", "")], &insert_array("EMPTY", &n, &n));
    let e = within(30, move || dxf::read_dxf(&data).err()).expect("the array is refused");
    assert!(e.contains("array cells"), "{e}");
}

#[test]
fn a_dxf_polygon_mesh_whose_size_overflows_is_skipped() {
    let vertex = "0\nVERTEX\n8\n0\n10\n0\n20\n0\n30\n0\n70\n64\n";
    let mesh = format!(
        "0\nPOLYLINE\n8\nM\n66\n1\n70\n16\n71\n4611686018427387905\n72\n4\n{}0\nSEQEND\n8\nM\n",
        vertex.repeat(4)
    );
    let data = dxf_with(&[], &format!("{mesh}{LINE}"));
    let read = within(30, move || dxf::read_dxf(&data).map(|r| r.objects.len())).expect("the drawing reads");
    assert_eq!(read, 0);
}
