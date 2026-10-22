//! Open and save timings for documents with big imports, one JSON line per stage.
//!
//!   cargo run --release -p fundacad-cli --example bench_open -- scan scan2m.stl --triangles 2000000
//!   cargo run --release -p fundacad-cli --example bench_open -- pack part.step out/part
//!   cargo run --release -p fundacad-cli --example bench_open -- open out/part.fundab --repeat 5
//!   cargo run --release -p fundacad-cli --example bench_open -- reopen out/part.fundab --repeat 5
//!
//! `pack` imports a file and saves it as `<stem>.fundab` and `<stem>.funda`.
//! `open` reads a document into an empty blob store and rebuilds it cold,
//! `reopen` reads it again with the store already filled, the common case.
//! `--threads N` sets FUNDACAD_THREADS for the file layer, `--file-only` stops
//! after it, before the engine stages.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fundacad_format::{container, fnda};
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::reply;
use serde_json::{json, Map, Value};

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1e6).round() / 1e3
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn emit(stage: &str, ms: f64, bytes: u64, extra: Value) {
    let mib_s = if ms > 0.0 && bytes > 0 { (bytes as f64 / 1048576.0) / (ms / 1000.0) } else { 0.0 };
    let mut line = json!({
        "stage": stage,
        "ms": ms,
        "bytes": bytes,
        "mib_s": (mib_s * 10.0).round() / 10.0,
        "threads": std::env::var("FUNDACAD_THREADS").unwrap_or_else(|_| "auto".into()),
    });
    if let (Some(l), Value::Object(e)) = (line.as_object_mut(), extra) {
        l.extend(e);
    }
    println!("{line}");
}

fn median_of<T>(repeat: usize, mut run: impl FnMut() -> (Duration, T)) -> (f64, T) {
    let mut times = Vec::with_capacity(repeat);
    let mut last = None;
    for _ in 0..repeat.max(1) {
        let (d, v) = run();
        times.push(d);
        last = Some(v);
    }
    times.sort();
    (ms(times[times.len() / 2]), last.expect("one run"))
}

/// A temp directory removed when it goes out of scope, a failed run included.
struct Scratch(PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<std::ffi::OsStr> for Scratch {
    fn as_ref(&self) -> &std::ffi::OsStr {
        self.0.as_os_str()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fresh_dir(tag: &str) -> Scratch {
    let d = std::env::temp_dir().join(format!("fundacad-bench-open-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a temp directory");
    Scratch(d)
}

fn dir_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir).map(|r| r.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0)
}

/// A deterministic binary STL: a sphere grid displaced by noise, like a reference scan.
fn stage_scan(args: &[String]) {
    let out = args.first().expect("bench_open scan <out.stl>");
    let triangles: usize = flag(args, "--triangles").and_then(|n| n.parse().ok()).unwrap_or(2_000_000);
    let mut seed: u64 = flag(args, "--seed").and_then(|n| n.parse().ok()).unwrap_or(1);
    let cols = ((triangles / 2) as f64).sqrt().ceil() as usize;
    let rows = (triangles / 2).div_ceil(cols);
    let mut noise = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5
    };
    let radius = 80.0;
    let mut grid = vec![[0f32; 3]; (rows + 1) * (cols + 1)];
    for r in 0..=rows {
        let theta = 0.05 + (std::f64::consts::PI - 0.1) * r as f64 / rows as f64;
        for c in 0..=cols {
            let phi = 2.0 * std::f64::consts::PI * c as f64 / cols as f64;
            let rr = radius + 0.4 * noise() + 2.0 * (5.0 * theta).sin() * (7.0 * phi).cos();
            grid[r * (cols + 1) + c] = [
                (rr * theta.sin() * phi.cos()) as f32,
                (rr * theta.sin() * phi.sin()) as f32,
                (rr * theta.cos()) as f32,
            ];
        }
    }
    let t = Instant::now();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).expect("the STL can be created"));
    w.write_all(&[0u8; 80]).unwrap();
    w.write_all(&(triangles as u32).to_le_bytes()).unwrap();
    let mut written = 0usize;
    'grid: for r in 0..rows {
        for c in 0..cols {
            let i = |rr: usize, cc: usize| grid[rr * (cols + 1) + cc];
            for tri in [[i(r, c), i(r + 1, c), i(r + 1, c + 1)], [i(r, c), i(r + 1, c + 1), i(r, c + 1)]] {
                if written == triangles {
                    break 'grid;
                }
                w.write_all(&[0u8; 12]).unwrap();
                for v in tri {
                    for x in v {
                        w.write_all(&x.to_le_bytes()).unwrap();
                    }
                }
                w.write_all(&[0u8; 2]).unwrap();
                written += 1;
            }
        }
    }
    w.flush().unwrap();
    emit("scan", ms(t.elapsed()), 84 + 50 * written as u64, json!({"triangles": written}));
}

