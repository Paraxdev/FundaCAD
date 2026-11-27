use std::collections::HashSet;

use fundacad_sketch::Entity;
use serde_json::json;

use super::relations::{constraint_rows, implied_joins, label, summary, State};

fn line(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Entity {
    Entity::Line { id: id.into(), x1, y1, x2, y2 }
}

#[test]
fn constraints_read_in_the_order_added_with_names_values_and_states() {
    let ents = vec![json!({"id": "a", "type": "line"}), json!({"id": "b", "type": "line"}), json!({"id": "c", "type": "circle"})];
    let cs = vec![
        json!({"type": "parallel", "l1": "a", "l2": "b"}),
        json!({"type": "diameter", "circle": "c", "value": 12.5}),
        json!({"type": "angle", "l1": "a", "l2": "b", "value": 30.0, "driven": true}),
        json!({"type": "horizontal", "line": "gone"}),
    ];
    let rows = constraint_rows(&ents, &cs, &HashSet::from([2]), &HashSet::from([0, 2]));
    assert_eq!(rows.iter().map(|r| r.index).collect::<Vec<_>>(), [Some(0), Some(1), Some(2), Some(3)]);
    assert_eq!(rows[0].name, "Parallel");
    assert_eq!(rows[0].detail, "Line 1 and Line 2");
    assert_eq!(rows[0].state, Some(State::Over));
    assert_eq!(rows[1].icon, "diameter");
    assert_eq!(rows[1].value.as_deref(), Some("12.5 mm"));
    assert_eq!(rows[2].value.as_deref(), Some("(30°)"));
    assert_eq!(rows[2].state, Some(State::Conflict), "a conflict outranks redundant");
    assert_eq!(rows[3].detail, "", "a constraint on a deleted shape acts on nothing");
}

#[test]
fn a_rectangle_edge_operand_reads_as_its_edge() {
    let ents = vec![json!({"id": "r", "type": "rectangle"})];
    assert_eq!(label(&ents, "r~2").as_deref(), Some("Rectangle 1 edge 3"));
    assert_eq!(label(&ents, "nope"), None);
}

#[test]
fn shared_endpoints_are_an_implied_join_unless_a_coincident_already_ties_them() {
    let ents = vec![json!({"id": "a", "type": "line"}), json!({"id": "b", "type": "line"}), json!({"id": "k", "type": "line"})];
    let solved = vec![line("a", 0., 0., 10., 0.), line("b", 10., 0., 10., 10.), line("k", 10., 10., 0., 0.)];
    let none = |_: &str| false;
    let rows = implied_joins(&ents, &solved, &none, &[]);
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|r| r.implied() && r.icon == "coincident"));
    assert_eq!(rows[0].detail, "Line 1 and Line 3");
    let tied = [json!({"type": "coincident", "e1": "a", "e2": "b"})];
    assert_eq!(implied_joins(&ents, &solved, &none, &tied).len(), 2);
    let construction = |id: &str| id == "k";
    assert_eq!(implied_joins(&ents, &solved, &construction, &[]).len(), 1, "construction shapes join nothing");
}

#[test]
fn the_summary_says_what_holds_the_sketch() {
    assert_eq!(summary(3, true), "Conflicting constraints");
    assert_eq!(summary(-1, false), "Not constrained");
    assert_eq!(summary(0, false), "Fully defined");
    assert_eq!(summary(1, false), "1 degree of freedom");
    assert_eq!(summary(4, false), "4 degrees of freedom");
}
