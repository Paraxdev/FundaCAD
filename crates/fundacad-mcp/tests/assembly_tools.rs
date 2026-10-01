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

    // Two cuts swapped make the same shape, and it reads as unchanged.
    let r = mcp.call("edit", json!({"ops": [
        {"op": "add", "feature": {"type": "box", "length": 4, "width": 4, "height": 30, "operation": "cut", "targets": ["body1"]}},
        {"op": "add", "feature": {"type": "box", "length": 30, "width": 1, "height": 2, "operation": "cut", "targets": ["body1"]}}
    ], "build": true}));
    assert!(!r.is_error, "{}", r.text);
    let r = mcp.call("edit", json!({"ops": [{"op": "move", "id": "bx3", "to": 3}], "build": true}));
    assert!(r.text.contains("all bodies unchanged (2)"), "{}", r.text);

    // A part that only moved reads the same size, so it says it moved.
    let r = mcp.call("edit", json!({"ops": [{"op": "param", "name": "slide", "expr": 4}], "build": true}));
    assert!(r.text.contains("body2 \"Pin\"") && r.text.contains("(moved or reshaped, same size)"), "{}", r.text);
    assert!(r.text.contains("1 other body unchanged"), "{}", r.text);

    // feature_update says what changed, not the whole feature.
    let r = mcp.call("feature_update", json!({"id": "bx1", "patch": {"height": 10}}));
    assert_eq!(r.text, "Updated bx1 (box): height = 10. 5 features in the timeline.");
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

    // A body whose feature fails at one step is a note on that step, and the
    // rest of the sweep still counts.
    let r = mcp.call("edit", json!({"ops": [
        {"op": "param", "name": "pinh", "expr": 10},
        {"op": "update", "id": "cy1", "patch": {"height": "pinh"}}
    ]}));
    assert!(!r.is_error, "{}", r.text);
    let r = mcp.call("interference", json!({"bodies": ["Block", "Pin"], "sweep": {"param": "pinh", "values": [10, 0]}}));
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("pinh = 0: clear (Pin not built) (features failed: cy1"), "{}", r.text);
    assert!(r.text.contains("1 step had failed features"), "{}", r.text);
    assert!(r.text.contains("Pin was not built at 1 step (pinh = 0 mm)"), "{}", r.text);
    let r = mcp.call("interference", json!({"bodies": ["Block", "Nope"], "sweep": {"param": "pinh", "values": [10, 0]}}));
    assert!(r.is_error && r.text.starts_with("no body 'Nope' at any step of the sweep"), "{}", r.text);

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

    // A folder path with no extension still gives files a slicer knows.
    let bare = tmp.path().join("bare");
    let r = mcp.call("export", json!({"path": bare.to_string_lossy(), "format": "stl", "separate": true}));
    assert!(!r.is_error, "{}", r.text);
    assert!(bare.join("Plate.stl").is_file(), "{}", r.text);

    // A part whose name is taken by a folder refuses before anything moves.
    std::fs::remove_file(parts.join("Rod.stl")).unwrap();
    std::fs::create_dir(parts.join("Rod.stl")).unwrap();
    let before = std::fs::read(parts.join("Plate.stl")).unwrap();
    let r = mcp.call("export", json!({"path": path.to_string_lossy(), "format": "stl", "separate": true}));
    assert!(r.is_error && r.text.contains("Rod.stl is a folder"), "{}", r.text);
    assert_eq!(std::fs::read(parts.join("Plate.stl")).unwrap(), before, "the old plate was replaced");

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

#[test]
fn a_section_gives_the_outline_and_the_numbers_a_beam_check_needs() {
    let mut mcp = session();
    let r = mcp.call(
        "edit",
        json!({"ops": [
            {"op": "add", "feature": {"type": "box", "length": 20, "width": 10, "height": 30, "name": "Beam"}},
            {"op": "add", "feature": {"type": "cylinder", "radius": 5, "height": 40, "name": "Tube"}},
            {"op": "add", "feature": {"type": "cylinder", "radius": 3, "height": 50, "operation": "cut", "targets": ["body2"]}},
            {"op": "add", "feature": {"type": "move", "dx": 30, "bodies": ["body2"]}}
        ]}),
    );
    assert!(!r.is_error, "{}", r.text);
    let r = mcp.call("section", json!({"axis": "Z", "at": 1}));
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("body1 \"Beam\": area 200 mm2 in 1 piece\n"), "{}", r.text);
    assert!(r.text.contains("Ix = 1667 mm4 (bending about x), Iy = 6667 mm4, Ixy = 0 mm4"), "{}", r.text);
    assert!(r.text.contains("loop 1 (outline, 4 points): [[-10,-5],[10,-5],[10,5],[-10,5]]"), "{}", r.text);
    // A tube, against pi (R^2 - r^2) and pi/4 (R^4 - r^4) within a quarter percent.
    let r = mcp.call("section", json!({"axis": "Z", "at": 1, "bodies": ["Tube"], "outline": false}));
    let number = |after: &str| -> f64 {
        let at = r.text.find(after).unwrap_or_else(|| panic!("no {after} in {}", r.text)) + after.len();
        r.text[at..].split(' ').next().unwrap().parse().unwrap()
    };
    let pi = std::f64::consts::PI;
    assert!((number("area ") / (pi * 16.0) - 1.0).abs() < 2.5e-3, "{}", r.text);
    assert!((number("Ix = ") / (pi / 4.0 * 544.0) - 1.0).abs() < 2.5e-3, "{}", r.text);
    assert!(r.text.contains("in 1 piece with 1 hole"), "{}", r.text);
    assert!(!r.text.contains("Beam"), "{}", r.text);
    // At 45 degrees the beam's cut is root 2 longer.
    let r = mcp.call("section", json!({"origin": [0, 0, 0], "normal": [0, 1, 1], "bodies": ["Beam"]}));
    assert!(r.text.contains("area 282.8 mm2"), "{}", r.text);
    // A plane on the bottom face reads like one on the top face.
    for at in [-15, 15] {
        let r = mcp.call("section", json!({"axis": "Z", "at": at, "bodies": ["Beam"], "outline": false}));
        assert!(r.text.contains("the plane lies on a face of it, the face's area 200 mm2"), "Z = {at}: {}", r.text);
    }
    let r = mcp.call("section", json!({"axis": "X", "at": 500}));
    assert!(r.text.ends_with("The plane misses every body."), "{}", r.text);
}
