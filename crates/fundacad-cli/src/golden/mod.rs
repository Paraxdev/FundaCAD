//! `golden-check`: the Rust engine against the Python engine's frozen answers.
//!
//! tests/golden/*.golden.json hold what sidecar/tools/freeze_goldens.py recorded
//! from the Python engine, reduced to what each differential tool compared. Each
//! kind here rebuilds the corpus on this engine, in process, and compares with
//! that tool's rules and tolerances, which the golden's header restates.

mod coverage;
mod evals;
mod kdtree;
mod meshes;
mod plugin_ops;
mod rebuild;

use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use fundacad_engine::{Engine, Outbox};
use fundacad_geom::jobs::GeomJobs;
use fundacad_protocol::Message;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub fn run(args: &[String]) -> ExitCode {
    let mut golden_path = None;
    let mut corpus_path = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--corpus" => corpus_path = it.next().cloned(),
            other if golden_path.is_none() && !other.starts_with("--") => {
                golden_path = Some(other.to_string());
            }
            other => {
                eprintln!("fundacad-engine: unexpected argument {other}");
                return ExitCode::from(2);
            }
        }
    }
    let Some(golden_path) = golden_path else {
        eprintln!("fundacad-engine: golden-check needs a golden file");
        return ExitCode::from(2);
    };
    match check(
        Path::new(&golden_path),
        corpus_path.as_deref().map(Path::new),
    ) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("fundacad-engine: golden-check {golden_path}: {e}");
            ExitCode::from(2)
        }
    }
}

/// The golden file, its corpus and the scratch space one check needs.
pub struct Ctx {
    pub golden: Value,
    pub corpus: Value,
    pub repo: PathBuf,
    pub work: PathBuf,
}

impl Ctx {
    pub fn header(&self) -> &Value {
        &self.golden["golden"]
    }

    pub fn cases(&self) -> &Value {
        &self.golden["cases"]
    }

    pub fn tol(&self, key: &str) -> f64 {
        self.header()["tolerances"][key]
            .as_f64()
            .unwrap_or_else(|| panic!("the golden header has no tolerances.{key}"))
    }

    /// The machine's own paths in a text, as freeze_goldens.normalise writes them.
    pub fn normalise(&self, text: &str) -> String {
        normalise(
            text,
            &[
                (self.work.to_string_lossy().into_owned(), "$WORK"),
                (self.repo.to_string_lossy().into_owned(), "$REPO"),
            ],
        )
    }

