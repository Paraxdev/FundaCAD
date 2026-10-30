//! Mesh readers keep a work budget: a small file that declares or instances
//! far more geometry than it carries is refused quickly.

use std::borrow::Cow;
use std::sync::mpsc;
use std::time::Duration;

use fundacad_geom::import::{self, blobstore::BlobStore, dxf, gltf, mesh, off, ply, scan, svg, x3d};
use serde_json::{json, Value};

#[path = "support/threemf.rs"]
mod threemf;
use threemf::{deflate, repeated_part, threemf_zip};

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

#[test]
fn a_gltf_node_listed_twice_under_one_parent_still_imports() {
    let acc = json!({"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"});
    let doc = gltf_doc(acc, json!([{"children": [1, 1, 1]}, {"mesh": 0}]), 36);
    let (pos, idx) = read(doc, triangle_bin()).unwrap();
    assert_eq!((pos.len(), idx), (27, vec![0, 1, 2, 3, 4, 5, 6, 7, 8]));
}

#[test]
fn a_gltf_accessor_without_a_buffer_view_is_no_larger_than_its_buffers() {
    let acc = json!({"componentType": 5126, "count": 3_000_000, "type": "VEC3"});
    let out = read(gltf_doc(acc, json!([{"mesh": 0}]), 36), triangle_bin()).err();
    assert_eq!(out.as_deref(), Some("couldn't read this glTF file, it may be corrupt or not a .glb"));
}

