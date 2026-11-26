use serde_json::{json, Map, Value};

/// A plate with a bore and a round, a box beside it and a suppressed fillet past the marker.
pub fn doc() -> Map<String, Value> {
    json!({
        "parameters": {"w": 14, "h": 23, "d1": 7, "r1": 1.5, "r2": 3},
        "paramDefs": {
            "w": {"expr": "14", "value": 14, "unit": "mm"},
            "h": {"expr": "w + 9", "value": 23, "unit": "mm"},
            "d1": {"expr": "7", "value": 7, "unit": "mm",
                   "target": {"kind": "feature", "feature": "pad", "field": "distance"}},
            "r1": {"expr": "1.5", "value": 1.5, "unit": "mm",
                   "target": {"kind": "feature", "feature": "round", "field": "radius"}},
            "r2": {"expr": "r1 * 2", "value": 3, "unit": "mm"},
        },
        "features": [
            {"id": "base", "type": "sketch", "name": "Outline", "plane": "XY",
             "entities": [{"type": "line", "id": "l1", "x1": "w", "y1": 3, "x2": 17, "y2": 3}]},
            {"id": "pad", "type": "extrude", "sketch": "base", "distance": 7},
            {"id": "hole", "type": "sketch", "plane": "XZ"},
            {"id": "bore", "type": "extrude", "sketch": "hole", "operation": "cut", "targets": ["body1"],
             "distance": "h"},
            {"id": "round", "type": "fillet", "radius": 1.5, "edges": [{"kind": "edge", "by": "match", "body": "body1"}]},
            {"id": "lid", "type": "box", "length": 12},
            {"id": "lone", "type": "fillet", "radius": 2},
        ],
        "bodyIds": {"pad:0": "body1", "bore:0": "body1", "lid:0": "body2"},
        "suppressed": ["lone"],
        "rollback": 6,
    })
    .as_object()
    .unwrap()
    .clone()
}

pub fn order(doc: &Map<String, Value>) -> Vec<String> {
    super::ids(doc)
}

pub fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}
