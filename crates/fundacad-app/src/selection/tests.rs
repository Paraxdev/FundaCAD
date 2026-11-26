use serde_json::json;

use super::*;

fn face(body: &str, face: u32) -> Pick {
    Pick::Face { body: body.into(), face, point: [3.5, -2.0, 7.25], normal: [0., 0., 1.] }
}

fn edge(body: &str, edge: u32) -> Pick {
    Pick::Edge { body: body.into(), edge, mid: [12.0, 4.5, -1.0], dir: None }
}

const PLAIN: Mods = Mods { ctrl: false, shift: false };
const CTRL: Mods = Mods { ctrl: true, shift: false };
const SHIFT: Mods = Mods { ctrl: false, shift: true };

#[test]
fn a_plain_click_takes_only_what_it_hit() {
    let mut s = Selection { picks: vec![face("b1", 2), edge("b1", 4)] };
    s.click(Some(face("b2", 7)), PLAIN);
    assert_eq!(s.picks, vec![face("b2", 7)]);
    s.click(None, PLAIN);
    assert!(s.picks.is_empty());
}

#[test]
fn ctrl_adds_and_drops() {
    let mut s = Selection::default();
    s.click(Some(face("b1", 2)), CTRL);
    s.click(Some(edge("b1", 4)), CTRL);
    assert_eq!(s.picks, vec![face("b1", 2), edge("b1", 4)]);
    // Elsewhere on the same face still drops it.
    let again = Pick::Face { body: "b1".into(), face: 2, point: [9., 9., 9.], normal: [1., 0., 0.] };
    s.click(Some(again), CTRL);
    assert_eq!(s.picks, vec![edge("b1", 4)]);
    s.click(None, CTRL);
    assert_eq!(s.picks, vec![edge("b1", 4)]);
}

#[test]
fn shift_only_adds() {
    let mut s = Selection { picks: vec![face("b1", 2)] };
    s.click(Some(face("b1", 2)), SHIFT);
    s.click(Some(face("b1", 3)), SHIFT);
    s.click(None, SHIFT);
    assert_eq!(s.picks, vec![face("b1", 2), face("b1", 3)]);
}

#[test]
fn describes_by_kind() {
    assert_eq!(Selection::default().describe(), None);
    let s = Selection { picks: vec![face("b1", 2), edge("b1", 4), face("b1", 3), Pick::Body { body: "b2".into() }] };
    assert_eq!(s.describe().as_deref(), Some("2 faces, 1 edge, 1 body"));
}

#[test]
fn drops_picks_of_bodies_gone() {
    let mut s = Selection {
        picks: vec![face("b1", 2), edge("b2", 4), Pick::Body { body: "b2".into() }, Pick::Plane { id: "XY".into() }],
    };
    s.retain_bodies(|b| b == "b1");
    assert_eq!(s.picks, vec![face("b1", 2), Pick::Plane { id: "XY".into() }]);
}

#[test]
fn writes_nearest_selectors() {
    assert_eq!(
        face("b1", 2).selector(),
        Some(json!({"kind": "face", "by": "nearest", "point": [3.5, -2.0, 7.25], "body": "b1"}))
    );
    assert_eq!(
        edge("b3", 0).selector(),
        Some(json!({"kind": "edge", "by": "nearest", "point": [12.0, 4.5, -1.0], "body": "b3"}))
    );
    assert_eq!(Pick::Body { body: "b1".into() }.selector(), None);
}

#[test]
fn the_filter_decides_what_a_click_takes() {
    let none = Selection::default();
    let body = Pick::Body { body: "b1".into() };
    assert_eq!(resolve(Filter::Faces, &none, Some(face("b1", 2)), Some(edge("b1", 4))), Some(edge("b1", 4)));
    assert_eq!(resolve(Filter::Faces, &none, Some(face("b1", 2)), None), Some(face("b1", 2)));
    assert_eq!(resolve(Filter::Faces, &none, None, None), None);
    assert_eq!(resolve(Filter::Bodies, &none, Some(face("b1", 2)), Some(edge("b1", 4))), Some(body.clone()));
    assert_eq!(resolve(Filter::Auto, &none, Some(face("b1", 2)), None), Some(body.clone()));
    let picked = Selection { picks: vec![body.clone()] };
    assert_eq!(resolve(Filter::Auto, &picked, Some(face("b1", 2)), None), Some(face("b1", 2)));
    assert_eq!(resolve(Filter::Auto, &picked, Some(face("b2", 2)), None), Some(Pick::Body { body: "b2".into() }));
}