    pub fn normalise_all(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.normalise(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.normalise_all(x)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, x)| (k.clone(), self.normalise_all(x)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

fn check(golden_path: &Path, corpus_path: Option<&Path>) -> Result<bool, String> {
    let golden = read_json(golden_path)?;
    let header = golden["golden"].clone();
    let kind = header["kind"].as_str().ok_or("the golden has no kind")?;
    let repo = repo_root(golden_path)?;
    let corpus = match kind {
        "coverage" => Value::Null,
        _ => {
            let path = match corpus_path {
                Some(p) => p.to_path_buf(),
                None => repo.join(
                    header["corpus"]
                        .as_str()
                        .ok_or("the golden names no corpus")?,
                ),
            };
            let bytes =
                std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let want = header["corpusSha256"].as_str().unwrap_or("");
            let got = sha256_hex(&fold_crlf(&bytes));
            if got != want {
                return Err(format!(
                    "{} is not the corpus this golden was frozen from (sha256 {got}, the golden says {want})",
                    path.display()
                ));
            }
            if kind == "mcp" {
                Value::Null
            } else {
                serde_json::from_slice(&bytes)
                    .map_err(|e| format!("{} is not JSON: {e}", path.display()))?
            }
        }
    };
    let work = std::env::temp_dir().join(format!("fundacad-golden-{}", std::process::id()));
    std::fs::create_dir_all(work.join("blobs"))
        .map_err(|e| format!("cannot create {}: {e}", work.display()))?;
    // What harness_util.SpawnedServer gave every engine the diff tools drove: no
    // geometry persisted from an earlier run, so a warm disk cache cannot answer.
    std::env::set_var("FUNDACAD_DISK_CACHE", "0");
    if std::env::var_os("FUNDACAD_BLOB_DIR").is_none() {
        std::env::set_var("FUNDACAD_BLOB_DIR", work.join("blobs"));
    }
    let work = std::fs::canonicalize(&work)
        .map(strip_verbatim)
        .unwrap_or(work);
    let ctx = Ctx {
        golden,
        corpus,
        repo,
        work: work.clone(),
    };
    let reference = &ctx.header()["reference"];
    println!(
        "golden {} ({kind}), frozen from the python engine: build123d {}, OCP {}, sidecar {}\n",
        golden_path.display(),
        reference["build123d"].as_str().unwrap_or("?"),
        reference["ocp"].as_str().unwrap_or("?"),
        reference["sidecarCommit"].as_str().unwrap_or("?"),
    );
    let result = match kind {
        "rebuild" => rebuild::check(&ctx),
        "plugin-ops" => plugin_ops::check(&ctx),
        "meshes" => meshes::check(&ctx),
        "fillet" => evals::fillet(&ctx),
        "selectors" => evals::selectors(&ctx),
        "coverage" => coverage::check(&ctx),
        "mcp" => Err(
            "the MCP transcript is checked by crates/fundacad-mcp/tests/parity_golden.rs".into(),
        ),
        other => Err(format!("no checker for a golden of kind {other}")),
    };
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// The directory above the golden that holds the workspace, which every path in
/// a golden is relative to.
fn repo_root(golden: &Path) -> Result<PathBuf, String> {
    let abs = std::fs::canonicalize(golden)
        .map(strip_verbatim)
        .map_err(|e| format!("cannot find {}: {e}", golden.display()))?;
    abs.ancestors()
        .find(|d| d.join("Cargo.toml").is_file() && d.join("tests").join("golden").is_dir())
        .map(Path::to_path_buf)
        .ok_or_else(|| "no repository above the golden file".into())
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_slice(&text).map_err(|e| format!("{} is not JSON: {e}", path.display()))
}

pub fn fold_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// freeze_goldens.normalise: each root in its plain, forward slash, backslash and
/// doubled backslash spellings, longest first, then the separators of the path
/// that follows a placeholder written as /.
pub fn normalise(text: &str, roots: &[(String, &str)]) -> String {
    let mut text = text.to_owned();
    for (real, token) in roots {
        let back = real.replace('/', "\\");
        let mut forms = vec![
            back.replace('\\', "\\\\"),
            real.clone(),
            real.replace('\\', "/"),
            back,
        ];
        forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
        forms.dedup();
        for form in forms {
            if !form.is_empty() {
                text = text.replace(&form, token);
            }
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(at) = ["$WORK", "$REPO"]
        .iter()
        .filter_map(|t| rest.find(t).map(|i| (i, t.len())))
        .min()
    {
        let (i, n) = at;
        out.push_str(&rest[..i + n]);
        rest = &rest[i + n..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(rest.len());
        let mut path = String::new();
        let mut in_run = false;
        for c in rest[..end].chars() {
            if c == '\\' {
                if !in_run {
                    path.push('/');
                }
                in_run = true;
            } else {
                in_run = false;
                path.push(c);
            }
        }
        out.push_str(&path);
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// harness_util.error_class: every number masked as #, whitespace collapsed.
pub fn error_class(message: &str) -> String {
    let b: Vec<char> = message.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let digit = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_digit());
    while i < b.len() {
        let start_neg = b[i] == '-' && digit(b.get(i + 1));
        if start_neg || b[i].is_ascii_digit() {
            let mut j = i + usize::from(start_neg);
            while digit(b.get(j)) {
                j += 1;
            }
            if b.get(j) == Some(&'.') {
                j += 1;
                while digit(b.get(j)) {
                    j += 1;
                }
            }
            if matches!(b.get(j), Some('e' | 'E')) {
                let mut k = j + 1;
                if matches!(b.get(k), Some('+' | '-')) {
                    k += 1;
                }
                if digit(b.get(k)) {
                    while digit(b.get(k)) {
                        k += 1;
                    }
                    j = k;
                }
            }
            out.push('#');
            i = j;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// harness_util.mesh_volume, the absolute signed tetra sum.
pub fn mesh_volume(positions: &[f64], indices: &[usize]) -> f64 {
    let p = positions;
    let mut total = 0.0;
    for t in indices.chunks_exact(3) {
        let (a, b, c) = (t[0] * 3, t[1] * 3, t[2] * 3);
        let (ax, ay, az) = (p[a], p[a + 1], p[a + 2]);
        let (bx, by, bz) = (p[b], p[b + 1], p[b + 2]);
        let (cx, cy, cz) = (p[c], p[c + 1], p[c + 2]);
        total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    total.abs() / 6.0
}

pub fn floats(v: &Value) -> Vec<f64> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
        .unwrap_or_default()
}

pub fn indices(v: &Value) -> Vec<usize> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0) as usize).collect())
        .unwrap_or_default()
}

pub fn body_volume(b: &Value) -> f64 {
    let (p, i) = (floats(&b["positions"]), indices(&b["indices"]));
    if p.is_empty() || i.is_empty() {
        0.0
    } else {
        mesh_volume(&p, &i)
    }
}

/// An IVEC field (freeze_goldens.ivec) back to its integers.
pub fn ivec(text: &Value) -> Result<Vec<i64>, String> {
    let text = text.as_str().unwrap_or("");
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let packed = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| format!("an IVEC field is not base64: {e}"))?;
    let mut raw = Vec::new();
    io::Read::read_to_end(&mut flate2::read::ZlibDecoder::new(&packed[..]), &mut raw)
        .map_err(|e| format!("an IVEC field is not zlib: {e}"))?;
    let mut out = Vec::new();
    let (mut v, mut shift, mut acc) = (0u64, 0u32, 0i64);
    for byte in raw {
        v |= u64::from(byte & 0x7F) << shift;
        shift += 7;
        if byte < 0x80 {
            let d = ((v >> 1) as i64) ^ -((v & 1) as i64);
            acc += d;
            out.push(acc);
            v = 0;
            shift = 0;
        }
    }
    Ok(out)
}

/// An (n, 3) IVEC array stored column by column, as rows scaled by `quantum`.
pub fn ivec_rows(text: &Value, quantum: f64) -> Result<Vec<[f64; 3]>, String> {
    let flat = ivec(text)?;
    let n = flat.len() / 3;
    Ok((0..n)
        .map(|i| {
            [
                flat[i] as f64 * quantum,
                flat[n + i] as f64 * quantum,
                flat[2 * n + i] as f64 * quantum,
            ]
        })
        .collect())
}

pub fn table(rows: &[Vec<String>], headers: &[&str]) {
    let widths: Vec<usize> = (0..headers.len())
        .map(|i| {
            rows.iter()
                .map(|r| r[i].chars().count())
                .chain([headers[i].len()])
                .max()
                .unwrap_or(0)
        })
        .collect();
    let line = |r: &[String]| {
        r.iter()
            .zip(&widths)
            .map(|(c, w)| format!("{c:<w$}"))
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_owned()
    };
    println!(
        "{}",
        line(&headers.iter().map(|h| h.to_string()).collect::<Vec<_>>())
    );
    println!(
        "{}",
        line(&widths.iter().map(|w| "-".repeat(*w)).collect::<Vec<_>>())
    );
    for r in rows {
        println!("{}", line(r));
    }
}

/// A texture's relative imagePath made absolute against the repository root,
/// as diff_engines.absolute_image_paths does.
pub fn absolute_image_paths(doc: &mut Value, repo: &Path) {
    for f in doc["features"].as_array_mut().into_iter().flatten() {
        if let Some(p) = f.get("imagePath").and_then(Value::as_str) {
            if !p.is_empty() && !p.starts_with('/') && !Path::new(p).is_absolute() {
                let abs = p
                    .split('/')
                    .fold(repo.to_path_buf(), |acc, part| acc.join(part));
                f["imagePath"] = Value::String(abs.to_string_lossy().into_owned());
            }
        }
    }
}

struct Channel(Mutex<Sender<Message>>);

impl Outbox for Channel {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        let tx = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for m in msgs {
            tx.send(m)
                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        }
        Ok(())
    }
}

/// One engine, spoken to with the WebSocket protocol's JSON requests, the way a
/// diff tool's spawned `fundacad-engine --ws` was, only in process.
pub struct Session {
    engine: Engine,
    rx: Receiver<Message>,
    next: u64,
}

impl Session {
    pub fn start() -> Session {
        let (tx, rx) = channel();
        let engine = Engine::start(GeomJobs, Arc::new(Channel(Mutex::new(tx))));
        Session {
            engine,
            rx,
            next: 0,
        }
    }

    /// The reply to one op, interim frames skipped as harness_util.ws_call does.
    pub fn call(&mut self, op: &str, fields: Value) -> Value {
        self.next += 1;
        let id = format!("golden{}", self.next);
        let mut req = match fields {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        req.insert("id".into(), json!(id));
        req.insert("op".into(), json!(op));
        self.engine
            .handle(Message::Text(Value::Object(req).to_string()));
        loop {
            let Ok(msg) = self.rx.recv() else {
                return json!({"ok": false, "error": {"message": "the engine stopped without a reply"}});
            };
            let Message::Text(t) = msg else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&t) else {
                continue;
            };
            if v.get("id") == Some(&json!(id)) && v.get("ok").is_some() {
                return v;
            }
        }
    }
}

/// Python's `f"{x:.{n}f}"`.
pub fn fx(x: f64, n: usize) -> String {
    format!("{x:.n$}")
}

pub fn verdict(bad: usize, total: usize) -> bool {
    println!("\n{} match, {bad} mismatch", total - bad);
    bad == 0
}