fn deflate_alone(data: &[u8], level: u32) -> (f64, usize) {
    let t = Instant::now();
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(level));
    enc.write_all(data).unwrap();
    let n = enc.finish().unwrap().len();
    (ms(t.elapsed()), n)
}

fn stage_pack(args: &[String]) {
    let source = args.first().expect("bench_open pack <source> <out_stem>");
    let stem = args.get(1).expect("bench_open pack <source> <out_stem>");
    let repeat: usize = flag(args, "--repeat").and_then(|n| n.parse().ok()).unwrap_or(1);
    let ext = Path::new(source).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let fmt = if ext == "stp" { "step".to_string() } else { ext };
    let root = fresh_dir("pack");
    // The import FEATURE reads blobs from the default root.
    std::env::set_var("FUNDACAD_BLOB_DIR", &root);
    let store = fundacad_geom::import::blobstore::BlobStore::open(&root).expect("a blob store");
    let t = Instant::now();
    let mut feature = fundacad_geom::import::import_geometry(source, &fmt, &store).expect("the import runs");
    emit("import", ms(t.elapsed()), std::fs::metadata(source).map(|m| m.len()).unwrap_or(0), json!({}));
    feature.insert("id".into(), json!("im"));
    feature.insert("type".into(), json!("import"));
    let doc = json!({"version": fundacad_core::schema::DOCUMENT_VERSION, "parameters": {}, "features": [Value::Object(feature)]});
    let doc_text = serde_json::to_string_pretty(&doc).unwrap();

    let mut blobs = BTreeMap::new();
    for e in std::fs::read_dir(&root).unwrap().flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "bbrep") {
            blobs.insert(p.file_stem().unwrap().to_string_lossy().to_string(), p);
        }
    }
    let raw: u64 = blobs.values().map(|p| std::fs::metadata(p).unwrap().len()).sum();
    let biggest = blobs.values().max_by_key(|p| std::fs::metadata(p).unwrap().len()).cloned();
    if let Some(p) = &biggest {
        let data = std::fs::read(p).unwrap();
        for level in [1, 6] {
            let (took, n) = deflate_alone(&data, level);
            emit(&format!("deflate_l{level}"), took, data.len() as u64, json!({"ratio": n as f64 / data.len() as f64}));
        }
        let t = Instant::now();
        let _ = container::hash_bytes(&data);
        emit("blake2b", ms(t.elapsed()), data.len() as u64, json!({}));
    }
    for ext in ["fundab", "funda"] {
        let dest = PathBuf::from(format!("{stem}.{ext}"));
        let (took, ()) = median_of(repeat, || {
            let t = Instant::now();
            container::write_document(&dest, &doc_text, &blobs, &BTreeMap::new(), &[], "bench").expect("the save");
            (t.elapsed(), ())
        });
        let size = std::fs::metadata(&dest).unwrap().len();
        emit(&format!("save_{ext}"), took, raw, json!({"file_bytes": size, "blobs": blobs.len()}));
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// Read the document into `blob_dir`, timing the file layer stages apart.
fn file_layer(path: &Path, blob_dir: &Path, repeat: usize, refill: bool) -> String {
    let size = std::fs::metadata(path).unwrap().len();
    let binary = fnda::looks_like_fnda(path);
    let (took, _) = median_of(repeat, || {
        let t = Instant::now();
        let b = std::fs::read(path).unwrap();
        (t.elapsed(), b.len())
    });
    emit("read_whole_file", took, size, json!({}));
    if binary {
        let (took, _) = median_of(repeat, || {
            let t = Instant::now();
            let r = fnda::verify(path).expect("the file verifies");
            (t.elapsed(), r)
        });
        emit("verify_no_write", took, size, json!({}));
        let (took, cbor) = median_of(repeat, || {
            let t = Instant::now();
            let c = fnda::read_section_of_kind(path, fnda::KIND_DOCUMENT).unwrap().unwrap();
            (t.elapsed(), c)
        });
        emit("document_section", took, cbor.len() as u64, json!({}));
        let (took, _) = median_of(repeat, || {
            let t = Instant::now();
            let j = fnda::cbor_to_json(&cbor).unwrap();
            (t.elapsed(), j.len())
        });
        emit("cbor_to_json", took, cbor.len() as u64, json!({}));
    }
    let (took, doc) = median_of(repeat, || {
        if refill {
            let _ = std::fs::remove_dir_all(blob_dir);
        }
        let t = Instant::now();
        let opened = container::open_document_full(path, blob_dir, None, None).expect("the open");
        (t.elapsed(), opened.document)
    });
    emit(
        if refill { "open_file_empty_store" } else { "open_file_filled_store" },
        took,
        size,
        json!({"stored": dir_bytes(blob_dir)}),
    );
    let (took, _) = median_of(repeat, || {
        let t = Instant::now();
        let v: Value = serde_json::from_str(&doc).unwrap();
        (t.elapsed(), v)
    });
    emit("document_json_parse", took, doc.len() as u64, json!({}));
    doc
}

fn stage_open(args: &[String], refill: bool) {
    let path = PathBuf::from(args.first().expect("bench_open open <file>"));
    let repeat: usize = flag(args, "--repeat").and_then(|n| n.parse().ok()).unwrap_or(3);
    let blob_dir = fresh_dir("blobs");
    let cache = fresh_dir("cache");
    std::env::set_var("FUNDACAD_BLOB_DIR", &blob_dir);
    std::env::set_var("XDG_CACHE_HOME", &cache);
    if !refill {
        container::open_document_full(&path, &blob_dir, None, None).expect("the first open");
    }
    let doc_text = file_layer(&path, &blob_dir, repeat, refill);
    if args.iter().any(|a| a == "--file-only") {
        let _ = std::fs::remove_dir_all(&blob_dir);
        let _ = std::fs::remove_dir_all(&cache);
        return;
    }
    let doc: Value = serde_json::from_str(&doc_text).unwrap();
    let typed: fundacad_core::CadDocument = serde_json::from_value(doc.clone()).expect("the document types");

    let store = fundacad_geom::import::blobstore::BlobStore::open(&blob_dir).unwrap();
    let mut blob_ms = 0.0;
    let mut shape_ms = 0.0;
    let mut blob_bytes = 0u64;
    for e in std::fs::read_dir(&blob_dir).unwrap().flatten() {
        let p = e.path();
        let Some(digest) = p.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
        let t = Instant::now();
        let Some(bytes) = store.get_bytes(&digest) else { continue };
        blob_ms += ms(t.elapsed());
        blob_bytes += bytes.len() as u64;
        let t = Instant::now();
        let _ = fundacad_geom::features::import::blob_to_shape(&bytes);
        shape_ms += ms(t.elapsed());
    }
    emit("engine_blob_get_bytes", blob_ms, blob_bytes, json!({}));
    emit("engine_blob_to_shape", shape_ms, blob_bytes, json!({}));

    let t = Instant::now();
    let built = builder::rebuild(&typed, &doc, &NoWatch).ok().expect("not cancelled");
    emit("engine_rebuild_cold", ms(t.elapsed()), 0, json!({"bodies": built.bodies.len()}));
    let t = Instant::now();
    let meshed = reply::mesh_result(&built.bodies, 0.1, &Map::new(), &NoWatch);
    let mut tris = 0usize;
    if let fundacad_protocol::JobResult::Mesh(m) = &meshed {
        for b in &m.bodies {
            if let fundacad_protocol::WireBody::Full(f) = b {
                tris += f.indices.len() / 3;
            }
        }
    }
    emit("engine_mesh", ms(t.elapsed()), 0, json!({"triangles": tris}));
    let _ = std::fs::remove_dir_all(&blob_dir);
    let _ = std::fs::remove_dir_all(&cache);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(n) = flag(&args, "--threads") {
        std::env::set_var("FUNDACAD_THREADS", n);
    }
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("scan") => stage_scan(rest),
        Some("pack") => stage_pack(rest),
        Some("open") => stage_open(rest, true),
        Some("reopen") => stage_open(rest, false),
        _ => {
            eprintln!("bench_open scan|pack|open|reopen, see the header of crates/fundacad-cli/examples/bench_open.rs")
        }
    }
}
