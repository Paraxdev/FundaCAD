//! `fundacad-engine`, the Rust engine outside the app.
//!
//! `--ws` serves the engine the way `python sidecar/server.py` does, for a
//! browser, the e2e scripts and the Python protocol suites. `--stdio` is the
//! worker protocol the app speaks to `fundacad --engine`. `rebuild` runs one
//! document through the same jobs, for CI and scripts. `doc-json` reads any
//! saved document, .funda or .fundab, and prints its JSON. `golden-check`
//! holds this engine to the Python engine's answers frozen in tests/golden.

mod golden;

use fundacad_engine::{Engine, Outbox};
use fundacad_geom::jobs::GeomJobs;
use fundacad_protocol::Message;
use serde_json::{json, Value};
use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

const USAGE: &str = "usage:
  fundacad-engine --ws                    serve over WebSocket on 127.0.0.1 (FUNDACAD_SIDECAR_PORT, default 8765)
  fundacad-engine --stdio                 serve the worker protocol on stdin and stdout
  fundacad-engine rebuild <doc.json> [--json] [--tolerance <t>]
                                          rebuild one document; --json prints the whole reply
  fundacad-engine doc-json <file> [--blob-dir <dir>]
                                          print a saved document's JSON (.funda, JSON or
                                          container, or .fundab), publishing its embedded
                                          geometry into --blob-dir (default FUNDACAD_BLOB_DIR)
  fundacad-engine select-eval <corpus.json> [--config <tuning.json>]
                                          score selector survival on a frozen corpus, as
                                          sidecar/tools/eval_selector_survival.py does
  fundacad-engine fillet-eval <corpus.json> [--show-ids]
                                          score a fillet and chamfer corpus, as
                                          sidecar/tools/eval_fillet_corpus.py does
  fundacad-engine golden-check <golden.json> [--corpus <corpus.json>] [--record <names>]
                                          compare this engine with the Python engine's
                                          frozen answers in tests/golden, exit 1 on any
                                          mismatch; --record writes this engine's answer
                                          for the named cases first, after a human check";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // server.py's startup `plugin_geometry.discover()`: the engine reads the
    // installed plugins' manifests, an eval or a library user has none.
    fundacad_geom::plugins::load();
    match args.first().map(String::as_str) {
        Some("--ws") => fundacad_engine::ws::run(GeomJobs),
        Some("--stdio") => fundacad_engine::stdio::run(GeomJobs),
        Some("rebuild") => rebuild(&args[1..]),
        Some("doc-json") => doc_json(&args[1..]),
        Some("select-eval") => select_eval(&args[1..]),
        Some("fillet-eval") => fillet_eval(&args[1..]),
        Some("golden-check") => golden::run(&args[1..]),
        Some("-h" | "--help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
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

/// Exit 0 when the reply is ok, 1 when the engine refused the document, 2 when
/// the command itself could not run.
fn rebuild(args: &[String]) -> ExitCode {
    let mut path = None;
    let mut as_json = false;
    let mut tolerance = 0.1;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => as_json = true,
            "--tolerance" => match it.next().and_then(|t| t.parse::<f64>().ok()) {
                Some(t) => tolerance = t,
                None => return usage("--tolerance needs a number"),
            },
            other if path.is_none() && !other.starts_with("--") => path = Some(other.to_string()),
            other => return usage(&format!("unexpected argument {other}")),
        }
    }
    let Some(path) = path else {
        return usage("rebuild needs a document path");
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return fail(&format!("cannot read {path}: {e}")),
    };
    let mut doc: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return fail(&format!("{path} is not JSON: {e}")),
    };
    // A saved request, `{"document": ...}`, is accepted as well as a bare document.
    if let Some(inner) = doc.get("document").filter(|d| d.is_object()) {
        doc = inner.clone();
    }

    let mut out = match fundacad_engine::stdio::take_stdout() {
        Ok(f) => io::BufWriter::new(f),
        Err(e) => return fail(&format!("cannot take stdout: {e}")),
    };
    let (tx, rx) = channel();
    let engine = Engine::start(GeomJobs, Arc::new(Channel(Mutex::new(tx))));
    let request = json!({"id": 1, "op": "rebuild", "tolerance": tolerance, "document": doc});
    engine.handle(Message::Text(request.to_string()));

    let reply = loop {
        let Ok(msg) = rx.recv() else {
            return fail("the engine stopped without a reply");
        };
        let Message::Text(t) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&t) else {
            continue;
        };
        if v.get("ok").is_some() {
            break v;
        }
    };

    let phases = fundacad_geom::bench::report();
    if phases.as_object().is_some_and(|m| !m.is_empty()) {
        eprintln!("phases: {phases}");
    }

    let ok = reply["ok"] == true;
    let written = if as_json {
        writeln!(out, "{reply}")
    } else {
        writeln!(out, "{}", summary(&reply))
    };
    if written.and_then(|_| out.flush()).is_err() {
        return ExitCode::from(2);
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

/// Exit 0 with the document on stdout, 1 when the file cannot be read as a
/// document, 2 on a usage error.
fn doc_json(args: &[String]) -> ExitCode {
    let mut path = None;
    let mut blob_dir = std::env::var_os("FUNDACAD_BLOB_DIR").map(std::path::PathBuf::from);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--blob-dir" => match it.next() {
                Some(d) => blob_dir = Some(d.into()),
                None => return usage("--blob-dir needs a directory"),
            },
            other if path.is_none() && !other.starts_with("--") => path = Some(other.to_string()),
            other => return usage(&format!("unexpected argument {other}")),
        }
    }
    let Some(path) = path else {
        return usage("doc-json needs a document path");
    };
    let Some(blob_dir) = blob_dir else {
        return usage("doc-json needs --blob-dir or FUNDACAD_BLOB_DIR for the document's geometry");
    };
    if let Err(e) = std::fs::create_dir_all(&blob_dir) {
        return fail(&format!("cannot create {}: {e}", blob_dir.display()));
    }
    match fundacad_format::read_document(std::path::Path::new(&path), &blob_dir) {
        Ok(doc) => {
            let mut out = io::stdout().lock();
            if writeln!(out, "{doc}").and_then(|_| out.flush()).is_err() {
                return ExitCode::from(2);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("fundacad-engine: {path}: {e}");
            ExitCode::from(1)
        }
    }
}

