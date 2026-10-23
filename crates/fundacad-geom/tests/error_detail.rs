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
            {"id": "a", "type": "box", "length": 10, "width": 14, "height": 8},
            {"id": "m", "type": "move", "dx": 13, "dy": -7, "dz": 4, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body1"]},
            {"id": "b", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z", "body": "body1"}, "radius": "r"},
        ]
    });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    let err = r
        .errors
        .iter()
        .find(|e| e.feature_id.as_deref() == Some("b"))
        .unwrap_or_else(|| panic!("the fillet fails: {:?}", r.errors));

    assert!(err.wire().get("detail").is_none(), "wire stays as the parity suites compare it");
    let full = err.wire_full();
    let d = &full["detail"];
    assert_eq!(d["type"], "fillet");
    assert_eq!(d["index"], 2);
    assert_eq!(d["bodyCount"], 1);
    assert_eq!(d["params"]["r"], 30.0);
    assert!(d["bodies"][0]["shape"].as_str().unwrap().contains("solids=1, faces=6, edges=12"), "{d}");

    let calls = d["kernel"].as_array().expect("kernel calls");
    let failed: Vec<&Value> = calls.iter().filter(|c| c.get("error").is_some()).collect();
    assert!(!failed.is_empty(), "a refusing call is recorded: {d}");
    assert!(
        failed.iter().any(|c| c["op"].as_str().unwrap().contains("Fillet") && c.get("args").is_some()),
        "the fillet call is named with its inputs: {d}"
    );
}

/// Each edge fails alone, so the advice is the kernel's own sentence with the too large code, and the report
/// names every edge where it lies and how long the kernel took.
#[test]
fn an_oversized_fillet_reports_what_failed_where_and_how_long_it_took() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "a", "type": "box", "length": 10, "width": 14, "height": 8},
        {"id": "m", "type": "move", "dx": 13, "dy": -7, "dz": 4, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body1"]},
        {"id": "b", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z", "body": "body1"}, "radius": 30},
    ]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    let [err] = r.errors.as_slice() else { panic!("one error: {:?}", r.errors) };
    let said = &err.message;
    let keys = (err.feature_id.as_deref(), err.code.as_deref(), said.starts_with("Fillet failed on Box: "));
    assert_eq!(keys, (Some("b"), Some("blendTooLarge"), true), "{said}");
    assert!(said.contains("Failed creating a fillet") && said.contains("smaller value"), "the kernel's advice: {said}");
    assert!(!said.contains("cannot end at") && !said.contains("together"), "no corner or group is blamed: {said}");

    let mut report: Vec<Value> = r.diagnostics.iter().filter(|d| d["kind"] == "edgeOpFailed").cloned().collect();
    if let Some(failed) = report.first_mut().and_then(|d| d["failed"].as_array_mut()) {
        failed.sort_by(|a, b| a.to_string().cmp(&b.to_string()));
    }
    let mids = [[18.0, -14.0, 4.0], [18.0, 0.0, 4.0], [8.0, -14.0, 4.0], [8.0, 0.0, 4.0]];
    let want = json!({"feature_id": "b", "kind": "edgeOpFailed", "resolved": 4, "confidence": 0.0, "lossy": true,
        "reason": "per-edge", "failed": mids.map(|m| json!({"mid": m}))});
    assert_eq!(report, vec![want]);

    let d = &err.wire_full()["detail"];
    let calls = d["kernel"].as_array().expect("kernel calls");
    let failed: Vec<(&str, &str)> =
        calls.iter().filter_map(|c| Some((c["op"].as_str()?, c["error"].as_str()?))).collect();
    assert!(calls.len() >= 5, "the whole set and each edge alone are tried: {d}");
    assert_eq!(failed, vec![("BRepFilletAPI_MakeFillet", "IsDone() is false"); calls.len()], "{d}");
    // A box fillet call takes about 2 ms, seconds as milliseconds would read 0.
    for c in calls {
        let ms = c["ms"].as_f64().unwrap_or(-1.0);
        assert!((0.01..500.0).contains(&ms), "{c}");
    }
}

#[test]
fn a_passing_build_has_no_errors_to_report() {
    let doc = json!({"features": [{"id": "a", "type": "box", "length": 10, "width": 10, "height": 10}]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty());
}
