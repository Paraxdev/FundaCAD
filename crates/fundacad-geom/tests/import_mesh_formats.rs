//! PLY, OFF, AMF and text glTF imports, fixtures written here: a 10 mm cube
//! and two named coloured cubes 20 mm apart.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel;
use serde_json::{json, Map, Value};

const V: [[f32; 3]; 8] = [
    [0.0, 0.0, 0.0],
    [10.0, 0.0, 0.0],
    [10.0, 10.0, 0.0],
    [0.0, 10.0, 0.0],
    [0.0, 0.0, 10.0],
    [10.0, 0.0, 10.0],
    [10.0, 10.0, 10.0],
    [0.0, 10.0, 10.0],
];
const T: [[i32; 3]; 12] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
];
const Q: [[i32; 4]; 6] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

fn dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-mesh-formats-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("blobs")).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", dir.join("blobs"));
        dir
    })
}

fn write(name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir().join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

fn import_as(path: &Path, fmt: &str) -> Result<Map<String, Value>, String> {
    let store = BlobStore::open(&dir().join("blobs")).unwrap();
    import::import_geometry(&path.to_string_lossy(), fmt, &store)
}

fn build(reply: Map<String, Value>, fmt: &str) -> Rebuild {
    let mut f = reply;
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!(fmt));
    let doc = json!({"version": 1, "parameters": {}, "features": [f]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn assert_cube(reply: &Map<String, Value>, what: &str) {
    assert_eq!(reply["solid"], json!(true), "{what}: {reply:?}");
    assert_eq!(reply["faces"], json!(6), "{what}: {reply:?}");
}

fn color(reply: &Map<String, Value>) -> String {
    reply.get("color").and_then(Value::as_str).unwrap_or("").to_lowercase()
}

fn ply_ascii() -> Vec<u8> {
    let mut s = String::from(
        "ply\nformat ascii 1.0\ncomment cube\nobj_info made here\nelement vertex 8\nproperty float x\nproperty float y\n\
         property float z\nelement face 6\nproperty list uchar int vertex_indices\nend_header\n",
    );
    for v in V {
        s += &format!("{} {} {}\n", v[0], v[1], v[2]);
    }
    for q in Q {
        s += &format!("4 {} {} {} {}\n", q[0], q[1], q[2], q[3]);
    }
    s.into_bytes()
}

fn ply_binary(big: bool) -> Vec<u8> {
    let order = if big { "binary_big_endian" } else { "binary_little_endian" };
    let mut b = format!(
        "ply\nformat {order} 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\n\
         property uchar red\nproperty uchar green\nproperty uchar blue\nelement edge 1\nproperty int vertex1\n\
         property int vertex2\nelement face 12\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n"
    )
    .into_bytes();
    let f = |x: f32| if big { x.to_be_bytes() } else { x.to_le_bytes() };
    let i = |x: i32| if big { x.to_be_bytes() } else { x.to_le_bytes() };
    for v in V {
        for c in v {
            b.extend(f(c));
        }
        b.extend([200, 30, 30]);
    }
    b.extend(i(0));
    b.extend(i(1));
    for t in T {
        b.push(3);
        for k in t {
            b.extend(i(k));
        }
        b.push(2);
        b.extend(f(0.5));
        b.extend(f(0.5));
    }
    b
}

fn off() -> Vec<u8> {
    let mut s = String::from("OFF\n# cube\n8 6 12\n");
    for v in V {
        s += &format!("{} {} {}\n", v[0], v[1], v[2]);
    }
    for q in Q {
        s += &format!("4 {} {} {} {} 0.0 0.5 1.0\n", q[0], q[1], q[2], q[3]);
    }
    s.into_bytes()
}

fn amf() -> String {
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<amf unit=\"inch\" version=\"1.1\">\n");
    for (i, (name, off, col)) in [("Left", 0.0, "1</r><g>0</g><b>0"), ("Right", 20.0, "0</r><g>0</g><b>1")].iter().enumerate() {
        s += &format!(
            " <object id=\"{i}\">\n  <metadata type=\"name\">{name}</metadata>\n  <color><r>{col}</b></color>\n  <mesh>\n   <vertices>\n"
        );
        for v in V {
            s += &format!(
                "    <vertex><coordinates><x>{}</x><y>{}</y><z>{}</z></coordinates></vertex>\n",
                (v[0] + off) / 25.4,
                v[1] / 25.4,
                v[2] / 25.4
            );
        }
        s += "   </vertices>\n   <volume>\n";
        for t in T {
            s += &format!("    <triangle><v1>{}</v1><v2>{}</v2><v3>{}</v3></triangle>\n", t[0], t[1], t[2]);
        }
        s += "   </volume>\n  </mesh>\n </object>\n";
    }
    s + "</amf>\n"
}

fn zipped(name: &str, body: &[u8]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let mut z = zip::ZipWriter::new(&mut out);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    z.start_file(name, opts).unwrap();
    z.write_all(body).unwrap();
    z.finish().unwrap();
    out.into_inner()
}

/// The cube in metres, Y up, as a glTF exporter writes it.
fn gltf_buffer() -> Vec<u8> {
    let mut b = Vec::new();
    for v in V {
        for c in [v[0] / 1000.0, v[2] / 1000.0, -v[1] / 1000.0] {
            b.extend(c.to_le_bytes());
        }
    }
    for t in T {
        for k in t {
            b.extend((k as u16).to_le_bytes());
        }
    }
    b
}

fn gltf_json(uri: &str) -> Value {
    let n = gltf_buffer().len();
    json!({
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "Cube"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.2, 0.6, 0.2, 1]}}],
        "buffers": [{"byteLength": n, "uri": uri}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 96}, {"buffer": 0, "byteOffset": 96, "byteLength": 72}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3"},
            {"bufferView": 1, "componentType": 5123, "count": 36, "type": "SCALAR"}
        ]
    })
}

