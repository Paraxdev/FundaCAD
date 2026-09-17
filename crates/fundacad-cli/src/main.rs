//! `fundacad-engine`, the Rust engine outside the app.
//!
//! `--ws` serves the engine the way `python sidecar/server.py` does, for a
//! browser, the e2e scripts and the Python protocol suites. `--stdio` is the
//! worker protocol the app speaks to `fundacad --engine`. `rebuild` runs one
//! document through the same jobs, for CI and scripts.

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
                                          rebuild one document; --json prints the whole reply";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--ws") => fundacad_engine::ws::run(GeomJobs),
        Some("--stdio") => fundacad_engine::stdio::run(GeomJobs),
        Some("rebuild") => rebuild(&args[1..]),
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
