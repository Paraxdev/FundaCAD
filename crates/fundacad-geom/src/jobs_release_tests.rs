use fundacad_engine::Jobs;
use serde_json::json;

use super::GeomJobs;
use crate::inspect::{inspect_bodies, locals_held, InspectBody};
use crate::kernel;

fn slanted_box(at: [f64; 3], size: [f64; 3]) -> opencascade::primitives::Shape {
    let b = kernel::make_box(size[0], size[1], size[2]).unwrap();
    kernel::translated(&b, at).unwrap()
}

fn fill(shapes: &[&opencascade::primitives::Shape]) {
    for s in shapes {
        kernel::bbox_diagonal(s);
        kernel::describe(s);
        crate::features::resize::memo::volume(s);
    }
    let bodies: Vec<InspectBody<'_>> = shapes
        .iter()
        .enumerate()
        .map(|(i, s)| InspectBody { id: json!(format!("body{}", i + 1)), name: json!(null), shape: Some(*s) })
        .collect();
    inspect_bodies(&bodies, false, 10, 10).unwrap();
}

// Another test's rebuild can hold the shared rebuild cache for a moment.
fn release_soon() {
    let t0 = std::time::Instant::now();
    while !GeomJobs.release() {
        assert!(t0.elapsed() < std::time::Duration::from_secs(10), "the rebuild cache stayed held");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn held(shapes: &[&opencascade::primitives::Shape]) -> (usize, usize, usize) {
    (kernel::remembered_held(), crate::features::resize::memo::held(), locals_held(shapes))
}

#[test]
fn release_drops_the_inspect_kernel_and_resize_memos_of_every_shape() {
    let a = slanted_box([17.5, -42.0, 8.25], [12.0, 7.5, 3.0]);
    let b = slanted_box([-63.0, 21.0, -5.5], [4.0, 9.0, 11.5]);
    fill(&[&a, &b]);
    assert_eq!(held(&[&a, &b]), (4, 2, 2));
    release_soon();
    assert_eq!(held(&[&a, &b]), (0, 0, 0));
}

#[test]
fn a_release_blocked_by_a_held_rebuild_cache_still_drops_the_memos_and_is_asked_again() {
    let a = slanted_box([31.0, 6.5, -14.0], [5.0, 2.5, 8.0]);
    fill(&[&a]);
    assert_eq!(held(&[&a]), (2, 1, 1));
    let guard = crate::cache::global().lock().unwrap_or_else(|p| p.into_inner());
    assert!(!GeomJobs.release());
    drop(guard);
    assert_eq!(held(&[&a]), (0, 0, 0));
    fill(&[&a]);
    release_soon();
    assert_eq!(held(&[&a]), (0, 0, 0));
}
