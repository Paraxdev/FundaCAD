use fundacad_mcp::looseends::*;
use fundacad_mcp::model::{self, Doc};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn doc(entities: Value, constraints: Value) -> Doc {
    let mut d = model::new_document();
    d.insert(
        "features".into(),
        json!([{"id": "s1", "type": "sketch", "plane": "XY", "entities": entities, "constraints": constraints}]),
    );
    d
}

fn line(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Value {
    json!({"type": "line", "id": id, "x1": x1, "y1": y1, "x2": x2, "y2": y2})
}

fn square(g: f64) -> Value {
    json!([
        line("a", 0.0, 0.0, 10.0, 0.0),
        line("b", 10.0, 0.0, 10.0, 8.0),
        line("c", 10.0, 8.0, 0.0, 8.0),
        line("d", 0.0, 8.0, 0.0, g)
    ])
}

#[test]
fn a_square_drawn_without_snaps_is_all_untied_and_one_tie_closes_it() {
    let mut d = doc(square(4e-5), json!([]));
    let le = find(&d, "s1", Some(0.1)).unwrap();
    assert!(le.open.is_empty());
    assert_eq!(le.untied.len(), 8);
    let t = tie(&mut d, "s1", Some(0.1)).unwrap();
    assert_eq!(t.added.len(), 4);
    assert!(t.left.open.is_empty() && t.left.untied.is_empty(), "{:?}", t.left);
    let f = model::find_feature(&d, "s1").unwrap().1;
    let ents = f["entities"].as_array().unwrap();
    let (a, dd) = (&ents[0], &ents[3]);
    assert_eq!((a["x1"].as_f64(), a["y1"].as_f64()), (dd["x2"].as_f64(), dd["y2"].as_f64()));
}

#[test]
fn a_lone_line_is_two_open_ends_and_a_t_near_miss_ties_onto_the_line() {
    let d = doc(json!([line("a", 0.0, 0.0, 10.0, 0.0), line("m", 5.0, 0.03, 5.0, 6.0)]), json!([]));
    let le = find(&d, "s1", Some(0.1)).unwrap();
    assert_eq!(le.open.len(), 3);
    assert_eq!(le.untied.len(), 1);
    assert_eq!(le.untied[0].touches, Touch::Curve("a".into()));
    let mut d = d;
    let t = tie(&mut d, "s1", Some(0.1)).unwrap();
    assert_eq!(t.added, vec![json!({"type": "pointOnCurve", "e": "m", "p": 0, "curve": "a"})]);
    let m = &model::find_feature(&d, "s1").unwrap().1["entities"][1];
    assert_eq!((m["x1"].as_f64(), m["y1"].as_f64()), (Some(5.0), Some(0.0)));
}

#[test]
fn constraints_tie_ends_and_parameter_bound_ends_are_reported_but_not_moved() {
    let tied = doc(
        square(0.0),
        json!([
            {"type": "coincident", "e1": "a", "p1": 1, "e2": "b", "p2": 0},
            {"type": "coincident", "e1": "b", "p1": 1, "e2": "c", "p2": 0},
            {"type": "coincident", "e1": "c", "p1": 1, "e2": "d", "p2": 0},
            {"type": "coincident", "e1": "d", "p1": 1, "e2": "a", "p2": 0}
        ]),
    );
    let le = find(&tied, "s1", Some(0.1)).unwrap();
    assert!(le.open.is_empty() && le.untied.is_empty());
    let mut d = doc(
        json!([line("a", 0.0, 0.0, 10.0, 0.0), {"type": "line", "id": "b", "x1": "w", "y1": 0.05, "x2": 10.0, "y2": 8.0}]),
        json!([]),
    );
    d.insert("parameters".into(), json!({"w": 10.0}));
    let le = find(&d, "s1", Some(0.1)).unwrap();
    let b0 = le.untied.iter().find(|u| u.entity == "b").unwrap();
    assert!(b0.tieable, "a bound end ties by moving the free end it touches");
    let t = tie(&mut d, "s1", Some(0.1)).unwrap();
    assert_eq!(t.added.len(), 1);
    let ents = &model::find_feature(&d, "s1").unwrap().1["entities"];
    assert_eq!(ents[1]["x1"], json!("w"));
    assert_eq!((ents[0]["x2"].as_f64(), ents[0]["y2"].as_f64()), (Some(10.0), Some(0.05)));
}

#[test]
fn a_tie_onto_construction_geometry_or_an_arc_centre_leaves_the_end_open() {
    let mut k = line("k", 5.0, 0.0, 5.0, 5.0);
    k["construction"] = json!(true);
    let arc = json!({"type": "arc", "id": "r", "x1": 25.0, "y1": 0.0, "x2": 15.0, "y2": 0.0, "mx": 20.0, "my": 5.0});
    let d = doc(
        json!([line("a", 0.0, 0.0, 5.0, 0.0), k, line("b", 30.0, 9.0, 20.0, 0.0), arc]),
        json!([
            {"type": "coincident", "e1": "a", "p1": 1, "e2": "k", "p2": 0},
            {"type": "coincident", "e1": "b", "p1": 1, "e2": "r", "p2": 2}
        ]),
    );
    let le = find(&d, "s1", Some(0.1)).unwrap();
    let open: BTreeSet<(String, i64)> = le.open.iter().map(|(e, p, _)| (e.clone(), *p)).collect();
    assert!(open.contains(&("a".into(), 1)), "{le:?}");
    assert!(open.contains(&("b".into(), 1)), "{le:?}");
}

#[test]
fn two_ends_held_at_one_construction_end_are_tied_to_each_other() {
    let mut k = line("k", 5.0, 0.0, 9.0, 9.0);
    k["construction"] = json!(true);
    let d = doc(
        json!([line("a", 0.0, 0.0, 5.0, 0.0), line("b", 5.0, 0.0, 5.0, 5.0), k]),
        json!([
            {"type": "coincident", "e1": "a", "p1": 1, "e2": "k", "p2": 0},
            {"type": "coincident", "e1": "k", "p1": 0, "e2": "b", "p2": 0}
        ]),
    );
    let le = find(&d, "s1", Some(0.1)).unwrap();
    assert!(le.untied.is_empty(), "{le:?}");
    assert_eq!(le.open.len(), 2);
}