fn glb() -> Vec<u8> {
    let mut doc = gltf_json("");
    doc["buffers"][0].as_object_mut().unwrap().remove("uri");
    let mut js = serde_json::to_vec(&doc).unwrap();
    while js.len() % 4 != 0 {
        js.push(b' ');
    }
    let bin = gltf_buffer();
    let total = 12 + 8 + js.len() + 8 + bin.len();
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((js.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&js);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

#[test]
fn ply_ascii_binary_and_off_cubes_import_as_one_solid() {
    let r = import_as(&write("cube_ascii.ply", &ply_ascii()), "ply").unwrap();
    assert_cube(&r, "ascii ply");
    for (name, big) in [("cube_le.ply", false), ("cube_be.ply", true)] {
        let r = import_as(&write(name, &ply_binary(big)), "ply").unwrap();
        assert_cube(&r, name);
        assert_eq!(color(&r), "#c81e1e", "{name}");
        let b = build(r, "ply");
        assert_eq!(b.bodies.len(), 1);
        assert!((kernel::volume(&b.bodies[0].shape) - 1000.0).abs() < 1e-3, "{name}");
    }
    let r = import_as(&write("cube.off", &off()), "off").unwrap();
    assert_cube(&r, "off");
    assert_eq!(color(&r), "#0080ff");
}

#[test]
fn a_broken_ply_or_off_says_what_it_is() {
    let mut cut = ply_binary(false);
    cut.truncate(cut.len() - 20);
    let e = import_as(&write("cut.ply", &cut), "ply").unwrap_err();
    assert!(e.contains("PLY"), "{e}");
    let huge = b"ply\nformat binary_little_endian 1.0\nelement vertex 4000000000\nproperty float x\nproperty float y\n\
                 property float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n";
    let e = import_as(&write("huge.ply", huge), "ply").unwrap_err();
    assert!(e.contains("PLY"), "{e}");
    let dense = b"ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n\
                  element face 900000\nproperty list uchar int vertex_indices\nend_header\n";
    let e = import_as(&write("dense.ply", dense), "ply").unwrap_err();
    assert!(e.contains("too dense"), "{e}");
    let e = import_as(&write("bad.off", b"OFF\n8 1 0\n0 0 0\n"), "off").unwrap_err();
    assert!(e.contains("OFF"), "{e}");
}

#[test]
fn amf_objects_become_named_coloured_bodies() {
    let text = amf();
    for (name, bytes) in [("two.amf", text.clone().into_bytes()), ("two_zip.amf", zipped("two.amf", text.as_bytes()))] {
        let reply = import_as(&write(name, &bytes), "amf").unwrap();
        assert_eq!(reply["solid"], json!(true), "{name}");
        let parts = reply["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2, "{name}");
        assert_eq!(parts[0]["color"], json!("#ff0000"));
        assert_eq!(parts[1]["color"], json!("#0000ff"));
        let b = build(reply, "amf");
        let names: Vec<&str> = b.bodies.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["Left", "Right"], "{name}");
        for body in &b.bodies {
            assert!((kernel::volume(&body.shape) - 1000.0).abs() < 1e-2, "{name}: inches to mm");
        }
        let bb = kernel::bbox(&b.bodies[1].shape).unwrap();
        assert!((bb[0] - 20.0).abs() < 1e-3, "{bb:?}");
    }
}

#[test]
fn gltf_text_matches_glb() {
    let want = import_as(&write("cube.glb", &glb()), "glb").unwrap();
    assert_cube(&want, "glb");
    use base64::Engine as _;
    let data = format!("data:application/octet-stream;base64,{}", base64::engine::general_purpose::STANDARD.encode(gltf_buffer()));
    write("cube ext.bin", &gltf_buffer());
    for (name, uri) in [("embedded.gltf", data.as_str()), ("external.gltf", "cube%20ext.bin")] {
        let got = import_as(&write(name, &serde_json::to_vec(&gltf_json(uri)).unwrap()), "gltf").unwrap();
        assert_cube(&got, name);
        assert_eq!(color(&got), color(&want), "{name}");
        let b = build(got, "gltf");
        assert!((kernel::volume(&b.bodies[0].shape) - 1000.0).abs() < 1e-3, "{name}");
    }
}

#[test]
fn gltf_buffers_outside_the_file_folder_are_refused() {
    for uri in ["../outside.bin", "C:/x.bin", "/etc/x.bin", "https://example.com/x.bin", "sub/../../x.bin"] {
        let e = import_as(&write("escape.gltf", &serde_json::to_vec(&gltf_json(uri)).unwrap()), "gltf").unwrap_err();
        assert!(e.contains("folder"), "{uri}: {e}");
    }
    let e = import_as(&write("missing.gltf", &serde_json::to_vec(&gltf_json("nope.bin")).unwrap()), "gltf").unwrap_err();
    assert!(e.contains("nope.bin"), "{e}");
}

fn arrays(name: &str) -> (Vec<f64>, Vec<u32>) {
    let raw = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/export/{name}.mesh"))).unwrap();
    let nv = u32::from_le_bytes(raw[0..4].try_into().unwrap()) as usize;
    let nt = u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize;
    let pos = raw[8..8 + nv * 24].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let idx = raw[8 + nv * 24..8 + nv * 24 + nt * 12]
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    (pos, idx)
}

#[test]
fn ply_and_off_answer_as_the_stl_oracle_does() {
    let oracle: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/mesh_import/oracle.json")).unwrap(),
    )
    .unwrap();
    let store = BlobStore::open(&dir().join("blobs")).unwrap();
    for name in ["box", "box_minus_cylinder", "two_solids"] {
        let (pos, idx) = arrays(name);
        let want = &oracle[format!("{name}.stl")];
        let mut ply = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex {}\nproperty double x\nproperty double y\nproperty double z\n\
             element face {}\nproperty list uchar uint vertex_indices\nend_header\n",
            pos.len() / 3,
            idx.len() / 3
        )
        .into_bytes();
        pos.iter().for_each(|v| ply.extend(v.to_le_bytes()));
        for t in idx.chunks_exact(3) {
            ply.push(3);
            t.iter().for_each(|i| ply.extend(i.to_le_bytes()));
        }
        let mut off = format!("OFF\n{} {} 0\n", pos.len() / 3, idx.len() / 3);
        pos.chunks_exact(3).for_each(|p| off += &format!("{:?} {:?} {:?}\n", p[0], p[1], p[2]));
        idx.chunks_exact(3).for_each(|t| off += &format!("3 {} {} {}\n", t[0], t[1], t[2]));
        for (fmt, bytes) in [("ply", ply), ("off", off.into_bytes())] {
            let path = write(&format!("{name}.{fmt}"), &bytes);
            let mut reply = import::import_geometry(&path.to_string_lossy(), fmt, &store).unwrap();
            let geom = reply.remove("geom").unwrap();
            let shape = opencascade::xcaf::from_bin(&store.get_bytes(geom.as_str().unwrap()).unwrap()).unwrap();
            let w = &want["reply"];
            assert_eq!((&reply["solid"], &reply["faces"]), (&w["solid"], &w["faces"]), "{name}.{fmt}");
            let wv = want["volume"].as_f64().unwrap();
            assert!((kernel::volume(&shape) - wv).abs() < 2e-3 * wv.abs(), "{name}.{fmt}");
            assert_eq!(kernel::count(&shape, kernel::Kind::Solid) as u64, want["solids"].as_u64().unwrap(), "{name}.{fmt}");
        }
    }
}
