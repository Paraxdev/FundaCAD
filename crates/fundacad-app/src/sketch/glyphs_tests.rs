use std::collections::HashSet;

use fundacad_sketch::Entity;
use glam::DVec2;
use serde_json::json;

use super::glyphs::{constraint_glyphs, hit, title};
use super::relations::State;

fn line(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Entity {
    Entity::Line { id: id.into(), x1, y1, x2, y2 }
}

fn solved() -> Vec<Entity> {
    vec![
        line("a", 0.0, 0.0, 10.0, 0.0),
        line("b", 0.0, 4.0, 10.0, 4.0),
        Entity::Circle { id: "c".into(), x: 20.0, y: 0.0, radius: 3.0 },
        Entity::Rectangle { id: "r".into(), x: 0.0, y: 10.0, width: 8.0, height: 4.0, angle: 0.0 },
    ]
}

#[test]
fn each_geometric_constraint_sits_where_glyphs_ts_puts_it() {
    let cs = vec![
        json!({"type": "horizontal", "line": "a"}),
        json!({"type": "collinear", "l1": "a", "l2": "b"}),
        json!({"type": "tangent", "line": "a", "circle": "c"}),
        json!({"type": "coincident", "e1": "a", "p1": 1, "e2": "b", "p2": 1}),
        json!({"type": "fix", "e": "a", "p": 0}),
        json!({"type": "horizontalPoints", "e1": "a", "p1": 0, "e2": "b", "p2": 1}),
    ];
    let g = constraint_glyphs(&solved(), &cs, &HashSet::new(), &HashSet::new());
    let at: Vec<_> = g.iter().map(|g| (g.index, g.icon, g.pos)).collect();
    assert_eq!(at[0], (0, "horizontal", DVec2::new(5.0, 0.0)));
    assert_eq!(at[1], (1, "collinear", DVec2::new(5.0, 2.0)));
    assert_eq!(at[2], (2, "tangent", DVec2::new(12.5, 0.0)));
    assert_eq!(at[3], (3, "coincident", DVec2::new(10.0, 0.0)));
    assert_eq!(at[4], (4, "fix", DVec2::new(0.0, 0.0)));
    assert_eq!(at[5], (5, "horizontal", DVec2::new(5.0, 2.0)));
}

#[test]
fn dimensions_and_missing_shapes_get_no_glyph() {
    let cs = vec![
        json!({"type": "distance", "line": "a", "value": 10.0}),
        json!({"type": "vertical", "line": "gone"}),
        json!({"type": "parallel", "l1": "b", "l2": "a"}),
    ];
    let g = constraint_glyphs(&solved(), &cs, &HashSet::new(), &HashSet::new());
    assert_eq!(g.len(), 1);
    assert_eq!((g[0].index, g[0].pos), (2, DVec2::new(5.0, 4.0)));
}

#[test]
fn a_rectangle_edge_operand_sits_at_the_edge_middle() {
    let cs = vec![json!({"type": "vertical", "line": "r~1"})];
    let g = constraint_glyphs(&solved(), &cs, &HashSet::new(), &HashSet::new());
    assert_eq!(g.len(), 1);
    let edges = fundacad_sketch::geom::rect_corners(0.0, 10.0, 8.0, 4.0, 0.0);
    assert_eq!(g[0].pos, DVec2::new((edges[1].x + edges[2].x) / 2.0, (edges[1].y + edges[2].y) / 2.0));
}

#[test]
fn a_conflict_outranks_redundant_and_titles_follow() {
    let cs = vec![json!({"type": "horizontal", "line": "a"}), json!({"type": "horizontal", "line": "b"})];
    let g = constraint_glyphs(&solved(), &cs, &HashSet::from([1]), &HashSet::from([0, 1]));
    assert_eq!(g[0].state, Some(State::Over));
    assert_eq!(g[1].state, Some(State::Conflict));
    assert_eq!(title(None), "Click to delete this constraint");
    assert_eq!(title(Some(State::Conflict)), "Conflicting constraint, click to delete");
    assert_eq!(title(Some(State::Over)), "Redundant (over-defined) constraint, click to delete");
}

#[test]
fn a_click_takes_the_top_glyph_within_its_badge() {
    let screen = [(0, 100.0, 100.0), (3, 104.0, 100.0)];
    assert_eq!(hit(&screen, 102.0, 101.0, 8.0), Some(3));
    assert_eq!(hit(&screen, 93.0, 100.0, 8.0), Some(0));
    assert_eq!(hit(&screen, 100.0, 120.0, 8.0), None);
}
