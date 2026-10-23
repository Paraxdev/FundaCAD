use fundacad_mcp::shortcuts::*;
use serde_json::{json, Map, Value};

fn sketch(entities: Value) -> Map<String, Value> {
    json!({"id": "sk1", "type": "sketch", "plane": "XY", "entities": entities}).as_object().cloned().unwrap()
}

#[test]
fn a_closed_polyline_is_lines_that_share_their_ends() {
    let mut f = sketch(json!([{"type": "polyline", "id": "p", "closed": true,
                               "points": [[0, 0], ["w", 0], {"x": "w", "y": 10}]}]));
    let notes = expand(&mut f, Some(&[])).unwrap();
    assert_eq!(notes, vec!["polyline p became lines p_1..p_3"]);
    let lines = f["entities"].as_array().unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0], json!({"type": "line", "id": "p_1", "x1": 0, "y1": 0, "x2": "w", "y2": 0}));
    assert_eq!(lines[1]["x1"], lines[0]["x2"]);
    assert_eq!(lines[2]["x2"], json!(0));
}

#[test]
fn generated_ids_step_round_ones_in_use() {
    let mut f = sketch(json!([{"type": "circle", "id": "p_2", "radius": 1},
                              {"type": "polyline", "id": "p", "points": [[0, 0], [1, 0], [1, 1]], "construction": true}]));
    expand(&mut f, Some(&[])).unwrap();
    let ids: Vec<&str> = f["entities"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["p_2", "p_1", "p_3"]);
    assert_eq!(f["entities"][1]["construction"], json!(true));
}

#[test]
fn bad_polylines_and_entities_are_refused() {
    let refuse = |e: Value| expand(&mut sketch(e), Some(&[])).unwrap_err();
    assert!(refuse(json!([{"type": "polyline", "points": [[0, 0]]}])).contains("at least 2 points"));
    assert!(refuse(json!([{"type": "polyline", "closed": true, "points": [[0, 0], [1, 1]]}])).contains("at least 3"));
    assert!(refuse(json!([{"type": "polyline", "points": [[0, 0], [0, 0]]}])).contains("the same point"));
    assert!(refuse(json!([{"type": "polylin", "points": []}])).contains("no build draws"));
    assert!(refuse(json!([{"type": "rectangle", "w": 3, "height": 2}])).contains("missing the field \"width\""));
    assert!(refuse(json!([{"type": "circle", "radius": 2, "r": 3}])).contains("\"r\""));
    assert!(refuse(json!([{"type": "circle", "id": "a", "radius": 2}, {"type": "point", "id": "a", "x": 0, "y": 0}]))
        .contains("two entities"));
}

#[test]
fn ids_points_patterns_and_kept_entities() {
    // A range only when every id in it is one of the lines.
    let mut f = sketch(json!([{"type": "circle", "id": "p_2", "radius": 1},
                              {"type": "polyline", "id": "p", "closed": true, "points": [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]}]));
    assert_eq!(expand(&mut f, Some(&[])).unwrap(), vec!["polyline p became lines p_1, p_3, p_4, p_5"]);
    assert_eq!(f["entities"].as_array().unwrap().len(), 5, "the repeated start is not a fifth line");
    // 1 and 1.0 are one point.
    let refuse = |e: Value| expand(&mut sketch(e), Some(&[])).unwrap_err();
    assert!(refuse(json!([{"type": "polyline", "points": [[1, 0], [1.0, 0], [2, 2]]}])).contains("the same point"));
    assert!(refuse(json!([{"type": "polyline", "closed": 1, "points": [[0, 0], [1, 0], [1, 1]]}]))
        .contains("true or false"));
    assert!(refuse(json!([{"type": "polyline", "id": 7, "points": [[0, 0], [1, 0]]}])).contains("is a string"));
    let unknown = refuse(json!([{"type": "polylin", "points": []}]));
    assert!(unknown.contains("polyline") && unknown.contains("projected"), "{unknown}");
    // A pattern of a polyline repeats its lines; a constraint on it is refused.
    let mut f = sketch(json!([{"type": "polyline", "id": "q", "points": [[0, 0], [1, 0], [1, 1]]}]));
    f.insert("patterns".into(), json!([{"id": "pt", "type": "patternRect", "sources": ["q", "c"]}]));
    expand(&mut f, Some(&[])).unwrap();
    assert_eq!(f["patterns"][0]["sources"], json!(["q_1", "q_2", "c"]));
    let mut f = sketch(json!([{"type": "polyline", "id": "q", "points": [[0, 0], [1, 0], [1, 1]]}]));
    f.insert("constraints".into(), json!([{"type": "horizontal", "line": "q"}]));
    assert!(expand(&mut f, Some(&[])).unwrap_err().contains("constraint 0 (horizontal) names polyline q"));
    // What the sketch already held passes as it was; only the rest is checked.
    let kept = vec![json!({"type": "hyperbola", "a": 1}), json!({"type": "circle", "radius": 1, "futureFlag": 2.5})];
    let mut sent = kept.clone();
    sent.push(json!({"type": "circle", "radius": 2}));
    expand(&mut sketch(Value::Array(sent.clone())), Some(&kept)).unwrap();
    sent.push(json!({"type": "circle", "radius": 2, "r": 3}));
    assert!(expand(&mut sketch(Value::Array(sent)), Some(&kept)).unwrap_err().contains("\"r\""));
}

#[test]
fn a_rectangle_by_corners_is_stored_by_its_centre() {
    let mut f = sketch(json!([{"type": "rectangle", "id": "r", "from": [10, 0], "to": [-10, 4]}]));
    let notes = expand(&mut f, Some(&[])).unwrap();
    assert_eq!(
        f["entities"][0],
        json!({"type": "rectangle", "id": "r", "width": 20.0, "height": 4.0, "x": 0.0, "y": 2.0})
    );
    assert_eq!(notes, vec!["r from corners became 20 x 4 centred at (0, 2)"]);
    assert!(expand(&mut sketch(json!([{"type": "rectangle", "from": ["a", 0], "to": [1, 1]}])), Some(&[])).is_err());
}
