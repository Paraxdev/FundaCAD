//! The engine's benchmark set, the Rust side of sidecar/tools/bench_rebuild.py
//! and bench_import.py. One stage per invocation, one JSON line out.
//!
//!   cargo run --release -p fundacad-geom --example bench_suite -- \
//!       corpus sidecar/tools/corpus_engines.json --runs 3
//!   cargo run --release -p fundacad-geom --example bench_suite -- doc gt2_spool.funda
//!   cargo run --release -p fundacad-geom --example bench_suite -- import big.step
//!   cargo run --release -p fundacad-geom --example bench_suite -- export gt2_spool.funda 3mf
//!   cargo run --release -p fundacad-geom --example bench_suite -- faces sidecar/tools/corpus_engines.json
//!
//! Stages measure whole-op work the way the worker runs it: `corpus` and `doc`
//! rebuild AND mesh, `import` splits the phases the way bench_import.py does.

use std::time::{Duration, Instant};

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::{mesh, reply};
use serde_json::{json, Map, Value};

fn median(mut v: Vec<Duration>) -> f64 {
    v.sort();
    v[v.len() / 2].as_secs_f64() * 1000.0
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn read_json(path: &str) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path} is not JSON: {e}"))
}

fn typed(v: &Value) -> CadDocument {
    serde_json::from_value(v.clone()).expect("the document types")
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn runs_of(args: &[String], fallback: usize) -> usize {
    flag(args, "--runs").and_then(|n| n.parse().ok()).unwrap_or(fallback)
}

/// Documents of a corpus file, with an `importFixture` seeded into its feature
/// exactly as diff_engines.py seeds it, so an import document is comparable.
fn corpus_documents(path: &str) -> Vec<(String, Value)> {
    let corpus = read_json(path);
    let dir = std::path::Path::new(path)
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let store = fundacad_geom::import::blobstore::BlobStore::open(
        fundacad_geom::import::blobstore::default_root(),
    )
    .expect("a blob store");
    let mut out = Vec::new();
    for entry in corpus["documents"].as_array().cloned().unwrap_or_default() {
        let name = entry["name"].as_str().unwrap_or_default().to_string();
        let mut doc = entry["document"].clone();
        if let Some(spec) = entry.get("importFixture") {
            let file = dir.join(spec["path"].as_str().unwrap_or_default());
            let fmt = spec.get("format").and_then(Value::as_str).unwrap_or("step");
            let want = spec["feature"].as_str().unwrap_or_default();
            let Ok(result) = fundacad_geom::import::import_geometry(
                &file.to_string_lossy(),
                fmt,
                &store,
            ) else {
                continue;
            };
            for f in doc["features"].as_array_mut().into_iter().flatten() {
                if f["id"].as_str() == Some(want) {
                    let mut merged = result.clone();
                    for (k, v) in f.as_object().into_iter().flatten() {
                        merged.insert(k.clone(), v.clone());
                    }
                    *f = Value::Object(merged);
                }
            }
        }
        out.push((name, doc));
    }
    out
}

/// One rebuild and one mesh of every document, the split reported separately.
fn stage_corpus(args: &[String]) {
    let path = args.first().expect("bench_suite corpus <corpus.json>");
    let runs = runs_of(args, 3);
    let docs = corpus_documents(path);
    let known = Map::new();
    let mut totals = Vec::new();
    let (mut build_ms, mut mesh_ms, mut bodies) = (0.0, 0.0, 0usize);
    let mut each: Vec<(String, f64)> = Vec::new();
    for r in 0..runs {
        let began = Instant::now();
        let (mut b, mut m, mut n) = (0.0, 0.0, 0usize);
        each.clear();
        for (name, doc) in &docs {
            let t = Instant::now();
            let built = builder::rebuild(&typed(doc), doc, &NoWatch).ok().expect("not cancelled");
            b += ms(t.elapsed());
            let one = ms(t.elapsed());
            let t = Instant::now();
            let _ = reply::mesh_result(&built.bodies, 0.1, &known, &NoWatch);
            m += ms(t.elapsed());
            n += built.bodies.len();
            each.push((name.clone(), one + ms(t.elapsed())));
        }
        totals.push(began.elapsed());
        if r == runs - 1 {
            (build_ms, mesh_ms, bodies) = (b, m, n);
        }
    }
    each.sort_by(|a, b| b.1.total_cmp(&a.1));
    each.truncate(12);
    println!(
        "{}",
        json!({
            "stage": "corpus",
            "documents": docs.len(),
            "bodies": bodies,
            "runs": runs,
            "total_ms": median(totals),
            "rebuild_ms": build_ms,
            "mesh_ms": mesh_ms,
            "slowest": each.iter().map(|(n, v)| json!([n, (v * 10.0).round() / 10.0])).collect::<Vec<_>>(),
            "phases": fundacad_geom::bench::report(),
        })
    );
}

/// One document through the four cache states, plus the mesh on its own.
fn stage_doc(args: &[String]) {
    let path = args.first().expect("bench_suite doc <document>");
    let runs = runs_of(args, 5);
    let raw = read_json(path);
    let known = Map::new();

    let mut cold_build = Vec::new();
    let mut cold_mesh = Vec::new();
    let mut bodies = 0;
    let mut tris = 0usize;
    for _ in 0..runs {
        let t = Instant::now();
        let built = builder::rebuild(&typed(&raw), &raw, &NoWatch).ok().expect("not cancelled");
        cold_build.push(t.elapsed());
        let t = Instant::now();
        let meshed = reply::mesh_result(&built.bodies, 0.1, &known, &NoWatch);
        cold_mesh.push(t.elapsed());
        bodies = built.bodies.len();
        if let fundacad_protocol::JobResult::Mesh(m) = &meshed {
            tris = m
                .bodies
                .iter()
                .map(|b| match b {
                    fundacad_protocol::WireBody::Full(f) => f.indices.len() / 3,
                    fundacad_protocol::WireBody::Stub(_) => 0,
                })
                .sum();
        }
    }

    let mut warm = Vec::new();
    for _ in 0..runs {
        let mut cache = RebuildCache::new(None);
        let r = cache.rebuild(&typed(&raw), &raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known, &mut |_, _| {});
        let t = Instant::now();
        let r = cache.rebuild(&typed(&raw), &raw, &NoWatch).ok().expect("not cancelled");
        cache.mesh(&r, 0.1, &known, &mut |_, _| {});
        warm.push(t.elapsed());
    }

    println!(
        "{}",
        json!({
            "stage": "doc",
            "document": path,
            "features": raw["features"].as_array().map_or(0, Vec::len),
            "bodies": bodies,
            "triangles": tris,
            "runs": runs,
            "cold_rebuild_ms": median(cold_build),
            "cold_mesh_ms": median(cold_mesh),
            "warm_unchanged_ms": median(warm),
            "phases": fundacad_geom::bench::report(),
        })
    );
}

/// A one feature document holding `path` as imported geometry, the shape the
/// import stage and the smooth check both rebuild.
fn imported_document(path: &str, fmt: &str) -> (Value, f64, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("fundacad-bench-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    // The import FEATURE reads the blob back from the default root, so the
    // bench store has to be that root, not a store opened beside it.
    std::env::set_var("FUNDACAD_BLOB_DIR", &root);
    let store = fundacad_geom::import::blobstore::BlobStore::open(
        fundacad_geom::import::blobstore::default_root(),
    )
    .expect("a blob store");
    let began = Instant::now();
    let mut feature = fundacad_geom::import::import_geometry(path, fmt, &store)
        .expect("the import runs");
    let took = ms(began.elapsed());
    feature.insert("id".into(), json!("im"));
    feature.insert("type".into(), json!("import"));
    (json!({"parameters": {}, "features": [Value::Object(feature)]}), took, root)
}

/// The import path bench_import.py measures: read the file into the blob
/// store, rebuild the one-feature document, then the payload loop.
fn stage_import(args: &[String]) {
    let path = args.first().expect("bench_suite import <file>");
    let fmt = args
        .get(1)
        .filter(|a| !a.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| {
            std::path::Path::new(path)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .filter(|e| e != "stp")
                .unwrap_or_else(|| "step".into())
        });
    let (doc, import_ms, root) = imported_document(path, &fmt);

    let t = Instant::now();
    let built = builder::rebuild(&typed(&doc), &doc, &NoWatch).ok().expect("not cancelled");
    let rebuild_ms = ms(t.elapsed());

    let known = Map::new();
    let t = Instant::now();
    let meshed = reply::mesh_result(&built.bodies, 0.1, &known, &NoWatch);
    let payload_ms = ms(t.elapsed());

    let (mut tris, mut faces, mut frame_ms, mut frame_mib) = (0usize, 0usize, 0.0, 0.0);
    if let fundacad_protocol::JobResult::Mesh(m) = &meshed {
        for b in &m.bodies {
            if let fundacad_protocol::WireBody::Full(f) = b {
                tris += f.indices.len() / 3;
                faces += f.fields.get("faceCount").and_then(Value::as_u64).unwrap_or(0) as usize;
            }
        }
        let t = Instant::now();
        let bytes = fundacad_protocol::frame::encode_binary_reply(
            &json!(1),
            m,
            &fundacad_protocol::Limits::default(),
        );
        frame_ms = ms(t.elapsed());
        frame_mib = bytes.map_or(0, |b| b.len()) as f64 / (1024.0 * 1024.0);
    }
    let out = std::env::temp_dir().join(format!("fundacad-bench-out-{}", std::process::id()));
    std::fs::create_dir_all(&out).expect("a temp directory");
    let mut exports = Map::new();
    for fmt in ["stl", "3mf"] {
        let target = out.join(format!("bench.{fmt}")).to_string_lossy().to_string();
        let mut req = Map::new();
        req.insert("format".into(), json!(fmt));
        req.insert("path".into(), json!(target));
        let t = Instant::now();
        let r = fundacad_geom::export::export_built(&req, &doc, fmt, &target, &built.bodies, &built.errors);
        exports.insert(fmt.into(), json!(ms(t.elapsed())));
        assert!(!r.contains_key("error"), "{fmt} export failed: {r:?}");
    }
    let _ = std::fs::remove_dir_all(&out);
    let _ = std::fs::remove_dir_all(&root);
    println!(
        "{}",
        json!({
            "stage": "import",
            "export_ms": exports,
            "file": path,
            "bodies": built.bodies.len(),
            "faces": faces,
            "triangles": tris,
            "import_ms": import_ms,
            "rebuild_ms": rebuild_ms,
            "payloads_ms": payload_ms,
            "frame_ms": frame_ms,
            "frame_mib": (frame_mib * 10.0).round() / 10.0,
            "total_ms": import_ms + rebuild_ms + payload_ms + frame_ms,
            "phases": fundacad_geom::bench::report(),
        })
    );
}

/// Export writers, timed after the rebuild so only the writer is measured.
fn stage_export(args: &[String]) {
    let path = args.first().expect("bench_suite export <document> [format...]");
    let runs = runs_of(args, 3);
    let formats: Vec<String> = match args
        .iter()
        .skip(1)
        .take_while(|a| !a.starts_with("--"))
        .cloned()
        .collect::<Vec<_>>()
    {
        f if f.is_empty() => ["stl", "3mf", "step", "glb"].iter().map(|s| s.to_string()).collect(),
        f => f,
    };
    let doc = read_json(path);
    let built = builder::rebuild(&typed(&doc), &doc, &NoWatch).ok().expect("not cancelled");
    let out = std::env::temp_dir().join(format!("fundacad-bench-export-{}", std::process::id()));
    std::fs::create_dir_all(&out).expect("a temp directory");
    let mut times = Map::new();
    for fmt in &formats {
        let target = out.join(format!("bench.{fmt}"));
        let target = target.to_string_lossy().to_string();
        let mut req = Map::new();
        req.insert("format".into(), json!(fmt));
        req.insert("path".into(), json!(target));
        let mut each = Vec::new();
        for _ in 0..runs {
            let t = Instant::now();
            let r = fundacad_geom::export::export_built(&req, &doc, fmt, &target, &built.bodies, &built.errors);
            each.push(t.elapsed());
            assert!(!r.contains_key("error"), "{fmt} export failed: {r:?}");
        }
        times.insert(fmt.clone(), json!(median(each)));
    }
    let _ = std::fs::remove_dir_all(&out);
    println!("{}", json!({"stage": "export", "document": path, "runs": runs, "ms": times}));
}

/// Face bands and the display tessellation, the two per-body passes that
/// dominate a large assembly's payload loop.
fn stage_faces(args: &[String]) {
    let path = args.first().expect("bench_suite faces <document|corpus.json>");
    let runs = runs_of(args, 3);
    let raw = read_json(path);
    let docs: Vec<Value> = if raw.get("documents").is_some() {
        corpus_documents(path).into_iter().map(|(_, d)| d).collect()
    } else {
        vec![raw]
    };
    let mut shapes = Vec::new();
    for doc in &docs {
        let built = builder::rebuild(&typed(doc), doc, &NoWatch).ok().expect("not cancelled");
        for b in built.bodies {
            shapes.push(b.shape);
        }
    }
    let mut bands = Vec::new();
    let mut tess = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        let mut n = 0;
        for s in &shapes {
            n += fundacad_geom::faces::face_bands(s).len();
        }
        bands.push(t.elapsed());
        std::hint::black_box(n);
        let t = Instant::now();
        for s in &shapes {
            let _ = mesh::body_payload(s, "b", "b", 0.1, mesh::ViewportProfile::default());
        }
        tess.push(t.elapsed());
    }
    println!(
        "{}",
        json!({
            "stage": "faces",
            "shapes": shapes.len(),
            "runs": runs,
            "face_bands_ms": median(bands),
            "body_payload_ms": median(tess),
            "phases": fundacad_geom::bench::report(),
        })
    );
}

/// The batched smooth edge test against the per sample walk it replaced, over
/// The whole reply frame of a document, as a digest. Run it once with
/// `FUNDACAD_THREADS=1` and once without: the two digests must match, which is
/// the promise the parallel passes make.
fn stage_digest(args: &[String]) {
    let path = args.first().expect("bench_suite digest <document|corpus.json|file.step>");
    let lower = path.to_lowercase();
    let raw = if lower.ends_with(".step") || lower.ends_with(".stp") {
        imported_document(path, "step").0
    } else {
        read_json(path)
    };
    let docs: Vec<(String, Value)> = if raw.get("documents").is_some() {
        corpus_documents(path)
    } else {
        vec![(path.clone(), raw)]
    };
    let known = Map::new();
    let mut digests = Map::new();
    for (name, doc) in &docs {
        let built = builder::rebuild(&typed(doc), doc, &NoWatch).ok().expect("not cancelled");
        let meshed = reply::mesh_result(&built.bodies, 0.1, &known, &NoWatch);
        let bytes = match &meshed {
            fundacad_protocol::JobResult::Mesh(m) => fundacad_protocol::frame::encode_binary_reply(
                &json!(1),
                m,
                &fundacad_protocol::Limits::default(),
            )
            .unwrap_or_default(),
            other => serde_json::to_vec(&json!(format!("{other:?}"))).unwrap_or_default(),
        };
        digests.insert(name.clone(), json!(digest(&bytes)));
    }
    println!(
        "{}",
        json!({
            "stage": "digest",
            "threads": fundacad_geom::par::threads(),
            "documents": digests.len(),
            "digests": digests,
        })
    );
}

fn digest(bytes: &[u8]) -> String {
    use blake2::digest::{Update, VariableOutput};
    let mut h = blake2::Blake2bVar::new(16).expect("16 is a valid digest size");
    h.update(bytes);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).expect("the buffer is 16 bytes");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// every edge of a real document. The flag rides in the payload and in a saved
/// selector, so the two must never disagree.
fn stage_smooth(args: &[String]) {
    let path = args.first().expect("bench_suite smooth <document|corpus.json|file.step>");
    let raw = if path.to_lowercase().ends_with(".step") || path.to_lowercase().ends_with(".stp") {
        imported_document(path, "step").0
    } else {
        read_json(path)
    };
    let docs: Vec<Value> = if raw.get("documents").is_some() {
        corpus_documents(path).into_iter().map(|(_, d)| d).collect()
    } else {
        vec![raw]
    };
    let cos_tol = fundacad_geom::mesh::edges::SMOOTH_EDGE_DEG.to_radians().cos();
    let (mut edges, mut differ) = (0usize, 0usize);
    for doc in &docs {
        let built = builder::rebuild(&typed(doc), doc, &NoWatch).ok().expect("not cancelled");
        for b in &built.bodies {
            let access = fundacad_geom::opencascade::mesh_access::MeshAccess::new(&b.shape);
            for e in 0..access.edge_count() {
                edges += 1;
                if fundacad_geom::mesh::edges::meets_smoothly(&access, e)
                    != access.edge_smooth(e, cos_tol)
                {
                    differ += 1;
                }
            }
        }
    }
    println!("{}", json!({"stage": "smooth", "edges": edges, "differ": differ}));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = &args[1..];
    match args.first().map(String::as_str) {
        Some("corpus") => stage_corpus(rest),
        Some("doc") => stage_doc(rest),
        Some("import") => stage_import(rest),
        Some("export") => stage_export(rest),
        Some("faces") => stage_faces(rest),
        Some("smooth") => stage_smooth(rest),
        Some("digest") => stage_digest(rest),
        _ => {
            eprintln!("usage: bench_suite <corpus|doc|import|export|faces|smooth|digest> <path> [--runs N]");
            std::process::exit(2);
        }
    }
}
