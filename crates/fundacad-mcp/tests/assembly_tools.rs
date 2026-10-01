//! The tools for working on an assembly rather than one part: `edit` for many
//! changes in one call, `interference` for fits and clearances (once or swept
//! over a parameter), a feature's `name` on the bodies it makes, and `export`
//! one file per part, laid flat. Spawns the engine.

mod common;

use std::collections::BTreeMap;

use common::Mcp;
use serde_json::{json, Value};

fn session() -> Mcp {
    Mcp::start(&BTreeMap::new(), &std::env::temp_dir())
}

/// A 20 mm block and a pin standing 0.5 mm above it, the pin moved along X
/// by `slide`, and a cube sunk into the block.
fn assembly() -> Vec<Value> {
    vec![
        json!({"op": "param", "name": "slide", "expr": 0}),
        json!({"op": "param", "name": "drop", "expr": 0}),
        json!({"op": "param", "name": "lift", "expr": "10.5 - drop"}),
        json!({"op": "add", "feature": {"type": "box", "length": 20, "width": 20, "height": 10, "name": "Block"}}),
        json!({"op": "add", "feature": {"type": "cylinder", "radius": 3, "height": 10, "name": "Pin"}}),
        json!({"op": "add", "feature": {"type": "move", "dx": "slide", "dz": "lift", "bodies": ["body2"]}}),
    ]
}

#[test]
fn edit_applies_everything_or_nothing_and_build_names_only_what_changed() {
    let mut mcp = session();
    let r = mcp.call("edit", json!({"ops": assembly(), "build": true}));
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.starts_with("Applied 6 edits: added bx1 (box), cy1 (cylinder), mv1 (move)"), "{}", r.text);
    assert!(r.text.contains("body1 \"Block\": 20.0 x 20.0 x 10.0 mm"), "{}", r.text);
    assert!(r.text.contains("body2 \"Pin\""), "{}", r.text);
    assert!(!r.text.contains("timeline:"), "{}", r.text);

    // One bad entry and none of the others land.
    let before = mcp.call("doc_get", json!({"features_only": true})).text;
    let r = mcp.call(
        "edit",
        json!({"ops": [
            {"op": "add", "feature": {"type": "box", "length": 1, "width": 1, "height": 1}},
            {"op": "update", "id": "nope", "patch": {"height": 5}}
        ]}),
    );
    assert!(r.is_error, "{}", r.text);
    assert!(r.text.starts_with("Edit 2 of 2 (update nope) refused, so none of the 2 was applied"), "{}", r.text);
    assert_eq!(mcp.call("doc_get", json!({"features_only": true})).text, before);

    // A later build lists the body that changed and counts the rest.
    let r = mcp.call("edit", json!({"ops": [{"op": "update", "id": "bx1", "patch": {"height": 12}}], "build": true}));
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("updated bx1 (height)"), "{}", r.text);
    assert!(r.text.contains("body1 \"Block\": 20.0 x 20.0 x 12.0 mm"), "{}", r.text);
    assert!(!r.text.contains("body2 \"Pin\""), "{}", r.text);
    assert!(r.text.contains("1 other body unchanged"), "{}", r.text);
    let r = mcp.call("build", json!({}));
    assert_eq!(r.text, "all bodies unchanged (2)");
    let r = mcp.call("build", json!({"full": true}));
    assert_eq!(r.text.lines().filter(|l| l.starts_with("body")).count(), 2, "{}", r.text);

    // feature_update says what changed, not the whole feature.
    let r = mcp.call("feature_update", json!({"id": "bx1", "patch": {"height": 10}}));
    assert_eq!(r.text, "Updated bx1 (box): height = 10. 3 features in the timeline.");
}

#[test]
fn interference_reports_overlaps_and_gaps_and_sweeps_a_parameter() {
    let mut mcp = session();
    let r = mcp.call("edit", json!({"ops": assembly()}));
    assert!(!r.is_error, "{}", r.text);

    let r = mcp.call("interference", json!({}));
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.starts_with("No bodies overlap."), "{}", r.text);
    assert!(r.text.contains("body1 \"Block\" / body2 \"Pin\": 0.5 mm apart"), "{}", r.text);

    // Checking changes nothing: no feature is added and no body is replaced.
    let before = mcp.call("doc_get", json!({})).text;
    let r = mcp.call(
        "interference",
        json!({"bodies": ["Block", "Pin"], "sweep": {"param": "drop", "from": 0, "to": 1.5, "steps": 4}}),
    );
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.starts_with("Overlaps at 2 of 4 steps: drop = 1, 1.5 mm."), "{}", r.text);
    assert!(r.text.contains("drop = 0: clear, closest body1/body2 0.5 mm"), "{}", r.text);
    assert!(r.text.contains("drop = 0.5: clear, closest body1/body2 touching"), "{}", r.text);
    assert!(r.text.contains("drop = 1: CLASH body1/body2 14.137 mm3"), "{}", r.text);
    assert_eq!(mcp.call("doc_get", json!({})).text, before);

    let r = mcp.call("interference", json!({"bodies": ["Nope"]}));
    assert!(r.is_error && r.text.contains("no body 'Nope'"), "{}", r.text);
    let r = mcp.call("interference", json!({"sweep": {"param": "nope", "values": [1]}}));
    assert!(r.is_error && r.text.contains("no parameter 'nope' to sweep"), "{}", r.text);
}

