//! Dense meshes import as read-only reference scans: one surfaceless face that
//! holds the file's triangles, never sewn, never a boolean operand.

use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore, mesh::MAX_IMPORT_TRIANGLES};
use fundacad_geom::reply;
use fundacad_protocol::{JobResult, WireBody};
use serde_json::{json, Map, Value};

fn scratch() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-scan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

/// A closed UV sphere of radius 20 around (0, 0, 20), pole fans included.
fn sphere(lat: usize, lon: usize) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let r = 20.0f64;
    let mut v = vec![[0.0, 0.0, 40.0f32]];
    for i in 1..lat {
        let th = std::f64::consts::PI * i as f64 / lat as f64;
        for j in 0..lon {
            let ph = std::f64::consts::TAU * j as f64 / lon as f64;
            v.push([(r * th.sin() * ph.cos()) as f32, (r * th.sin() * ph.sin()) as f32, (20.0 + r * th.cos()) as f32]);
        }
    }
    let south = v.len() as u32;
    v.push([0.0, 0.0, 0.0]);
    let at = |i: usize, j: usize| (1 + (i - 1) * lon + j % lon) as u32;
    let mut t = Vec::new();
    for j in 0..lon {
        t.push([0, at(1, j), at(1, j + 1)]);
        t.push([south, at(lat - 1, j + 1), at(lat - 1, j)]);
    }
    for i in 1..lat - 1 {
        for j in 0..lon {
            t.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)]);
            t.push([at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
    }
    (v, t)
}

/// 151,240 triangles, just over the editable limit.
fn dense() -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let (v, t) = sphere(200, 380);
    assert!(t.len() as u64 > MAX_IMPORT_TRIANGLES);
    (v, t)
}

