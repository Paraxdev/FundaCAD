//! `unify_body` may never quietly eat a constituent, and a join of tangent
//! swept tubes has to come out as one merged solid.
//!
//! The volume bracket of shape_util.py `_unify_body` cannot see the failure on
//! its own: when the fuse drops a constituent the result is exactly the largest
//! one, and the largest one is the bracket's floor. Measured on two tangent
//! swept tubes, OCCT 7.8.1 returned the bigger tube alone.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::Value;

fn corpus_doc(name: &str) -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sidecar/tools/corpus_engines.json"
    );
    let corpus: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the corpus")).expect("json");
    corpus["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .find(|d| d["name"] == name)
        .map(|d| d["document"].clone())
        .unwrap_or_else(|| panic!("no corpus document called {name}"))
}

fn covers(outer: [f64; 6], inner: [f64; 6], slack: f64) -> bool {
    (0..3).all(|i| outer[i] <= inner[i] + slack && outer[i + 3] >= inner[i + 3] - slack)
}

/// Overlapping constituents unify into one solid that still reaches everywhere
/// they did, with the union's volume: over the largest of them, under their sum.
#[test]
fn unify_body_keeps_every_overlapping_constituent() {
    let a = Shape::box_with_dimensions(40.0, 20.0, 20.0);
    let b = kernel::translated(
        &Shape::box_with_dimensions(20.0, 40.0, 20.0),
        [15.0, 0.0, 0.0],
    )
    .expect("moved");
    let c = kernel::translated(
        &Shape::box_with_dimensions(20.0, 20.0, 40.0),
        [0.0, 15.0, 0.0],
    )
    .expect("moved");
    let vols = [&a, &b, &c].map(|s| kernel::volume(s).abs());
    let glued = kernel::compound([&a, &b, &c]);
    let out = kernel::unify_body(&glued);

    let after = kernel::volume(&out).abs();
    let biggest = vols.iter().copied().fold(0.0f64, f64::max);
    let sum: f64 = vols.iter().sum();
    assert_eq!(kernel::count(&out, Kind::Solid), 1, "one merged solid");
    assert!(
        after > biggest,
        "{after} is no more than the largest {biggest}"
    );
    assert!(
        after < sum,
        "{after} counts the overlap twice, sum is {sum}"
    );
    assert!(
        covers(
            kernel::bbox(&out).expect("a box"),
            kernel::bbox(&glued).expect("a box"),
            1e-6,
        ),
        "the union stopped reaching where its constituents did"
    );
}

/// Disjoint constituents have nothing to merge, and neither the fuse nor the
/// debris drop may take one away.
#[test]
fn unify_body_keeps_constituents_that_never_meet() {
    let a = Shape::box_with_dimensions(20.0, 20.0, 20.0);
    let b = kernel::translated(
        &Shape::box_with_dimensions(10.0, 10.0, 10.0),
        [60.0, 0.0, 0.0],
    )
    .expect("moved");
    let glued = kernel::compound([&a, &b]);
    let out = kernel::unify_body(&glued);

    assert_eq!(kernel::count(&out, Kind::Solid), 2, "two separate pieces");
    assert!((kernel::volume(&out).abs() - 9000.0).abs() < 1e-6);
    assert!(covers(
        kernel::bbox(&out).expect("a box"),
        kernel::bbox(&glued).expect("a box"),
        1e-6,
    ));
}

/// The bug this file exists for: a sweep joined to a tangent swept tube came
/// back as the bigger tube alone, no error, the second tube simply gone.
#[test]
fn a_join_of_tangent_swept_tubes_merges_both() {
    let raw = corpus_doc("sweep_join_tangent_tubes");
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("the document types");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");

    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1, "the join keeps one body");
    let body = &r.bodies[0];
    assert_eq!(
        kernel::count(&body.shape, Kind::Solid),
        1,
        "one merged solid"
    );
    // The Python engine measures 2716742 from the kernel; the top tube alone is
    // 1898918, which is what the lost second tube used to leave behind.
    let vol = kernel::volume(&body.shape).abs();
    assert!(
        (vol - 2_716_742.0).abs() < 0.005 * 2_716_742.0,
        "volume {vol}, the down tube is missing at 1898918"
    );
}
