use fundacad_geom::export::*;
use serde_json::json;

#[test]
fn mesh_options_default_and_clamp() {
    let d = mesh_options(None);
    assert_eq!((d.tol, d.max_edge, d.mm_per_unit, d.unit_name, d.binary), (0.02, 0.0, 1.0, "millimeter", true));
    assert!((d.ang - 0.3).abs() < 1e-12);
    let o = mesh_options(Some(&json!({
        "surfaceDeviation": 50, "normalDeviation": true, "maxEdgeLength": -3,
        "unit": "in", "binary": false
    })));
    assert_eq!((o.tol, o.max_edge, o.unit_name, o.binary), (10.0, 0.0, "inch", false));
    assert!((o.ang - 0.3).abs() < 1e-12);
    assert_eq!(mesh_options(Some(&json!({"unit": "yd", "binary": 0}))).unit_name, "millimeter");
}

#[test]
fn budget_messages() {
    assert_eq!(budget_refusal(10_000_000), None);
    assert_eq!(
        budget_refusal(10_000_001).unwrap(),
        "export too dense (10,000,001+ triangles), reduce texture scale or depth, or export fewer bodies"
    );
    assert_eq!(budget_warning(500_001).unwrap(), "export is very dense (500,001 triangles)");
}