fn write_stl(path: &PathBuf, v: &[[f32; 3]], t: &[[u32; 3]]) {
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&(t.len() as u32).to_le_bytes());
    for tri in t {
        out.extend_from_slice(&[0u8; 12]);
        for &k in tri {
            for c in v[k as usize] {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    std::fs::write(path, out).unwrap();
}

fn write_text(path: &PathBuf, fmt: &str, v: &[[f32; 3]], t: &[[u32; 3]]) {
    let mut s = String::new();
    match fmt {
        "obj" => {
            for p in v {
                writeln!(s, "v {} {} {}", p[0], p[1], p[2]).unwrap();
            }
            for f in t {
                writeln!(s, "f {} {} {}", f[0] + 1, f[1] + 1, f[2] + 1).unwrap();
            }
        }
        "off" => {
            writeln!(s, "OFF\n{} {} 0", v.len(), t.len()).unwrap();
            for p in v {
                writeln!(s, "{} {} {}", p[0], p[1], p[2]).unwrap();
            }
            for f in t {
                writeln!(s, "3 {} {} {}", f[0], f[1], f[2]).unwrap();
            }
        }
        _ => {
            write!(
                s,
                "ply\nformat ascii 1.0\nelement vertex {}\nproperty float x\nproperty float y\nproperty float z\n\
                 element face {}\nproperty list uchar int vertex_indices\nend_header\n",
                v.len(),
                t.len()
            )
            .unwrap();
            for p in v {
                writeln!(s, "{} {} {}", p[0], p[1], p[2]).unwrap();
            }
            for f in t {
                writeln!(s, "3 {} {} {}", f[0], f[1], f[2]).unwrap();
            }
        }
    }
    std::fs::write(path, s).unwrap();
}

fn import_file(path: &PathBuf, fmt: &str) -> Result<Map<String, Value>, String> {
    let store = BlobStore::open(scratch()).unwrap();
    import::import_geometry(&path.to_string_lossy(), fmt, &store)
}

fn dense_stl() -> &'static (PathBuf, usize) {
    static STL: OnceLock<(PathBuf, usize)> = OnceLock::new();
    STL.get_or_init(|| {
        let (v, t) = dense();
        let path = scratch().join("sphere.stl");
        write_stl(&path, &v, &t);
        (path, t.len())
    })
}

fn scan_feature(reply: &Map<String, Value>) -> Value {
    json!({"id": "scan", "type": "import", "format": "stl", "name": reply["name"], "geom": reply["geom"],
           "solid": false, "scan": true})
}

fn build(features: Vec<Value>) -> Rebuild {
    let doc = json!({"version": 1, "parameters": {}, "features": features});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"))
}

fn payloads(r: &Rebuild) -> Vec<fundacad_protocol::FullBody> {
    let JobResult::Mesh(m) = reply::mesh_result(&r.bodies, 0.1, &Map::new(), &NoWatch) else {
        panic!("a mesh reply")
    };
    m.bodies
        .into_iter()
        .map(|b| match b {
            WireBody::Full(f) => f,
            WireBody::Stub(_) => panic!("a full body"),
        })
        .collect()
}

#[test]
fn a_mesh_over_the_cap_imports_as_one_scan_body() {
    let (path, ntri) = dense_stl();
    let t0 = std::time::Instant::now();
    let reply = import_file(path, "stl").expect("a scan, not a refusal");
    eprintln!("scan import of {ntri} triangles in {:?}", t0.elapsed());
    assert_eq!(reply["scan"], json!(true));
    assert_eq!(reply["faces"], json!(1));
    assert_eq!(reply["solid"], json!(false));
    assert_eq!(reply["triangles"], json!(*ntri));

    let t0 = std::time::Instant::now();
    let r = build(vec![scan_feature(&reply)]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1);
    assert!(r.bodies[0].scan);
    let bodies = payloads(&r);
    eprintln!("rebuild and mesh in {:?}", t0.elapsed());
    assert_eq!(bodies[0].fields["scan"], json!(true));
    assert_eq!(bodies[0].indices.len() / 3, *ntri, "every triangle of the file, none remeshed");
    assert!(bodies[0].edges.is_empty(), "a scan draws no edges");
}

#[test]
fn every_mesh_reader_routes_a_dense_file_to_a_scan() {
    let (v, t) = dense();
    for fmt in ["obj", "off", "ply"] {
        let path = scratch().join(format!("sphere.{fmt}"));
        write_text(&path, fmt, &v, &t);
        let reply = import_file(&path, fmt).unwrap_or_else(|e| panic!("{fmt}: {e}"));
        assert_eq!(reply["scan"], json!(true), "{fmt}");
        assert_eq!(reply["triangles"], json!(t.len()), "{fmt}");
        assert_eq!(reply["faces"], json!(1), "{fmt}");
    }
}

#[test]
fn a_file_past_the_scan_limit_is_refused_naming_it() {
    let path = scratch().join("huge.off");
    std::fs::write(&path, "OFF\n3 10000001 0\n0 0 0\n1 0 0\n0 1 0\n").unwrap();
    let err = import_file(&path, "off").expect_err("past the scan limit");
    assert!(err.contains("reference scan") && err.contains("10,000,000"), "{err}");
}

#[test]
fn a_join_or_cut_never_takes_a_scan() {
    let (path, ntri) = dense_stl();
    let reply = import_file(path, "stl").unwrap();
    let post = |extra: Value| {
        let mut f = json!({"id": "post", "type": "box", "length": 4, "width": 4, "height": 60, "operation": "join"});
        f.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        f
    };

    let r = build(vec![scan_feature(&reply), post(json!({}))]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 2, "the post is its own body, the scan is not fused");
    let bodies = payloads(&r);
    let scan = bodies.iter().find(|b| b.fields.get("scan") == Some(&json!(true))).expect("the scan");
    assert_eq!(scan.indices.len() / 3, *ntri);

    let r = build(vec![scan_feature(&reply), post(json!({"targets": ["body1"]}))]);
    let err = r.errors.iter().find(|e| e.wire()["feature_id"] == "post").expect("a named scan target fails");
    assert!(err.wire().to_string().contains("reference scan"), "{:?}", err.wire());

    let r = build(vec![
        scan_feature(&reply),
        json!({"id": "b", "type": "box", "length": 4, "width": 4, "height": 60}),
        json!({"id": "cut", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}),
    ]);
    let err = r.errors.iter().find(|e| e.wire()["feature_id"] == "cut").expect("a scan target fails");
    assert!(err.wire().to_string().contains("reference scan"), "{:?}", err.wire());
}

#[test]
fn a_face_feature_on_a_scan_is_refused_naming_it() {
    let (path, ntri) = dense_stl();
    let reply = import_file(path, "stl").unwrap();
    let face = json!({"kind": "face", "by": "normal", "dir": [0, 0, 1], "body": "body1"});
    let cases = [
        json!({"type": "press-pull", "distance": 1, "body": "body1", "face": face}),
        json!({"type": "offsetFace", "distance": 1, "body": "body1", "faces": face}),
        json!({"type": "deleteFace", "body": "body1", "face": face}),
        json!({"type": "thicken", "thickness": 1, "body": "body1"}),
        json!({"type": "shell", "thickness": 1, "faces": face}),
        json!({"type": "draft", "angle": 2, "faces": face, "axis": "Z"}),
        json!({"type": "fillet", "radius": 1, "edges": {"kind": "edge", "by": "all", "body": "body1"}}),
        json!({"type": "split", "plane": "XY", "keep": "both", "body": "body1"}),
        json!({"type": "separate", "body": "body1"}),
    ];
    for mut f in cases {
        let kind = f["type"].as_str().unwrap().to_owned();
        f["id"] = json!("op");
        let r = build(vec![scan_feature(&reply), f]);
        let err = r.errors.iter().find(|e| e.wire()["feature_id"] == "op");
        let text = err.map(|e| e.wire().to_string()).unwrap_or_default();
        assert!(text.contains("is a reference scan"), "{kind}: {text}");
        assert_eq!(r.bodies.len(), 1, "{kind}");
        assert!(r.bodies[0].scan, "{kind}");
        assert_eq!(payloads(&r)[0].indices.len() / 3, *ntri, "{kind}");
    }
}

#[test]
fn an_import_without_the_flag_keeps_its_old_serialisation() {
    let f: fundacad_core::schema::Import =
        serde_json::from_value(json!({"id": "f1", "type": "import", "name": "part"})).unwrap();
    assert_eq!(f.scan, None);
    assert!(serde_json::to_value(&f).unwrap().get("scan").is_none());
}

/// `cargo test --test import_scan -- --ignored --nocapture`, the timings of a
/// two million triangle scan from file to viewport payload.
#[test]
#[ignore]
fn a_two_million_triangle_scan_measured() {
    let (v, t) = sphere(1000, 1000);
    let path = scratch().join("sphere2m.stl");
    write_stl(&path, &v, &t);
    let t0 = std::time::Instant::now();
    let reply = import_file(&path, "stl").unwrap();
    eprintln!("import {} triangles: {:?}", t.len(), t0.elapsed());
    let t0 = std::time::Instant::now();
    let r = build(vec![scan_feature(&reply)]);
    eprintln!("rebuild: {:?}", t0.elapsed());
    let t0 = std::time::Instant::now();
    let bodies = payloads(&r);
    eprintln!("payload: {:?}, {} triangles", t0.elapsed(), bodies[0].indices.len() / 3);
    let _ = std::fs::remove_file(&path);
}