/// Each triangle's corners in a binary STL, as the lowest and highest corner.
fn stl_box(path: &std::path::Path) -> ([f32; 3], [f32; 3]) {
    let d = std::fs::read(path).expect("the STL");
    let n = u32::from_le_bytes(d[80..84].try_into().unwrap()) as usize;
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for t in 0..n {
        for c in 0..3 {
            for k in 0..3 {
                let o = 84 + t * 50 + 12 + c * 12 + k * 4;
                let v = f32::from_le_bytes(d[o..o + 4].try_into().unwrap());
                lo[k] = lo[k].min(v);
                hi[k] = hi[k].max(v);
            }
        }
    }
    (lo, hi)
}

#[test]
fn a_named_part_exports_to_a_file_of_its_name_lying_flat() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let mut mcp = session();
    // A plate tipped over at an angle, and a rod on its side.
    let r = mcp.call(
        "edit",
        json!({"ops": [
            {"op": "add", "feature": {"type": "box", "length": 30, "width": 4, "height": 10, "name": "Plate"}},
            {"op": "add", "feature": {"type": "move", "rx": 30, "ry": 20, "rz": 10, "dz": 50, "bodies": ["body1"]}},
            {"op": "add", "feature": {"type": "cylinder", "radius": 5, "height": 40, "name": "Rod"}},
            {"op": "add", "feature": {"type": "move", "rx": 90, "dx": 40, "bodies": ["body2"]}},
            {"op": "add", "feature": {"type": "duplicate", "dx": 20, "bodies": ["body2"], "name": "Spare rod"}}
        ], "build": true}),
    );
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("body3 \"Spare rod\""), "{}", r.text);

    let path = tmp.path().join("parts.stl");
    let r = mcp.call(
        "export",
        json!({"path": path.to_string_lossy(), "format": "stl", "separate": true, "layFlat": true}),
    );
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("Laid flat: body1 on F3, body2 on F"), "{}", r.text);
    let parts = tmp.path().join("parts");
    let (lo, hi) = stl_box(&parts.join("Plate.stl"));
    assert!(lo[2].abs() < 1e-3 && (hi[2] - 4.0).abs() < 1e-3, "the plate lies on a big face: {lo:?} {hi:?}");
    let (lo, hi) = stl_box(&parts.join("Rod.stl"));
    assert!(lo[2].abs() < 1e-3 && (hi[2] - 40.0).abs() < 1e-3, "the rod stands on an end: {lo:?} {hi:?}");
    assert!(parts.join("Spare rod.stl").is_file() || parts.join("Spare_rod.stl").is_file());

    // A face picked by index, on one body exported alone.
    let one = tmp.path().join("plate.stl");
    let r = mcp.call(
        "export",
        json!({"path": one.to_string_lossy(), "format": "stl", "body": "Plate", "layFlat": {"Plate": 0}}),
    );
    assert!(!r.is_error, "{}", r.text);
    let (lo, hi) = stl_box(&one);
    assert!(lo[2].abs() < 1e-3 && (hi[2] - 30.0).abs() < 1e-3, "on its 4 x 10 end: {lo:?} {hi:?}");

    // The STEP names its top assembly after the file and its parts after
    // the bodies, and no temporary name is left in it or beside it.
    let step = tmp.path().join("claw.step");
    let r = mcp.call("export", json!({"path": step.to_string_lossy(), "format": "step"}));
    assert!(!r.is_error, "{}", r.text);
    let text = std::fs::read_to_string(&step).expect("the STEP");
    assert!(text.contains("PRODUCT('claw'") && text.contains("PRODUCT('Plate'"), "no names in the STEP");
    assert!(!text.contains("partial"), "a temporary name reached the STEP");
    let left: Vec<_> = std::fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().contains(".partial-"))
        .collect();
    assert!(left.is_empty(), "temporary files left: {left:?}");
}
