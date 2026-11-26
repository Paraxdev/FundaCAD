//! Times a parameter edit to a fresh mesh on real documents.
//!   cargo run -p fundacad-client --release --example roundtrip -- <doc.funda>[:param | #feature.field] ...
//! Per document: the cold open, ten edits one at a time, a 60 Hz drag of 60 edits that does not wait, and a killed
//! worker. `FC_TOL` sets the tolerance, `FC_NO_DISK=1` turns the engine's disk cache off.

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

enum Target {
    Param(String),
    Field(usize, String),
}

impl Target {
    fn set(&self, client: &Client, v: f64) {
        let edited = match self {
            Target::Param(n) => client.set_param(n, v),
            Target::Field(i, f) => {
                let (i, f) = (*i, f.clone());
                client.edit(move |d| {
                    let feature = d.get_mut("features").and_then(|fs| fs.get_mut(i)).ok_or("no such feature")?;
                    feature[f.as_str()] = serde_json::json!(v);
                    Ok(())
                })
            }
        };
        edited.expect("the edit applies");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    for arg in args {
        let (path, forced) = if let Some((p, t)) = arg.split_once('#') {
            let (i, f) = t.split_once('.').expect("#index.field");
            (p.to_owned(), Some(Target::Field(i.parse().expect("a feature index"), f.to_owned())))
        } else {
            match arg.rsplit_once(':').filter(|(p, _)| p.len() > 2) {
                Some((p, name)) => (p.to_owned(), Some(Target::Param(name.to_owned()))),
                None => (arg.clone(), None),
            }
        };
        if let Err(e) = run(Path::new(&path), forced) {
            println!("{path}: {e}");
        }
    }
}

fn run(path: &Path, forced: Option<Target>) -> Result<(), String> {
    let mut cmd = WorkerCommand::locate().map_err(|e| e.to_string())?;
    if std::env::var("FC_NO_DISK").is_ok_and(|v| v == "1") {
        cmd = cmd.env("FUNDACAD_DISK_CACHE", "0");
    }
    let tolerance = std::env::var("FC_TOL").ok().and_then(|t| t.parse().ok()).unwrap_or(0.1);
    let (client, rx) = Client::spawn(cmd, Options { tolerance, ..Options::default() }).map_err(|e| e.to_string())?;
    let text = fundacad_format::read_document(path, &std::env::temp_dir()).map_err(|e| e.to_string())?;
    let doc: serde_json::Map<String, Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let (target, label, base) = match forced {
        Some(Target::Param(n)) => {
            let v = doc["paramDefs"][&n]["value"].as_f64().ok_or(format!("no parameter {n}"))?;
            (Target::Param(n.clone()), n, v)
        }
        Some(Target::Field(i, f)) => {
            let v = doc["features"][i][&f].as_f64().ok_or(format!("feature {i} has no number in {f}"))?;
            let label = format!("{}.{f}", doc["features"][i]["id"].as_str().unwrap_or("?"));
            (Target::Field(i, f), label, v)
        }
        None => {
            let (n, v) = pick_param(&doc).ok_or("no plain parameter to edit")?;
            (Target::Param(n.clone()), n, v)
        }
    };
    let t = Instant::now();
    client.load(doc)?;
    let cold = next_mesh(&rx)?;
    println!(
        "{}: cold open {:.0} ms, {} bodies, {} tris; editing {label} from {base}",
        path.display(),
        ms(t.elapsed()),
        cold.bodies.len(),
        cold.triangles()
    );

    let mut each = Vec::new();
    let mut engine = Vec::new();
    let mut rev = cold.revision;
    for k in 1..=10 {
        target.set(&client, base * (1.0 + 0.002 * k as f64));
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
        target.set(&client, base * (1.0 - 0.002 * (k % 10) as f64));
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
    target.set(&client, base);
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
