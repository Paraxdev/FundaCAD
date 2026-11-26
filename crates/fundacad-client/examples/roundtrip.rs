//! Times a parameter edit to a fresh mesh on real documents.
//!   cargo run -p fundacad-client --release --example roundtrip -- <doc.funda>[:param] ...
//! Per document: the cold open, ten edits one at a time, then a 60 Hz drag of 60 edits that does not wait.

use fundacad_client::{Client, Event, Mesh, Options, WorkerCommand};
use serde_json::Value;
use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn next_mesh(rx: &Receiver<Event>) -> Result<Arc<Mesh>, String> {
    loop {
        match rx.recv_timeout(Duration::from_secs(300)).map_err(|e| e.to_string())? {
            Event::Mesh(m) => return Ok(m),
            Event::Failed { message, .. } => return Err(message),
            Event::WorkerRestarted { cause, .. } => eprintln!("worker restarted: {cause}"),
            _ => {}
        }
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn stats(label: &str, mut v: Vec<f64>) {
    v.sort_by(f64::total_cmp);
    let med = v[v.len() / 2];
    println!("  {label}: min {:.1} ms, median {med:.1} ms, max {:.1} ms (n={})", v[0], v[v.len() - 1], v.len());
}

/// The first parameter typed as a plain number that some feature field names, else the first plain number.
fn pick_param(doc: &serde_json::Map<String, Value>) -> Option<(String, f64)> {
    let defs = doc.get("paramDefs")?.as_object()?;
    let features = doc.get("features").map(Value::to_string).unwrap_or_default();
    let plain = || {
        defs.iter().filter_map(|(n, d)| {
            let v = d.get("expr")?.as_str()?.trim().parse::<f64>().ok()?;
            (v != 0.0).then(|| (n.clone(), v))
        })
    };
    plain().find(|(n, _)| features.contains(&format!("\"{n}\""))).or_else(|| plain().next())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    for arg in args {
        let (path, forced) = match arg.rsplit_once(':').filter(|(p, _)| p.len() > 2) {
            Some((p, name)) => (p.to_owned(), Some(name.to_owned())),
            None => (arg.clone(), None),
        };
        if let Err(e) = run(Path::new(&path), forced) {
            println!("{path}: {e}");
        }
    }
}

fn run(path: &Path, forced: Option<String>) -> Result<(), String> {
    let cmd = WorkerCommand::locate().map_err(|e| e.to_string())?;
    let (client, rx) = Client::spawn(cmd, Options::default()).map_err(|e| e.to_string())?;
    let text = fundacad_format::read_document(path, &std::env::temp_dir()).map_err(|e| e.to_string())?;
    let doc: serde_json::Map<String, Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let (param, base) = match forced {
        Some(n) => {
            let v = doc["paramDefs"][&n]["value"].as_f64().ok_or(format!("no parameter {n}"))?;
            (n, v)
        }
        None => pick_param(&doc).ok_or("no plain parameter to edit")?,
    };
    let t = Instant::now();
    client.load(doc);
    let cold = next_mesh(&rx)?;
    println!(
        "{}: cold open {:.0} ms, {} bodies, {} tris; editing {param} from {base}",
        path.display(),
        ms(t.elapsed()),
        cold.bodies.len(),
        cold.triangles()
    );

    let mut each = Vec::new();
    let mut engine = Vec::new();
    let mut rev = cold.revision;
    for k in 1..=10 {
        client.set_param(&param, base * (1.0 + 0.002 * k as f64));
        let m = next_mesh(&rx)?;
        rev = m.revision;
        each.push(ms(m.timing.total));
        engine.push(ms(m.timing.engine));
        if k == 1 {
            println!("  first edit: {m}");
        }
    }
    stats("edit to mesh, one at a time", each);
    stats("of which engine and pipe", engine);

    let tick = Duration::from_micros(16_667);
    let start = Instant::now();
    let mut meshes = Vec::new();
    for k in 0..60 {
        client.set_param(&param, base * (1.0 - 0.002 * (k % 10) as f64));
        let due = start + tick * (k + 1);
        while let Some(left) = due.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(Event::Mesh(m)) => meshes.push(m),
                Ok(Event::Failed { message, .. }) => return Err(message),
                _ => {}
            }
        }
    }
    let last_edit = Instant::now();
    while meshes.last().map_or(true, |m| m.revision < rev + 60) {
        meshes.push(next_mesh(&rx)?);
    }
    let span = start.elapsed();
    println!(
        "  60 Hz drag of 60 edits: {} meshes in {:.0} ms ({:.1} meshes/s), settled {:.0} ms after the last edit",
        meshes.len(),
        ms(span),
        meshes.len() as f64 / span.as_secs_f64(),
        ms(last_edit.elapsed())
    );
    stats("drag edit to mesh", meshes.iter().map(|m| ms(m.timing.total)).collect());

    let t = Instant::now();
    client.kill_worker();
    client.set_param(&param, base);
    loop {
        match rx.recv_timeout(Duration::from_secs(120)).map_err(|e| e.to_string())? {
            Event::Mesh(m) => {
                println!("  after a killed worker: mesh again in {:.0} ms ({})", ms(t.elapsed()), m);
                break;
            }
            Event::WorkerRestarted { cause, .. } => println!("  worker restarted: {cause}"),
            Event::Failed { message, .. } => return Err(message),
            _ => {}
        }
    }
    Ok(())
}
