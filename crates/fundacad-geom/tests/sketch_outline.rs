//! `sketchOutline`: overlapping closed shapes of a sketch united into the
//! lines, arcs and circles that bound them, for the MCP `sketch_merge`.

use fundacad_geom::builder::NoWatch;
use serde_json::{json, Map, Value};

fn rect(id: &str, (x0, y0): (f64, f64), (x1, y1): (f64, f64)) -> Value {
    json!({"id": id, "type": "rectangle", "width": x1 - x0, "height": y1 - y0, "x": (x0 + x1) / 2.0, "y": (y0 + y1) / 2.0})
}

fn ask(plane: &str, entities: Value, ids: &[&str]) -> Map<String, Value> {
    let doc = json!({"features": [{"id": "sk1", "type": "sketch", "plane": plane, "entities": entities}]});
    let req = json!({"document": doc, "sketch": "sk1", "entities": ids});
    let fundacad_protocol::JobResult::Json(m) =
        fundacad_geom::features::sketch::sketch_outline_result(req.as_object().unwrap(), &NoWatch)
    else {
        panic!("expected json");
    };
    m
}

fn faces(m: &Map<String, Value>) -> Vec<Value> {
    assert!(m.get("error").is_none(), "{m:?}");
    m["faces"].as_array().unwrap().clone()
}

