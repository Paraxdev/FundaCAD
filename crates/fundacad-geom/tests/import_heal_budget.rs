//! Healing an imported solid beats the heartbeat, and a solid past its budget is kept as the file has
//! it. A file of its own, since the budget is process wide.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use fundacad_geom::heartbeat;
use fundacad_geom::import::{self, blobstore::BlobStore};
use serde_json::{json, Map, Value};

fn imported(name: &str) -> (Map<String, Value>, usize) {
    let dir = std::env::temp_dir().join(format!("fundacad-import-heal-budget-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = BlobStore::open(&dir).unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}.step"));
    let beats = Arc::new(AtomicUsize::new(0));
    let counted = beats.clone();
    let _beat = heartbeat::install(Some(Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    })));
    let reply = import::import_geometry(&path.to_string_lossy(), "step", &store).unwrap();
    (reply, beats.load(Ordering::SeqCst))
}

fn said(reply: &Map<String, Value>) -> Vec<String> {
    reply
        .get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect()
}

#[test]
fn a_heal_past_its_budget_keeps_the_solid_as_read_and_a_heal_beats_while_it_works() {
    opencascade::xcaf::set_heal_budget(0.0);
    let (late, beats_late) = imported("heal_edge_off");
    let notes = said(&late);
    assert_eq!(late["solid"], json!(true), "{notes:?}");
    let note =
        notes.iter().find(|n| n.contains("1 edge is drawn up to 3 mm away")).unwrap_or_else(|| panic!("{notes:?}"));
    assert!(note.contains("not redrawn because redrawing them took too long"), "{note}");

    opencascade::xcaf::set_heal_budget(10.0);
    let (healed, beats_healed) = imported("heal_edge_off");
    let notes = said(&healed);
    assert!(notes.iter().any(|n| n.contains("was redrawn where they meet")), "{notes:?}");
    // The late heal stopped at its first poll, everything after it is the heal polling.
    assert!(beats_healed > beats_late + 10, "{beats_healed} beats healed, {beats_late} stopped at once");
}
