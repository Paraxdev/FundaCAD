use glam::{DVec2, DVec3, Vec3};
use serde_json::{json, Map, Value};

use super::*;

fn doc() -> Map<String, Value> {
    let mut d = json!({"features": [], "parameters": {"w": 40}}).as_object().cloned().unwrap();
    add_sketch(&mut d, json!("XY")).unwrap();
    d
}

fn p(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

fn editor() -> Editor {
    Editor::open(&doc(), "sketch1").unwrap()
}

#[test]
fn a_new_sketch_is_written_in_the_funda_shape() {
    let d = doc();
    let f = feature(&d, "sketch1").unwrap();
    assert_eq!(f["type"], "sketch");
    assert_eq!(f["plane"], "XY");
    assert_eq!(f["name"], "Sketch 1");
}

#[test]
fn named_planes_follow_fundacad_1_axes() {
    let xz = Plane::named("XZ").unwrap();
    assert_eq!(xz.to_3d(p(1.0, 2.0)), DVec3::new(1.0, 0.0, 2.0));
    assert_eq!(xz.n, DVec3::new(0.0, -1.0, 0.0));
    let face = Plane::on_face(Vec3::new(0.0, 0.0, 5.0), Vec3::Z);
    assert_eq!(face.to_2d(DVec3::new(3.0, 4.0, 5.0)), p(3.0, 4.0));
    assert_eq!(Plane::from_spec(&face.spec()).unwrap(), face);
    let hit = Plane::named("XY").unwrap().hit(Vec3::new(2.0, 3.0, 10.0), Vec3::NEG_Z).unwrap();
    assert_eq!(hit, p(2.0, 3.0));
}

#[test]
fn a_nearly_level_line_is_drawn_horizontal_and_chains_on() {
    let mut e = editor();
    e.set_tool(Tool::Line);
    assert_eq!(e.click(p(0.0, 0.0), 10.0), None);
    assert_eq!(e.click(p(20.0, 0.5), 10.0).as_deref(), Some("Add Line 1"));
    assert_eq!(e.entities[0]["y2"].as_f64(), Some(0.0));
    assert!(e.constraints.iter().any(|c| c["type"] == "horizontal" && c["line"] == "line1"));
    // The chain goes on from the end, and the next line's start is tied to it.
    assert_eq!(e.clicks.len(), 1);
    e.click(p(20.0, 10.0), 10.0);
    assert!(e.constraints.iter().any(|c| c["type"] == "coincident" && c["e1"] == "line2" && c["e2"] == "line1"));
    assert!(e.constraints.iter().any(|c| c["type"] == "vertical" && c["line"] == "line2"));
}

#[test]
fn snapping_prefers_endpoints_then_alignment_then_the_grid() {
    let mut e = editor();
    e.set_tool(Tool::Line);
    e.click(p(0.0, 0.0), 10.0);
    e.click(p(24.0, 16.0), 10.0);
    let cands = snap::candidates(&e.solved.entities);
    let s = snap::snap(p(23.6, 16.3), &cands, 10.0, true);
    assert_eq!((s.kind, s.p), (snap::Kind::Endpoint, p(24.0, 16.0)));
    let s = snap::snap(p(12.4, 7.6), &cands, 10.0, true);
    assert_eq!(s.kind, snap::Kind::Midpoint);
    let s = snap::snap(p(23.8, 40.3), &cands, 10.0, true);
    assert_eq!((s.kind, s.p), (snap::Kind::Align, p(24.0, 40.0)));
    let s = snap::snap(p(51.0, 61.0), &cands, 10.0, true);
    assert_eq!((s.kind, s.p), (snap::Kind::Grid, p(52.0, 62.0)));
}

#[test]
fn a_closed_line_loop_and_a_rectangle_are_regions() {
    let mut e = editor();
    e.set_tool(Tool::Line);
    for q in [p(0.0, 0.0), p(30.0, 0.0), p(30.0, 20.0), p(0.0, 20.0), p(0.0, 0.0)] {
        e.click(q, 10.0);
    }
    assert!(e.clicks.is_empty(), "closing on the start ends the chain");
    assert_eq!(e.regions().len(), 1);
    e.set_tool(Tool::Rectangle);
    e.click(p(50.0, 0.0), 10.0);
    e.click(p(70.0, 10.0), 10.0);
    let regions = e.regions();
    assert_eq!(regions.len(), 2);
    assert!(regions::contains(&regions[1], regions::inside(&regions[1], &[]).unwrap()));
}

#[test]
fn dimensions_drive_the_sketch_and_fix_its_freedom() {
    let mut e = editor();
    e.set_tool(Tool::Rectangle);
    e.click(p(0.0, 0.0), 10.0);
    e.click(p(30.0, 20.0), 10.0);
    assert!(e.solved.dof > 0);
    // The first corner snapped to the origin is tied to it.
    let dims = e.dims(5.0);
    assert!(dims.iter().any(|d| d.key == "entities.rect1.width" && d.value == 30.0 && d.label == "Width of Rectangle 1"));
    e.set_tool(Tool::Dimension);
    assert_eq!(e.click(p(15.0, 0.2), 10.0).as_deref(), Some("Dimension Rectangle 1"));
    e.click(p(30.1, 10.0), 10.0);
    let dims = e.dims(5.0);
    let len = dims.iter().find(|d| d.label == "Length of Rectangle 1 edge 1").unwrap();
    assert!(!dims.iter().any(|d| d.key == "entities.rect1.width"), "the constraint stands in for the width");
    let key = len.key.clone();
    e.set_dim(&key, 50.0).unwrap();
    let Some(Entity::Rectangle { width, height, .. }) = e.solved.entities.first() else { panic!() };
    assert!((width - 50.0).abs() < 1e-6 && (height - 20.0).abs() < 1e-6, "{width} {height}");
    assert!(e.set_dim(&key, -1.0).is_err());
}

#[test]
fn a_circle_snapped_to_an_endpoint_is_tied_to_it() {
    let mut e = editor();
    e.set_tool(Tool::Line);
    e.click(p(0.0, 0.0), 10.0);
    e.click(p(20.0, 7.0), 10.0);
    e.escape();
    e.set_tool(Tool::Circle);
    e.click(p(20.2, 7.1), 10.0);
    e.click(p(25.0, 7.0), 10.0);
    assert!(e.constraints.iter().any(|c| c["type"] == "coincident" && c["e1"] == "circle1" && c["e2"] == "line1" && c["p2"] == 1));
}

#[test]
fn construction_and_delete_edit_the_selected_shape() {
    let mut e = editor();
    e.set_tool(Tool::Circle);
    e.click(p(0.0, 0.0), 10.0);
    e.click(p(10.0, 0.0), 10.0);
    e.set_tool(Tool::Select);
    e.click(p(10.05, 0.0), 10.0);
    assert_eq!(e.selected.as_deref(), Some("circle1"));
    assert_eq!(e.toggle_construction().as_deref(), Some("Construction Circle 1"));
    assert!(e.regions().is_empty(), "construction shapes make no region");
    e.set_tool(Tool::Dimension);
    e.click(p(10.0, 0.0), 10.0);
    e.selected = Some("circle1".into());
    assert_eq!(e.delete_selected().as_deref(), Some("Delete Circle 1"));
    assert!(e.entities.is_empty() && e.constraints.is_empty());
}

#[test]
fn a_dragged_point_moves_through_the_solver_and_writes_back() {
    let mut e = editor();
    e.set_tool(Tool::Line);
    e.click(p(6.0, 6.0), 10.0);
    e.click(p(26.0, 6.3), 10.0);
    e.escape();
    e.set_tool(Tool::Select);
    assert!(e.drag_start(p(26.2, 6.0), 1.0));
    e.drag_to(p(40.0, 9.0));
    assert!(e.drag_end().is_some());
    let l = &e.entities[0];
    assert!((l["y2"].as_f64().unwrap() - l["y1"].as_f64().unwrap()).abs() < 1e-6, "horizontal holds: {l}");
    assert!((l["x2"].as_f64().unwrap() - 40.0).abs() < 1e-6, "{l}");
}

#[test]
fn a_part_from_scratch_adds_an_extrude_of_the_sketch() {
    let mut d = doc();
    let mut e = Editor::open(&d, "sketch1").unwrap();
    e.set_tool(Tool::Polygon);
    e.click(p(0.0, 0.0), 10.0);
    e.click(p(10.0, 0.0), 10.0);
    assert_eq!(e.regions().len(), 1);
    e.write(&mut d).unwrap();
    let id = add_extrude(&mut d, "sketch1", 10.0, &[]).unwrap();
    let f = feature(&d, &id).unwrap();
    assert_eq!((f["sketch"].as_str(), f["name"].as_str()), (Some("sketch1"), Some("Extrude 1")));
    assert_eq!(feature(&d, "sketch1").unwrap()["entities"][0]["sides"], 6);
}

#[test]
fn a_dimension_edited_in_the_document_solves_the_sketch_again() {
    let mut d = doc();
    let f = feature_mut(&mut d, "sketch1").unwrap();
    f.insert("entities".into(), json!([{"type": "line", "id": "l1", "x1": 0, "y1": 0, "x2": 10, "y2": 0}]));
    f.insert("constraints".into(), json!([{"type": "horizontal", "line": "l1"}, {"type": "distance", "id": "d1", "line": "l1", "value": 25}]));
    solve::resolve_feature(&mut d, "sketch1", Some("constraints.d1.value"));
    let l = &feature(&d, "sketch1").unwrap()["entities"][0];
    assert!((l["x2"].as_f64().unwrap() - l["x1"].as_f64().unwrap() - 25.0).abs() < 1e-6, "{l}");
}

#[test]
fn a_circle_inside_a_rectangle_is_left_out_of_the_extrude() {
    let rect = vec![p(0.0, 0.0), p(40.0, 0.0), p(40.0, 20.0), p(0.0, 20.0)];
    let circle: Vec<DVec2> = (0..32).map(|k| p(20.0, 10.0) + DVec2::from_angle(k as f64 / 32.0 * std::f64::consts::TAU) * 5.0).collect();
    let pts = regions::fill_points(&[rect.clone(), circle.clone()]);
    assert_eq!(pts.len(), 1, "only the rectangle's area, the circle is its hole");
    assert!(regions::contains(&rect, pts[0]) && !regions::contains(&circle, pts[0]));
    let island: Vec<DVec2> = circle.iter().map(|q| p(20.0, 10.0) + (*q - p(20.0, 10.0)) * 0.4).collect();
    assert_eq!(regions::fill_points(&[rect, circle, island]).len(), 2, "an island in the hole fills again");
}

#[test]
fn a_face_sketch_keeps_its_face_reference_beside_the_plane() {
    let mut d = Map::new();
    let face = json!({"kind": "face", "by": "nearest", "point": [0, 0, 5], "body": "b1"});
    let mut spec = Plane::on_face(Vec3::new(0.0, 0.0, 5.0), Vec3::Z).spec();
    spec["face"] = face.clone();
    spec["at"] = json!([1, 2, 5]);
    let id = add_sketch(&mut d, spec).unwrap();
    let f = feature(&d, &id).unwrap();
    assert_eq!((&f["face"], &f["at"]), (&face, &json!([1, 2, 5])));
    assert!(f["plane"].get("face").is_none() && f["plane"].get("at").is_none());
    assert!(Plane::from_spec(&f["plane"]).is_some());
}

#[test]
fn a_circle_shows_and_takes_its_diameter_as_fc1_did() {
    let mut d = doc();
    let f = feature_mut(&mut d, "sketch1").unwrap();
    f.insert("entities".into(), json!([{"type": "circle", "id": "c1", "x": 0, "y": 0, "radius": 5}]));
    let dim = dims::feature_dims(feature(&d, "sketch1").unwrap()).remove(0);
    assert_eq!((dim.key.as_str(), dim.label.as_str(), dim.value), ("entities.c1.diameter", "Diameter of Circle 1", 10.0));
    assert_eq!(dims::virtual_field(feature(&d, "sketch1").unwrap(), &dim.key), Some((&json!(5), 2.0)));
    feature_mut(&mut d, "sketch1").unwrap()["entities"][0]["diameter"] = json!(16);
    solve::resolve_feature(&mut d, "sketch1", Some(&dim.key));
    let c = &feature(&d, "sketch1").unwrap()["entities"][0];
    assert_eq!((c["radius"].as_f64(), c.get("diameter")), (Some(8.0), None));
    let mut e = Editor::open(&d, "sketch1").unwrap();
    e.set_dim("entities.c1.diameter", 30.0).unwrap();
    assert_eq!(e.entities[0]["radius"].as_f64(), Some(15.0));
}

#[test]
fn a_dimension_held_by_a_parameter_keeps_its_name() {
    let mut d = doc();
    feature_mut(&mut d, "sketch1").unwrap().insert(
        "entities".into(),
        json!([{"type": "circle", "id": "c1", "x": 0, "y": 0, "radius": "w"},
               {"type": "rectangle", "id": "r1", "x": 0, "y": 0, "width": "w", "height": 8}]),
    );
    let mut e = Editor::open(&d, "sketch1").unwrap();
    let dia = e.dims(0.0).into_iter().find(|d| d.key == "entities.c1.diameter").unwrap();
    assert_eq!(dia.expr.as_deref(), Some("w"));
    assert!(e.set_dim("entities.c1.diameter", 30.0).is_err());
    assert!(e.set_dim("entities.r1.width", 30.0).is_err());
    assert_eq!((&e.entities[0]["radius"], &e.entities[1]["width"]), (&json!("w"), &json!("w")));
}

#[test]
fn degenerate_shapes_make_no_region_and_no_arc() {
    let mut e = editor();
    e.entities = vec![json!({"type": "line", "id": "l1", "x1": 3, "y1": 3, "x2": 3, "y2": 3})];
    e.resolve(false);
    assert!(e.regions().is_empty());
    e.set_tool(Tool::Arc);
    e.click(p(0.0, 0.0), 10.0);
    e.click(p(20.0, 0.0), 10.0);
    assert_eq!(e.click(p(10.0, 0.0), 10.0), None, "three points in a row make no arc");
}

#[test]
fn a_revolve_keeps_its_areas_as_fc1_wrote_them() {
    let mut d = doc();
    let id = add_revolve(&mut d, "sketch1", json!({"origin": [0, 0, 0], "dir": [0, 1, 0]}), &[[5.0, 1.0, 0.0]]).unwrap();
    assert_eq!(feature(&d, &id).unwrap()["regions"], json!([[5.0, 1.0, 0.0]]));
}