fn summary(reply: &Value) -> String {
    if reply["ok"] != true {
        return format!(
            "error: {}",
            reply["error"]["message"].as_str().unwrap_or("unknown")
        );
    }
    let res = &reply["result"];
    let bodies = res["bodies"].as_array().map_or(0, Vec::len);
    let mut lines = vec![format!("ok: {bodies} bodies, bbox {}", res["bbox"])];
    for e in res["featureErrors"].as_array().into_iter().flatten() {
        lines.push(format!(
            "feature {}: {}",
            e["feature_id"].as_str().unwrap_or("?"),
            e["message"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}

fn usage(msg: &str) -> ExitCode {
    eprintln!("{msg}\n{USAGE}");
    ExitCode::from(2)
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("fundacad-engine: {msg}");
    ExitCode::from(2)
}

fn read_json(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{path} is not JSON: {e}"))
}

/// sidecar/tools/eval_selector_survival.py on this engine: one JSON line of
/// metrics last on stdout, everything else on stderr, exit 2 on a setup failure.
/// --config overrides the shipped tuning key by key, as `configure` does after
/// geom_select.py loaded selector_tuning.json at import.
fn select_eval(args: &[String]) -> ExitCode {
    use fundacad_geom::select::{eval, Tuning};
    let mut corpus_path = None;
    let mut tuning = *Tuning::shipped();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--corpus" => corpus_path = it.next().cloned(),
            "--config" => {
                let Some(path) = it.next() else {
                    return usage("--config needs a path");
                };
                match read_json(path) {
                    Ok(v) => tuning.configure(&v),
                    Err(e) => return fail(&format!("setup failure: {e}")),
                }
            }
            other if corpus_path.is_none() && !other.starts_with("--") => {
                corpus_path = Some(other.to_string());
            }
            other => return usage(&format!("unexpected argument {other}")),
        }
    }
    let Some(corpus_path) = corpus_path else {
        return usage("select-eval needs a corpus path");
    };
    let corpus = match read_json(&corpus_path) {
        Ok(v) => v,
        Err(e) => return fail(&format!("setup failure: {e}")),
    };
    if corpus["cases"].as_array().is_none_or(Vec::is_empty) {
        return fail("empty corpus");
    }
    let (mut metrics, counts) = eval::run(&corpus, &tuning, |line| eprintln!("{line}"));
    let tests_pass = match eval::selector_v2_checks(&tuning) {
        Ok(()) => 1.0,
        Err(e) => {
            eprintln!("  selector v2 checks FAILED: {e}");
            0.0
        }
    };
    metrics.insert("tests_pass".into(), json!(tests_pass));
    let survived: usize = counts.iter().map(|c| c.1).sum();
    let valid: usize = counts.iter().map(|c| c.2).sum();
    let per: Vec<String> = counts
        .iter()
        .map(|(c, s, v)| format!("{c}: ({s}, {v})"))
        .collect();
    eprintln!(
        "survive={survived}/{valid} per-category={{{}}}",
        per.join(", ")
    );
    println!("{}", Value::Object(metrics));
    ExitCode::SUCCESS
}

/// sidecar/tools/eval_fillet_corpus.py on this engine, the same report and last line.
fn fillet_eval(args: &[String]) -> ExitCode {
    use fundacad_geom::features::blend::eval;
    let mut corpus_path = None;
    let mut show_ids = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--corpus" => corpus_path = it.next().cloned(),
            "--show-ids" => show_ids = true,
            other if corpus_path.is_none() && !other.starts_with("--") => {
                corpus_path = Some(other.to_string());
            }
            other => return usage(&format!("unexpected argument {other}")),
        }
    }
    let Some(corpus_path) = corpus_path else {
        return usage("fillet-eval needs a corpus path");
    };
    let corpus = match read_json(&corpus_path) {
        Ok(v) => v,
        Err(e) => return fail(&format!("setup failure: {e}")),
    };
    let verbose = std::env::var_os("FILLET_EVAL_VERBOSE").is_some();
    let report = match eval::run(&corpus, |id| {
        if verbose {
            eprintln!("{id}");
        }
    }) {
        Ok(r) => r,
        Err(e) => return fail(&format!("setup failure: {e}")),
    };
    println!("{}", eval::render(&corpus_path, &corpus, &report, show_ids));
    ExitCode::SUCCESS
}
