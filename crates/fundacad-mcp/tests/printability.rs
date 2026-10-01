//! `printability`: overhangs, thin walls and floors, gaps, bridges and open
//! shells, on parts built the way an agent builds them. Spawns the engine.

mod common;

use std::collections::BTreeMap;

use common::Mcp;
use serde_json::{json, Value};


fn built(ops: Value) -> Mcp {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    let r = mcp.call("edit", json!({"ops": ops, "build": true}));
    assert!(!r.is_error, "{}", r.text);
    mcp
}

fn check(mcp: &mut Mcp, args: Value) -> String {
    let r = mcp.call("printability", args);
    assert!(!r.is_error, "{}", r.text);
    r.text
}

fn add(feature: Value) -> Value {
    json!({"op": "add", "feature": feature})
}

#[test]
fn a_block_on_the_bed_prints_and_a_cone_past_45_degrees_does_not() {
    let mut mcp = built(json!([add(json!({"type": "box", "length": 20, "width": 20, "height": 10}))]));
    let text = check(&mut mcp, json!({}));
    assert!(text.starts_with("Printability, +Z up as modelled, bed at z = -5; nozzle 0.4, layer 0.2"), "{text}");
    assert!(text.ends_with("body1 \"Box\": nothing found"), "{text}");

    let mut mcp = built(json!([add(json!({"type": "cone", "bottomRadius": 5, "topRadius": 15, "height": 10}))]));
    assert!(check(&mut mcp, json!({})).ends_with("nothing found"), "a 45 degree cone prints");
    let mut mcp = built(json!([add(json!({"type": "cone", "bottomRadius": 5, "topRadius": 15, "height": 5}))]));
    let text = check(&mut mcp, json!({}));
    assert!(text.contains("overhang F0: ") && text.contains("leaning up to 63 deg, from the bed up"), "{text}");
}

