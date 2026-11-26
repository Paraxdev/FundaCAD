use serde_json::json;

use super::*;

fn row(name: &str, expr: &str, value: &str) -> Row {
    let unit = if value.ends_with(" mm") { "mm" } else if value.ends_with('\u{b0}') { "deg" } else { "count" };
    Row {
        name: name.into(),
        expr: expr.into(),
        value: value.into(),
        unit: unit.into(),
        comment: String::new(),
        drives: None,
        issue: None,
    }
}

#[test]
fn value_text_spells_each_unit() {
    assert_eq!(value_text(12.5, "mm"), "12.5 mm");
    assert_eq!(value_text(-0.1254, "mm"), "-0.125 mm");
    assert_eq!(value_text(22.5, "deg"), "22.5\u{b0}");
    assert_eq!(value_text(7.0, "count"), "7");
}

#[test]
fn rows_of_no_parameters_are_empty() {
    let doc = json!({"features": []});
    assert_eq!(rows(doc.as_object().unwrap()), Rows::default());
}

#[test]
fn rows_split_user_and_model_parameters_and_name_what_each_drives() {
    let doc = json!({
        "paramDefs": {
            "wall": {"expr": "2.5", "value": 2.5, "unit": "mm", "comment": "outer wall"},
            "tilt": {"expr": "wall * 3", "value": 7.5, "unit": "deg"},
            "d1": {"expr": "wall + 1", "value": 3.5, "unit": "mm", "target": {"kind": "feature", "feature": "e4", "field": "distance"}},
            "d2": {"expr": "wall", "value": 2.5, "unit": "mm", "target": {"kind": "constraint", "sketch": "s3", "constraint": "k1"}},
            "d3": {"expr": "3", "value": 3, "unit": "count", "target": {"kind": "pattern", "sketch": "s3", "pattern": "q1", "field": "count"}},
            "d4": {"expr": "tilt", "value": 7.5, "unit": "mm", "target": {"kind": "entity", "sketch": "s9", "entity": "p1", "field": "radius"}}
        },
        "features": [
            {"id": "s3", "type": "sketch", "entities": [], "constraints": [{"type": "distance", "id": "k1", "value": 2.5}],
             "patterns": [{"type": "boltCircle", "id": "q1", "count": 3}]},
            {"id": "e4", "type": "extrude", "sketch": "s3", "distance": 3.5}
        ]
    });
    let got = rows(doc.as_object().unwrap());
    let mut wall = row("wall", "2.5", "2.5 mm");
    wall.comment = "outer wall".into();
    let model = |name: &str, expr: &str, value: &str, drives: &str| Row {
        drives: Some(drives.into()),
        ..row(name, expr, value)
    };
    let mut d4 = model("d4", "tilt", "7.5 mm", "radius in s9");
    d4.issue = Some(edit::TARGET_GONE.into());
    assert_eq!(
        got,
        Rows {
            user: vec![wall, row("tilt", "wall * 3", "7.5\u{b0}")],
            model: vec![
                model("d1", "wall + 1", "3.5 mm", "Extrude e4 \u{b7} distance"),
                model("d2", "wall", "2.5 mm", "dimension in Sketch s3"),
                model("d3", "3", "3", "pattern count in Sketch s3"),
                d4,
            ],
        }
    );
    assert_eq!(got.find("d3").map(|r| r.value.as_str()), Some("3"));
    assert_eq!(got.find("nope"), None);
}

#[test]
fn rows_of_plain_parameters_are_user_rows_with_their_issues() {
    let doc = json!({"parameters": {"a": 4, "b": 0.75}, "features": []});
    assert_eq!(
        rows(doc.as_object().unwrap()),
        Rows { user: vec![row("a", "4", "4 mm"), row("b", "0.75", "0.75 mm")], model: vec![] }
    );
    let doc = json!({"paramDefs": {"a": {"expr": "b + 1", "value": 3, "unit": "mm"}, "b": {"expr": "a", "value": 2, "unit": "mm"}}});
    let got = rows(doc.as_object().unwrap());
    let stale = |r: Row| Row { issue: Some("circular reference".into()), ..r };
    assert_eq!(got.user, vec![stale(row("a", "b + 1", "3 mm")), stale(row("b", "a", "2 mm"))]);
}
