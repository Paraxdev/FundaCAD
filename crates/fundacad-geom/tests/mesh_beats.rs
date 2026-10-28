//! Meshing one body is one long call on the job's thread, so it beats as it goes or the engine reaps a body of
//! tens of thousands of faces as stalled.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use fundacad_geom::heartbeat;
use fundacad_geom::mesh::{self, viewport_profile};
use opencascade::primitives::Shape;

#[test]
fn meshing_one_body_beats_for_each_of_its_faces() {
    let beats = Arc::new(AtomicUsize::new(0));
    let counted = beats.clone();
    let _beat = heartbeat::install(Some(Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    })));
    let cube = Shape::box_with_dimensions(10.0, 20.0, 30.0);
    let _ = mesh::body_payload(&cube, "b", "B", 0.1, viewport_profile(1));
    let n = beats.load(Ordering::SeqCst);
    assert!(n >= 6, "{n} beats for 6 faces");
}