#[test]
fn a_ledge_hangs_and_a_tunnel_roof_is_a_bridge() {
    // A T: a plate on a column, its two wings held on one side only.
    let mut mcp = built(json!([
        add(json!({"type": "box", "length": 10, "width": 10, "height": 10})),
        add(json!({"type": "box", "length": 30, "width": 10, "height": 2, "operation": "new"})),
        add(json!({"type": "move", "dz": 6, "bodies": ["body2"]})),
        add(json!({"type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(text.contains("2 overhangs"), "{text}");
    assert!(text.contains("100 mm2 needs support, leaning up to 90 deg, from 10 mm above the bed"), "{text}");
    assert!(!text.contains("bridge F"), "{text}");

    // A block with a tunnel through it: its roof is held at both ends.
    for (wide, expect) in [(20, Some("bridge F")), (8, None)] {
        let mut mcp = built(json!([
            add(json!({"type": "box", "length": 30, "width": 10, "height": 10})),
            add(json!({"type": "box", "length": wide, "width": 20, "height": 6, "operation": "cut", "targets": ["body1"]})),
        ]));
        let text = check(&mut mcp, json!({}));
        assert!(!text.contains("overhang F"), "{text}");
        match expect {
            Some(_) => assert!(text.contains(": 20 mm span (over 10)"), "{text}"),
            None => assert!(text.ends_with("nothing found"), "{text}"),
        }
    }
}

#[test]
fn a_sideways_hole_says_what_fixes_it() {
    let mut mcp = built(json!([
        add(json!({"type": "box", "length": 20, "width": 20, "height": 20})),
        add(json!({"type": "cylinder", "radius": 5, "height": 30, "operation": "cut", "targets": ["body1"]})),
        add(json!({"type": "move", "ry": 90, "bodies": ["body1"]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(text.contains("from 13.5 mm above the bed, a sideways hole: teardropHole or roofBridge fixes it"), "{text}");
}

#[test]
fn walls_floors_and_gaps_are_measured_against_the_nozzle_and_the_layer() {
    let mut mcp = built(json!([
        add(json!({"type": "box", "length": 0.6, "width": 20, "height": 10, "name": "Fin6"})),
        add(json!({"type": "box", "length": 0.3, "width": 20, "height": 10, "name": "Fin3", "operation": "new"})),
        add(json!({"type": "move", "dx": 10, "bodies": ["body2"]})),
        add(json!({"type": "box", "length": 20, "width": 20, "height": 0.6, "name": "Plate6", "operation": "new"})),
        add(json!({"type": "move", "dx": 40, "dz": -4.7, "bodies": ["body3"]})),
        add(json!({"type": "box", "length": 20, "width": 20, "height": 0.3, "name": "Plate3", "operation": "new"})),
        add(json!({"type": "move", "dx": 70, "dz": -4.85, "bodies": ["body4"]})),
        add(json!({"type": "box", "length": 20, "width": 20, "height": 10, "name": "Slotted", "operation": "new"})),
        add(json!({"type": "box", "length": 0.15, "width": 10, "height": 20, "operation": "cut", "targets": ["body5"]})),
        add(json!({"type": "move", "dy": 40, "bodies": ["body5"]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(text.contains("wall F0|F1: 0.6 mm over 200 mm2, one perimeter (under 0.8). focus {at: [0, 0, 0]"), "{text}");
    assert!(text.contains("wall F0|F1: 0.3 mm over 200 mm2, will not print (under the 0.4 mm nozzle)"), "{text}");
    assert!(text.contains("body3 \"Plate6\": nothing found"), "{text}");
    assert!(text.contains("floor F4|F5: 0.3 mm over 400 mm2, under two layers (0.4)"), "{text}");
    assert!(text.contains(": 0.15 mm over 100 mm2, will fuse shut (under 0.2)"), "{text}");
    let text = check(&mut mcp, json!({"checks": ["gap"], "bodies": ["Fin3", "Slotted"]}));
    assert!(!text.contains("wall") && text.contains("will fuse shut") && !text.contains("Plate"), "{text}");
}

#[test]
fn bodies_too_close_print_fused_unless_laid_flat_apart() {
    for (dx, expect) in [(10.1, Some("0.1 mm gap over 100 mm2")), (10.5, None), (10.0, Some("touching over 100 mm2"))] {
        let mut mcp = built(json!([
            add(json!({"type": "box", "length": 10, "width": 10, "height": 10})),
            add(json!({"type": "box", "length": 10, "width": 10, "height": 10, "operation": "new"})),
            add(json!({"type": "move", "dx": dx, "bodies": ["body2"]}))
        ]));
        let text = check(&mut mcp, json!({}));
        match expect {
            Some(e) => assert!(text.contains(&format!("Between bodies:\n  body1 F1 | body2 F0: {e}, will print fused")), "{text}"),
            None => assert!(!text.contains("Between bodies"), "{text}"),
        }
        let text = check(&mut mcp, json!({"layFlat": true}));
        assert!(text.contains("laid flat as export would (body1 on F"), "{text}");
        assert!(!text.contains("Between bodies"), "{text}");
    }
}

#[test]
fn an_open_shell_and_a_wrong_name_are_reported() {
    let q = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
    let faces = [[0, 2, 1], [0, 3, 2], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    let mut stl = String::from("solid open\n");
    for f in faces {
        stl.push_str("facet normal 0 0 0\nouter loop\n");
        for i in f {
            stl.push_str(&format!("vertex {} {} {}\n", q[i][0], q[i][1], q[i][2]));
        }
        stl.push_str("endloop\nendfacet\n");
    }
    stl.push_str("endsolid open\n");
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    let r = mcp.call("doc_import", json!({"content": stl, "name": "open.stl", "encoding": "text"}));
    assert!(!r.is_error, "{}", r.text);
    let text = check(&mut mcp, json!({}));
    assert!(text.contains("open: 4 edges bound one face, not a closed solid"), "{text}");

    let r = mcp.call("printability", json!({"bodies": ["nope"]}));
    assert!(r.is_error && r.text.starts_with("no body 'nope' in this build"), "{}", r.text);
    let r = mcp.call("printability", json!({"up": "+Z", "layFlat": true}));
    assert!(r.is_error, "{}", r.text);
}

#[test]
fn round_parts_have_no_mesh_holes() {
    let mut mcp = built(json!([
        add(json!({"type": "sphere", "radius": 5})),
        add(json!({"type": "torus", "majorRadius": 10, "minorRadius": 2, "operation": "new"})),
        add(json!({"type": "move", "dx": 30, "bodies": ["body2"]})),
        add(json!({"type": "cylinder", "radius": 4, "height": 10, "operation": "new"})),
        add(json!({"type": "move", "dx": -30, "bodies": ["body3"]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(!text.contains("mesh has a hole") && !text.contains("wall") && !text.contains("narrow gap"), "{text}");
    assert!(text.contains("body3 \"Cylinder\": nothing found"), "{text}");
    assert!(!text.contains("-0,") && !text.contains("-0]"), "{text}");
}

fn tunnel(wide: f64, then: Vec<Value>) -> Mcp {
    let mut ops = vec![
        add(json!({"type": "box", "length": 30, "width": 10, "height": 10})),
        add(json!({"type": "box", "length": wide, "width": 20, "height": 6, "operation": "cut", "targets": ["body1"]})),
    ];
    ops.extend(then);
    built(Value::Array(ops))
}

#[test]
fn a_tunnel_is_a_bridge_turned_filleted_or_with_any_overhang_angle() {
    // Turned off the ray grid: the open ends must not make it a ledge.
    let turn = || vec![add(json!({"type": "move", "rz": 30, "bodies": ["body1"]}))];
    assert!(check(&mut tunnel(8.0, turn()), json!({})).ends_with("nothing found"));
    let text = check(&mut tunnel(20.0, turn()), json!({}));
    assert!(text.contains(": 20 mm span (over 10)") && !text.contains("overhang F"), "{text}");
    // A fillet into each wall still holds the ceiling up.
    let edge = |x: f64| json!({"kind": "edge", "by": "nearest", "point": [x, 0, 3], "body": "body1"});
    let fillet = vec![add(json!({"type": "fillet", "radius": 1, "edges": [edge(4.0), edge(-4.0)]}))];
    let text = check(&mut tunnel(8.0, fillet), json!({}));
    assert!(!text.contains("overhang F1:"), "the ceiling is F1: {text}");
    // Bridges are checked whatever angle prints unsupported.
    let text = check(&mut tunnel(20.0, Vec::new()), json!({"overhang": 89.6}));
    assert!(text.contains(": 20 mm span (over 10)"), "{text}");
}

#[test]
fn a_body_standing_on_another_is_held_and_a_plate_on_posts_is_a_bridge() {
    let mut mcp = built(json!([
        add(json!({"type": "box", "length": 50, "width": 50, "height": 5})),
        add(json!({"type": "box", "length": 20, "width": 20, "height": 20, "operation": "new"})),
        add(json!({"type": "move", "dz": 12.5, "bodies": ["body2"]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(!text.contains("overhang F"), "{text}");

    let mut mcp = built(json!([
        add(json!({"type": "box", "length": 5, "width": 10, "height": 10})),
        add(json!({"type": "box", "length": 5, "width": 10, "height": 10, "operation": "new"})),
        add(json!({"type": "move", "dx": 30, "bodies": ["body2"]})),
        add(json!({"type": "box", "length": 35, "width": 10, "height": 2, "operation": "new"})),
        add(json!({"type": "move", "dx": 15, "dz": 6, "bodies": ["body3"]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(text.contains("bridge F") && text.contains(": 25 mm span (over 10)") && !text.contains("overhang F"), "{text}");
}

#[test]
fn walls_and_gaps_at_the_limit_pass_and_a_flat_gap_says_what_it_was_held_to() {
    let mut mcp = built(json!([
        add(json!({"type": "cylinder", "radius": 5, "height": 10})),
        add(json!({"type": "cylinder", "radius": 4.2, "height": 12, "operation": "cut", "targets": ["body1"]})),
        add(json!({"type": "box", "length": 0.8, "width": 20, "height": 10, "operation": "new"})),
        add(json!({"type": "move", "dx": 100.7, "bodies": ["body2"]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(!text.contains("wall F"), "{text}");

    let mut mcp = built(json!([
        add(json!({"type": "box", "length": 20, "width": 20, "height": 10})),
        add(json!({"type": "box", "length": 30, "width": 10, "height": 0.25, "operation": "cut", "targets": ["body1"]}))
    ]));
    let text = check(&mut mcp, json!({"layer": 0.3, "checks": ["gap"]}));
    assert!(text.contains("will fuse shut (under 0.3, one layer, as it lies flat)"), "{text}");
}

#[test]
fn a_pin_in_a_hole_hides_no_thin_wall_and_a_corner_fillet_is_no_hole() {
    let mut mcp = built(json!([
        add(json!({"type": "cylinder", "radius": 5.5, "height": 10})),
        add(json!({"type": "cylinder", "radius": 5, "height": 12, "operation": "cut", "targets": ["body1"]})),
        add(json!({"type": "cylinder", "radius": 5.05, "height": 10, "operation": "new"}))
    ]));
    let text = check(&mut mcp, json!({"layFlat": true}));
    assert!(text.contains("body1 \"Cylinder\": 1 thin wall") && text.contains("one perimeter"), "{text}");

    let mut mcp = built(json!([
        add(json!({"type": "box", "length": 10, "width": 10, "height": 10})),
        add(json!({"type": "box", "length": 30, "width": 10, "height": 2, "operation": "new"})),
        add(json!({"type": "move", "dz": 6, "bodies": ["body2"]})),
        add(json!({"type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]})),
        add(json!({"type": "fillet", "radius": 3, "edges": [
            {"kind": "edge", "by": "nearest", "point": [5, 0, 5], "body": "body1"},
            {"kind": "edge", "by": "nearest", "point": [-5, 0, 5], "body": "body1"}]}))
    ]));
    let text = check(&mut mcp, json!({}));
    assert!(text.contains("overhang F") && !text.contains("sideways hole"), "{text}");
}
