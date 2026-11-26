//! Against a real worker: open, a delta edit, a killed worker. Skipped when no `fundacad-engine` binary is found
//! (`FUNDACAD_ENGINE_EXE` or beside the test binary), since building one needs OCCT.

use fundacad_client::{Client, Event, Mesh, Options, WorkerCommand};
use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;

fn next_mesh(rx: &Receiver<Event>, restarts: &mut usize) -> Arc<Mesh> {
    loop {
        match rx.recv_timeout(Duration::from_secs(120)).expect("an event within two minutes") {
            Event::Mesh(m) => return m,
            Event::Failed { message, .. } => panic!("rebuild failed: {message}"),
            Event::WorkerRestarted { .. } => *restarts += 1,
            _ => {}
        }
    }
}

#[test]
fn edits_rebuild_and_a_killed_worker_comes_back() {
    let Ok(cmd) = WorkerCommand::locate() else {
        eprintln!("skipped: no fundacad-engine binary");
        return;
    };
    let plate = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/templates/plate.funda");
    let (client, rx) = Client::spawn(cmd, Options::default()).unwrap();
    assert_eq!(client.open(&plate).unwrap(), 1);
    let mut restarts = 0;
    let first = next_mesh(&rx, &mut restarts);
    assert!(first.timing.full_send);
    assert!(first.triangles() > 0);
    assert!(first.bodies.iter().all(|b| !b.face_owners.is_empty()));

    let (name, value) = {
        let text = fundacad_format::read_document(&plate, &std::env::temp_dir()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        let defs = doc["paramDefs"].as_object().unwrap();
        let (n, d) = defs.iter().find(|(_, d)| d["expr"].as_str().is_some_and(|e| e.parse::<f64>().is_ok())).unwrap();
        (n.clone(), d["value"].as_f64().unwrap())
    };
    assert_eq!(client.set_param(&name, value * 1.1).unwrap(), Some(2));
    let edited = next_mesh(&rx, &mut restarts);
    assert!(!edited.timing.full_send, "a parameter edit goes as a delta");
    assert_eq!(edited.revision, 2);

    client.kill_worker();
    assert_eq!(client.set_param(&name, value).unwrap(), Some(3));
    let again = next_mesh(&rx, &mut restarts);
    assert_eq!(again.revision, 3);
    assert_eq!(restarts, 1);
    assert!(again.timing.full_send, "a new worker holds nothing, so the document goes whole");
    assert_eq!(again.triangles(), first.triangles());
}
