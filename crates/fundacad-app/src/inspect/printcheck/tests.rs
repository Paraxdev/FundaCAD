use serde_json::json;

use super::*;

fn reply(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn settings_start_at_the_manual_defaults_and_name_the_bodies() {
    let f = Settings::default().fields(&["b2".into()]);
    assert_eq!(
        Value::Object(f),
        json!({"nozzle": 0.4, "layer": 0.2, "overhang": 45.0, "minGap": 0.2, "maxBridge": 10.0, "bodies": ["b2"]})
    );
}

#[test]
fn a_clean_body_has_nothing_to_look_at() {
    let r = read(&reply(json!({"bodies": [{"id": "b1", "name": "Box", "bed": 3.0, "fault": null}], "findings": []})));
    assert_eq!(r, Report::default());
    assert_eq!(summary(&r), "Nothing to look at");
}

#[test]
fn one_overhang_gives_its_lean_area_face_and_start_height() {
    let r = read(&reply(json!({
        "bodies": [{"id": "b1", "name": "Box", "bed": 3.0}],
        "findings": [{"kind": "overhang", "body": "b1", "face": 4, "other": null, "value": 52.25, "area": 132.0,
                      "low": 7.5, "at": [1.0, -2.0, 9.0], "note": ""}],
    })));
    assert_eq!(
        r.bodies,
        vec![("Box".to_string(), vec![Finding {
            body: "b1".into(),
            face: 4,
            title: "Overhang, 52.25°, 132 mm²".into(),
            place: "Face 4, 7.5 mm above the bed".into(),
            rgb: 0xe24a3b,
        }])]
    );
    assert_eq!(summary(&r), "1 thing to look at");
}

#[test]
fn many_findings_group_by_body_and_name_both_faces_of_a_gap() {
    let r = read(&reply(json!({
        "bodies": [
            {"id": "b1", "name": "Box", "bed": 3.0},
            {"id": "b2", "name": "", "bed": -1.0, "fault": "2 open edges"},
            {"id": "b3", "name": "Pin", "bed": 0.0},
        ],
        "findings": [
            {"kind": "gap", "body": "b2", "face": 1, "other": {"body": "b2", "face": 6}, "value": 0.1, "at": [0, 0, 4.0], "note": ""},
            {"kind": "wall", "body": "b1", "face": 2, "value": 0.5, "at": [0, 0, 8.0], "note": "Two nozzle widths is 0.8"},
            {"kind": "meshHole", "body": "b2", "face": 0, "at": [0, 0, -1.0], "note": ""},
        ],
    })));
    let flat: Vec<(&str, &str, &str)> = r
        .bodies
        .iter()
        .flat_map(|(n, fs)| fs.iter().map(move |f| (n.as_str(), f.title.as_str(), f.place.as_str())))
        .collect();
    assert_eq!(
        flat,
        [
            ("Box", "Thin wall, 0.5 mm", "Face 2, 5 mm above the bed. Two nozzle widths is 0.8"),
            ("b2", "Narrow gap, 0.1 mm", "Faces 1 and 6, 5 mm above the bed"),
            ("b2", "Open shell", "Face 0, 0 mm above the bed"),
        ]
    );
    assert_eq!(r.faults, ["b2: 2 open edges"]);
    assert_eq!(summary(&r), "4 things to look at");
}