fn kinds(face: &Value) -> Vec<Vec<String>> {
    face["loops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap().to_string()).collect())
        .collect()
}

/// Every line and arc end, which must meet exactly one other end with the
/// very same numbers, or the build will not see a closed loop.
fn assert_welded(face: &Value) {
    let mut ends: Vec<(f64, f64)> = Vec::new();
    for e in face["loops"].as_array().unwrap().iter().flat_map(|l| l.as_array().unwrap()) {
        if e["type"] == "circle" {
            continue;
        }
        for (x, y) in [("x1", "y1"), ("x2", "y2")] {
            ends.push((e[x].as_f64().unwrap(), e[y].as_f64().unwrap()));
        }
    }
    for p in &ends {
        assert_eq!(ends.iter().filter(|q| *q == p).count(), 2, "{p:?} in {face}");
    }
}

fn area(face: &Value) -> f64 {
    face["area"].as_f64().unwrap()
}

#[test]
fn two_overlapping_rectangles_become_one_l() {
    let m = ask("XY", json!([rect("a", (0.0, 0.0), (20.0, 10.0)), rect("b", (10.0, 0.0), (20.0, 30.0))]), &["a", "b"]);
    let f = faces(&m);
    assert_eq!(f.len(), 1);
    assert_eq!(kinds(&f[0]), vec![vec!["line"; 6]]);
    assert!((area(&f[0]) - 400.0).abs() < 1e-6, "{}", f[0]);
    assert_welded(&f[0]);
    let s = &f[0]["seed"];
    let (x, y) = (s[0].as_f64().unwrap(), s[1].as_f64().unwrap());
    assert!((0.0..=20.0).contains(&x) && (0.0..=30.0).contains(&y) && !(x < 10.0 && y > 10.0), "{s}");
    assert_eq!(s[2], json!(0.0));
}

#[test]
fn rectangles_sharing_a_side_lose_it() {
    let f = faces(&ask("XY", json!([rect("a", (0.0, 0.0), (10.0, 10.0)), rect("b", (10.0, 0.0), (20.0, 10.0))]), &["a", "b"]));
    assert_eq!(kinds(&f[0]), vec![vec!["line"; 4]]);
    assert!((area(&f[0]) - 200.0).abs() < 1e-6);
}

#[test]
fn a_frame_keeps_its_hole_and_its_seed_is_in_the_material() {
    let ents = json!([
        rect("s", (0.0, 0.0), (30.0, 5.0)),
        rect("n", (0.0, 25.0), (30.0, 30.0)),
        rect("w", (0.0, 0.0), (5.0, 30.0)),
        rect("e", (25.0, 0.0), (30.0, 30.0)),
    ]);
    let f = faces(&ask("XY", ents, &["s", "n", "w", "e"]));
    assert_eq!(f.len(), 1);
    assert_eq!(kinds(&f[0]), vec![vec!["line"; 4], vec!["line"; 4]]);
    assert!((area(&f[0]) - 500.0).abs() < 1e-6);
    assert_welded(&f[0]);
    let p = &f[0]["inside"];
    let (x, y) = (p[0].as_f64().unwrap(), p[1].as_f64().unwrap());
    assert!(!((5.0..=25.0).contains(&x) && (5.0..=25.0).contains(&y)), "the seed {p} is in the hole");
}

#[test]
fn a_slot_and_a_line_loop_merge_into_lines_and_arcs() {
    let ents = json!([
        {"id": "l1", "type": "line", "x1": 0, "y1": 0, "x2": 20, "y2": 0},
        {"id": "l2", "type": "line", "x1": 20, "y1": 0, "x2": 20, "y2": 10},
        {"id": "l3", "type": "line", "x1": 20, "y1": 10, "x2": 0, "y2": 10},
        {"id": "l4", "type": "line", "x1": 0, "y1": 10, "x2": 0, "y2": 0},
        {"id": "s", "type": "slot", "x1": 20, "y1": 5, "x2": 30, "y2": 5, "width": 6},
    ]);
    let f = faces(&ask("XY", ents, &["l1", "l2", "l3", "l4", "s"]));
    assert_eq!(f.len(), 1);
    let k = kinds(&f[0]);
    assert_eq!(k.len(), 1);
    assert!(k[0].iter().filter(|t| *t == "arc").count() == 1 && k[0].iter().all(|t| t == "line" || t == "arc"), "{k:?}");
    assert_welded(&f[0]);
    let slot = 10.0 * 6.0 + std::f64::consts::PI * 9.0;
    // The slot's left end cap is inside the block.
    let expect = 200.0 + slot - std::f64::consts::PI * 9.0 / 2.0;
    assert!((area(&f[0]) - expect).abs() < 1e-3, "{} vs {expect}", area(&f[0]));
}

#[test]
fn a_circle_overlapping_a_rectangle_leaves_an_arc_and_apart_they_stay_two() {
    let ents = json!([rect("r", (0.0, 0.0), (20.0, 10.0)), {"id": "c", "type": "circle", "radius": 5, "x": 20, "y": 5}]);
    let f = faces(&ask("XY", ents.clone(), &["r", "c"]));
    assert_eq!(f.len(), 1);
    assert!(kinds(&f[0])[0].contains(&"arc".to_string()), "{:?}", kinds(&f[0]));
    assert_welded(&f[0]);

    let ents = json!([rect("r", (0.0, 0.0), (20.0, 10.0)), {"id": "c", "type": "circle", "radius": 5, "x": 40, "y": 5}]);
    let f = faces(&ask("XY", ents, &["r", "c"]));
    assert_eq!(f.len(), 2);
    assert!(f.iter().any(|x| kinds(x) == vec![vec!["circle"]]), "{f:?}");
}

#[test]
fn a_seed_on_xz_is_in_world_coordinates() {
    let f = faces(&ask("XZ", json!([rect("a", (0.0, 0.0), (20.0, 10.0)), rect("b", (5.0, 5.0), (15.0, 20.0))]), &["a", "b"]));
    let (p, s) = (&f[0]["inside"], &f[0]["seed"]);
    assert_eq!(s[0], p[0]);
    assert_eq!(s[1], json!(0.0));
    assert_eq!(s[2], p[1]);
}

#[test]
fn what_does_not_merge_is_refused_by_name() {
    let m = ask("XY", json!([rect("a", (0.0, 0.0), (20.0, 10.0)), {"id": "e", "type": "ellipse", "rx": 4, "ry": 2}]), &["a", "e"]);
    assert!(m["error"]["message"].as_str().unwrap().starts_with("e is an ellipse, and only lines, arcs"), "{m:?}");

    let ents = json!([
        rect("a", (0.0, 0.0), (20.0, 10.0)),
        {"id": "l1", "type": "line", "x1": 0, "y1": 0, "x2": 30, "y2": 0},
        {"id": "l2", "type": "line", "x1": 30, "y1": 0, "x2": 30, "y2": 10},
    ]);
    let m = ask("XY", ents, &["a", "l1", "l2"]);
    assert!(m["error"]["message"].as_str().unwrap().starts_with("l1, l2 are not part of a closed loop"), "{m:?}");

    let m = ask("XY", json!([rect("a", (0.0, 0.0), (20.0, 10.0))]), &["a", "zz"]);
    assert_eq!(m["error"]["message"], json!("no entity 'zz' in sketch sk1"));
}

fn line(id: &str, a: (f64, f64), b: (f64, f64)) -> Value {
    json!({"id": id, "type": "line", "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1})
}

#[test]
fn loops_that_share_an_edge_or_branch_are_all_merged() {
    let ents = json!([
        line("a1", (0.0, 0.0), (10.0, 0.0)), line("a2", (10.0, 0.0), (10.0, 10.0)),
        line("a3", (10.0, 10.0), (0.0, 10.0)), line("a4", (0.0, 10.0), (0.0, 0.0)),
        line("c1", (10.0, 0.0), (20.0, 0.0)), line("c2", (20.0, 0.0), (20.0, 10.0)), line("c3", (20.0, 10.0), (10.0, 10.0)),
    ]);
    let f = faces(&ask("XY", ents, &["a1", "a2", "a3", "a4", "c1", "c2", "c3"]));
    assert_eq!(f.len(), 1);
    assert!((area(&f[0]) - 200.0).abs() < 1e-6, "{}", f[0]);
    assert_eq!(kinds(&f[0]), vec![vec!["line"; 4]]);

    // A hexagon and a triangle of lines on one of its sides, to the digit.
    let (x, y) = (5.0, 10.0 * 60f64.to_radians().sin());
    let ents = json!([
        {"id": "h", "type": "polygon", "x": 0, "y": 0, "radius": 10, "sides": 6, "angle": 0},
        line("t1", (10.0, 0.0), (20.0, 5.0)), line("t2", (20.0, 5.0), (x, y)), line("t3", (x, y), (10.0, 0.0)),
    ]);
    let f = faces(&ask("XY", ents, &["h", "t1", "t2", "t3"]));
    let hexagon = 1.5 * 3f64.sqrt() * 100.0;
    let triangle = 0.5 * ((20.0 - 10.0) * (y - 0.0) - (x - 10.0) * (5.0 - 0.0)).abs();
    assert!((area(&f[0]) - (hexagon + triangle)).abs() < 1e-3, "{} vs {}", area(&f[0]), hexagon + triangle);
    assert_welded(&f[0]);
}

#[test]
fn the_seed_stays_clear_of_a_shape_left_out_and_inside_a_thin_wall() {
    let ents = json!([rect("a", (0.0, 0.0), (20.0, 20.0)), rect("b", (10.0, 0.0), (30.0, 20.0)),
                      {"id": "c", "type": "circle", "radius": 2, "x": 15, "y": 10}]);
    let f = faces(&ask("XY", ents, &["a", "b"]));
    let p = &f[0]["inside"];
    let (x, y) = (p[0].as_f64().unwrap(), p[1].as_f64().unwrap());
    assert!((x - 15.0).hypot(y - 10.0) > 2.0, "the seed {p} is in the circle left out");

    // A thin C: its centroid is in the air, and the wall is narrower than a scan step.
    let (r1, r2) = (50.0, 49.95);
    let ents = json!([
        {"id": "o", "type": "arc", "x1": r1, "y1": -1.0, "x2": r1, "y2": 1.0, "mx": -r1, "my": 0.0},
        {"id": "i", "type": "arc", "x1": (r2 * r2 - 1.0f64).sqrt(), "y1": -1.0, "x2": (r2 * r2 - 1.0f64).sqrt(), "y2": 1.0, "mx": -r2, "my": 0.0},
        line("e1", (r1, -1.0), ((r2 * r2 - 1.0f64).sqrt(), -1.0)),
        line("e2", (r1, 1.0), ((r2 * r2 - 1.0f64).sqrt(), 1.0)),
        rect("tab", (-51.0, -1.0), (-49.0, 1.0)),
    ]);
    let m = ask("XY", ents, &["o", "i", "e1", "e2", "tab"]);
    let f = faces(&m);
    let p = f[0]["inside"].as_array().expect("a point inside");
    let r = p[0].as_f64().unwrap().hypot(p[1].as_f64().unwrap());
    let in_tab = (-51.0..=-49.0).contains(&p[0].as_f64().unwrap()) && p[1].as_f64().unwrap().abs() <= 1.0;
    assert!(in_tab || (r2..=r1).contains(&r), "the seed {p:?} is off the wall");
}