#[test]
fn a_gltf_mesh_of_empty_primitives_placed_many_times_is_held_to_a_primitive_budget() {
    let acc = json!({"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"});
    let mut doc = gltf_doc(acc, json!([{"children": vec![1; 1023]}, {"mesh": 0}]), 36);
    doc["meshes"] = json!([{"primitives": vec![json!({}); 10_000]}]);
    let out = within(60, move || read(doc, triangle_bin()).err());
    assert_eq!(out.as_deref(), Some("this glTF places too many mesh primitives to import"));
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

/// `n` reuses of an empty group, as X3D children.
fn empty_uses(n: usize) -> String {
    "<Group USE=\"e\"/>".repeat(n)
}

#[test]
fn an_x3d_switch_reused_many_times_walks_only_its_chosen_child() {
    let leaf =
        format!("<Switch whichChoice=\"50001\"><Group DEF=\"e\"/>{}<Shape><Box/></Shape></Switch>", empty_uses(50_000));
    let xml = x3d_doubling(&leaf, 16);
    let (objects, _) = within(30, move || x3d::read_x3d(&xml, Some(1.0))).unwrap();
    let tris: usize = objects.iter().map(|o| o.idx.len() / 3).sum();
    assert_eq!(tris, 12 * ((1 << 17) - 1));
}

#[test]
fn an_x3d_shape_with_many_children_reused_many_times_is_held_to_a_visit_budget() {
    let leaf = format!("<Group DEF=\"e\"/><Shape>{}<Box/></Shape>", empty_uses(50_000));
    let xml = x3d_doubling(&leaf, 16);
    let out = within(30, move || x3d::read_x3d(&xml, Some(1.0)).err());
    assert_eq!(out.as_deref(), Some("this scene reuses its nodes too many times to import"));
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
fn a_3mf_part_declaring_a_scan_sized_model_still_imports() {
    let mut crc = flate2::Crc::new();
    crc.update(CUBE_MODEL.as_bytes());
    let deflated = deflate(CUBE_MODEL.as_bytes(), flate2::FlushCompress::Finish);
    let honest = import_3mf("honest", threemf_zip(&deflated, crc.sum(), CUBE_MODEL.len() as u32));
    let declared = import_3mf("scan-sized", threemf_zip(&deflated, crc.sum(), 300 << 20));
    assert_eq!(declared, honest);
}

#[test]
fn a_3mf_part_that_unpacks_past_the_budget_is_refused() {
    let zip = repeated_part(&[b' '; 1 << 20], 1100);
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
fn a_dxf_insert_array_of_a_block_heavy_with_vertices_is_held_to_a_work_budget() {
    let vertex = "0\nVERTEX\n8\n0\n10\n0\n20\n0\n30\n0\n70\n64\n";
    let mesh = format!("0\nPOLYLINE\n8\n0\n66\n1\n70\n64\n{}0\nSEQEND\n8\n0\n", vertex.repeat(20_000));
    let data = dxf_with(&[("HEAVY", &mesh)], &insert_array("HEAVY", "1000", "1000"));
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

const SOLID_STL: &str = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";

#[test]
fn dropped_bytes_are_staged_in_a_fresh_private_directory() {
    use base64::Engine as _;
    let blobs = std::env::temp_dir().join(format!("fundacad-budget-blobs-{}", std::process::id()));
    std::env::set_var("FUNDACAD_BLOB_DIR", &blobs);
    let earlier: Vec<_> =
        (0..64).map(|n| std::env::temp_dir().join(format!("fundacad-drop-{}-{n}", std::process::id()))).collect();
    for dir in &earlier {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("part.stl"), "kept").unwrap();
    }
    let data = base64::engine::general_purpose::STANDARD.encode(SOLID_STL);
    let req = json!({"op": "import", "format": "stl", "name": "part.stl", "data": data});
    let reply = match import::import_result(req.as_object().unwrap()) {
        fundacad_protocol::JobResult::Json(m) => Value::Object(m),
        fundacad_protocol::JobResult::Mesh(_) => panic!("an import replies with json"),
    };
    let untouched = earlier.iter().all(|d| std::fs::read_to_string(d.join("part.stl")).is_ok_and(|s| s == "kept"));
    for dir in &earlier {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_dir_all(&blobs);
    assert!(reply.get("error").is_none(), "{reply}");
    assert!(untouched, "a directory already in the temp dir was written into");
}

fn svg_reusing(path: &str, uses: usize) -> Vec<u8> {
    let refs: String = (0..uses).map(|_| r##"<use href="#p"/>"##).collect();
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><defs>{path}</defs><rect width="4" height="4"/>{refs}</svg>"#
    )
    .into_bytes()
}

#[test]
fn a_hidden_svg_path_reused_many_times_is_not_parsed() {
    let d: String = (0..200_000).map(|_| "l1 0 ").collect();
    let data = svg_reusing(&format!(r#"<path id="p" visibility="hidden" d="M0 0 {d}"/>"#), 5000);
    let read = within(30, move || svg::read_svg(&data).map(|r| r.sketches.len())).expect("the drawing reads");
    assert_eq!(read, 1);
}

#[test]
fn an_svg_path_without_curves_reused_many_times_is_held_to_a_parse_budget() {
    let d: String = (0..200_000).map(|_| "M0 0 ").collect();
    let data = svg_reusing(&format!(r#"<path id="p" d="{d}"/>"#), 5000);
    let e = within(30, move || svg::read_svg(&data).err()).expect("the reuse is refused");
    assert!(e.contains("path data"), "{e}");
}

#[test]
fn a_large_svg_drawn_once_is_not_held_to_the_reuse_budget() {
    let d = "M0 0 ".repeat(14 << 20);
    let data = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="4" height="4"/><path d="{d}"/></svg>"#)
        .into_bytes();
    let read = within(120, move || svg::read_svg(&data).map(|r| r.sketches.len()));
    assert_eq!(read, Ok(1));
}

#[test]
fn an_obj_face_fanning_past_the_scan_cap_is_refused() {
    let text = format!("v 0 0 0\nf {}\n", "1 ".repeat(10_000_003));
    assert_eq!(mesh::obj_triangles(&text).err(), Some(scan::too_dense_for_a_scan(10_000_001)));
}

#[test]
fn an_off_face_fanning_past_the_scan_cap_is_refused() {
    let text = format!(
        "OFF
1 1 0
0 0 0
10000003 {}
",
        "0 ".repeat(10_000_003)
    );
    assert_eq!(off::read_off(&text).err(), Some(scan::too_dense_for_a_scan(10_000_001)));
}

fn ply_binary(vertices: usize, body: &[u8]) -> Vec<u8> {
    let mut data = format!(
        "ply
format binary_little_endian 1.0
element vertex {vertices}
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
"
    )
    .into_bytes();
    data.extend_from_slice(body);
    data
}

fn ply_triangle_body() -> Vec<u8> {
    let mut body = triangle_bin();
    body.push(3);
    body.extend([0i32, 1, 2].iter().flat_map(|i| i.to_le_bytes()));
    body
}

#[test]
fn a_binary_ply_triangle_still_imports() {
    let mesh = ply::read_ply(&ply_binary(3, &ply_triangle_body())).expect("the triangle reads");
    assert_eq!(mesh.idx, [0, 1, 2]);
}

#[test]
fn a_ply_vertex_count_past_what_its_rows_can_hold_is_refused() {
    let body = vec![0u8; 1 << 20];
    let e = ply::read_ply(&ply_binary(1 << 20, &body)).err().expect("the count is refused");
    assert!(e.contains("more than the file holds"), "{e}");
}

const ASCII_PLY_HEAD: &str =
    "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n";

#[test]
fn an_ascii_ply_whose_last_row_lacks_a_newline_still_imports() {
    let data = format!(
        "{ASCII_PLY_HEAD}element face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2"
    );
    assert_eq!(ply::read_ply(data.as_bytes()).map(|m| m.idx), Ok(vec![0, 1, 2]));
}

#[test]
fn an_ascii_ply_with_an_element_of_no_properties_still_imports() {
    let data = format!(
        "{ASCII_PLY_HEAD}element face 1\nproperty list uchar int vertex_indices\nelement marker 2\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n\n\n"
    );
    assert_eq!(ply::read_ply(data.as_bytes()).map(|m| m.idx), Ok(vec![0, 1, 2]));
}

#[test]
fn a_binary_ply_with_a_large_element_of_no_properties_still_imports() {
    let mut data = ply_binary(3, &ply_triangle_body());
    let at = data.windows(10).position(|w| w == b"end_header").unwrap();
    data.splice(
        at..at,
        b"element marker 1000000
"
        .iter()
        .copied(),
    );
    assert_eq!(ply::read_ply(&data).map(|m| m.idx), Ok(vec![0, 1, 2]));
}
