//! A feature that fails carries the report the app pastes into an issue: the
//! OpenCASCADE call that refused, what it was handed, and the bodies in play.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use serde_json::{json, Value};

#[test]
fn an_oversized_fillet_names_the_kernel_call_that_refused() {
    let doc = json!({
        "parameters": {"r": 30},
        "features": [
            {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
            {"id": "b", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": "r"},
        ]
    });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    let err = r
        .errors
        .iter()
        .find(|e| e.feature_id.as_deref() == Some("b"))
        .unwrap_or_else(|| panic!("the fillet fails: {:?}", r.errors));

    assert!(
        err.wire().get("detail").is_none(),
        "wire stays as the parity suites compare it"
    );
    let full = err.wire_full();
    let d = &full["detail"];
    assert_eq!(d["type"], "fillet");
    assert_eq!(d["index"], 1);
    assert_eq!(d["bodyCount"], 1);
    assert_eq!(d["params"]["r"], 30.0);
    assert!(
        d["bodies"][0]["shape"]
            .as_str()
            .unwrap()
            .contains("solids=1, faces=6, edges=12"),
        "{d}"
    );

    let calls = d["kernel"].as_array().expect("kernel calls");
    let failed: Vec<&Value> = calls.iter().filter(|c| c.get("error").is_some()).collect();
    assert!(!failed.is_empty(), "a refusing call is recorded: {d}");
    assert!(
        failed
            .iter()
            .any(|c| c["op"].as_str().unwrap().contains("Fillet") && c.get("args").is_some()),
        "the fillet call is named with its inputs: {d}"
    );
}

#[test]
fn a_passing_build_has_no_errors_to_report() {
    let doc =
        json!({"features": [{"id": "a", "type": "box", "length": 10, "width": 10, "height": 10}]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty());
}
