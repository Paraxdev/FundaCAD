//! A boolean that only came right on a retry says so on its feature, since
//! the shape there may not be what the first try would have made.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, BoolKind, Kind, Rung};
use serde_json::{json, Value};

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r
}

fn corpus_doc(name: &str) -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/corpus/corpus_engines.json");
    let corpus: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the corpus")).expect("json");
    corpus["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .find(|d| d["name"] == name)
        .map(|d| d["document"].clone())
        .unwrap_or_else(|| panic!("no corpus document called {name}"))
}

fn fallback_notes(r: &Rebuild) -> Vec<(String, String)> {
    r.diagnostics
        .iter()
        .filter(|d| d["code"] == "booleanFallback")
        .inspect(|d| assert_eq!(d["lossy"], false, "{d}"))
        .map(|d| (d["feature_id"].as_str().unwrap_or("").to_string(), d["reason"].as_str().unwrap_or("").to_string()))
        .collect()
}

#[test]
fn a_join_that_needed_slices_says_so() {
    // The first fuse of this tangent tube gives 2752524.869 mm3, outside the
    // join window, and the tool fused in 2 slabs is the body.
    let notes = fallback_notes(&build(&corpus_doc("sweep_join_tangent_tubes")));
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].0, "sw_down");
    assert!(notes[0].1.starts_with("joined with the tool split into 2 pieces"), "{}", notes[0].1);
}

#[test]
fn a_join_redone_with_a_coarser_fuzz_says_so() {
    // sw_chain's first fuse comes back with no volume and the C++ ladder
    // redoes it at fuzz 3.16e-3 mm; sw_down is sliced as in the tangent tubes.
    let notes = fallback_notes(&build(&corpus_doc("organic_bike")));
    let on = |fid: &str| notes.iter().filter(|n| n.0 == fid).map(|n| n.1.as_str()).collect::<Vec<_>>();
    let chain = on("sw_chain");
    assert_eq!(chain.len(), 1, "{notes:?}");
    assert!(chain[0].starts_with("joined with a 0.0032 mm tolerance"), "{}", chain[0]);
    assert!(on("sw_down").iter().any(|n| n.contains("2 pieces")), "{notes:?}");
    assert_eq!(notes.len(), 2, "{notes:?}");
}

#[test]
fn the_swapped_bop_rung_is_reported() {
    let body = kernel::make_box(20.0, 20.0, 10.0).unwrap();
    let tool = kernel::translated(&kernel::make_box(10.0, 10.0, 10.0).unwrap(), [10.0, 0.0, 0.0]).unwrap();
    let right = kernel::serial_bool(&body, &[&tool], BoolKind::Cut).unwrap();
    let loose = kernel::translated(&kernel::make_box(2.0, 2.0, 2.0).unwrap(), [20.0, 0.0, 0.0]).unwrap();
    let wrong = kernel::compound([&right, &loose]);
    let (got, rung) = kernel::bool_checked(&wrong, &body, &[&tool], BoolKind::Cut).unwrap();
    assert_eq!(rung, Rung::SwappedBop);
    assert_eq!(kernel::count(&got, Kind::Solid), 1);
    assert!((kernel::volume_precise(&got) - 3500.0).abs() < 1e-6);
    let (_, rung) = kernel::bool_checked(&right, &body, &[&tool], BoolKind::Cut).unwrap();
    assert_eq!(rung, Rung::First);
}

#[test]
fn a_clean_join_says_nothing() {
    let r = build(&json!({
        "parameters": {},
        "features": [
            {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20},
            {"id": "b2", "type": "box", "length": 30, "width": 4, "height": 4},
            {"id": "join", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]}
        ]
    }));
    assert_eq!(fallback_notes(&r), Vec::<(String, String)>::new());
}
