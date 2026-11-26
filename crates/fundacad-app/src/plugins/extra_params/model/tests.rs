use serde_json::json;

use super::*;

fn doc() -> Doc {
    json!({
        "features": [],
        "parameters": {"wall": 2, "width": 40, "solid": 1},
        "paramDefs": {
            "wall": {"expr": "2", "value": 2, "unit": "mm", "control": {"kind": "slider", "min": 1, "max": 5, "step": 0.5}},
            "width": {"expr": "wall * 20", "value": 40, "unit": "mm", "group": "g1"},
            "solid": {"expr": "1", "value": 1, "unit": "count", "control": {"kind": "toggle"}},
            "d1": {"expr": "3", "value": 3, "unit": "mm", "target": {"feature": "e1", "field": "distance"}}
        },
        "paramExtras": {
            "groups": [{"id": "g1", "name": "Size"}, {"id": "g1", "name": "Again"}],
            "checks": [
                {"id": "c1", "expr": "wall > 1", "message": "walls too thin", "level": "error"},
                {"id": "c2", "expr": "width < 30", "message": "too wide", "level": "warning"},
                {"id": "c3", "expr": "nothing + 1", "message": "broken", "level": "warning"}
            ]
        }
    })
    .as_object()
    .unwrap()
    .clone()
}

#[test]
fn a_control_keeps_its_value_in_range_and_on_step() {
    let slider = Control::Slider { min: 1., max: 5., step: Some(0.5) };
    assert_eq!(clamp_to_control(Some(&slider), 2.3), 2.5);
    assert_eq!(clamp_to_control(Some(&slider), 9.), 5.);
    assert_eq!(clamp_to_control(Some(&slider), -3.), 1.);
    assert_eq!(clamp_to_control(Some(&Control::Toggle), 0.2), 1.);
    let choice = Control::Choice(vec![Choice { label: "a".into(), value: 2. }, Choice { label: "b".into(), value: 6. }]);
    assert_eq!(clamp_to_control(Some(&choice), 4.5), 6.);
    let step = Control::Number { min: None, max: None, step: Some(0.1) };
    assert_eq!(clamp_to_control(Some(&step), 0.30000000000000004), 0.3);
    assert_eq!(clamp_to_control(None, 7.7), 7.7);
}

#[test]
fn a_value_out_of_its_control_says_why() {
    let def = json!({"value": 7, "control": {"kind": "slider", "min": 1, "max": 5}});
    assert_eq!(control_problem(&def).as_deref(), Some("above the maximum of 5"));
    let def = json!({"value": 2, "control": {"kind": "toggle"}});
    assert_eq!(control_problem(&def).as_deref(), Some("a toggle is 0 or 1"));
    assert_eq!(control_problem(&json!({"value": 2})), None);
}

#[test]
fn checks_hold_fail_or_do_not_evaluate() {
    let r = check_results(&doc());
    assert_eq!(r.iter().map(|c| c.ok).collect::<Vec<_>>(), [true, false, false]);
    assert!(r[0].error_level && !r[1].error_level);
    assert!(r[2].error.is_some() && r[1].error.is_none());
}

#[test]
fn user_parameters_group_and_model_ones_stay_out() {
    let g = tune_groups(&doc());
    assert_eq!(g.len(), 2);
    assert_eq!(g[0].id, None);
    assert_eq!(g[0].rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["wall", "solid"]);
    assert_eq!((g[1].name.as_str(), g[1].rows[0].name.as_str()), ("Size", "width"));
    assert!(!g[1].rows[0].editable, "an expression is not set through a control");
    assert_eq!(g[0].rows[1].control, Control::Toggle);
}

#[test]
fn setting_a_value_clamps_and_recomputes_what_reads_it() {
    let mut d = doc();
    set_value(&mut d, "wall", 3.2).unwrap();
    assert_eq!(d["paramDefs"]["wall"]["expr"], "3");
    assert_eq!(d["paramDefs"]["width"]["value"].as_f64(), Some(60.));
}

#[test]
fn a_control_round_trips_as_fundacad_1_writes_it() {
    let c = Control::read(Some(&json!({"kind": "slider", "min": 0, "max": 10, "step": 0.5}))).unwrap();
    assert_eq!(c.to_json(), json!({"kind": "slider", "min": 0, "max": 10, "step": 0.5}));
    let mut d = doc();
    set_control(&mut d, "wall", Some(&Control::Choice(vec![Choice { label: "thin".into(), value: 1. }]))).unwrap();
    assert_eq!(d["paramDefs"]["wall"]["control"], json!({"kind": "choice", "choices": [{"label": "thin", "value": 1}]}));
    set_control(&mut d, "wall", None).unwrap();
    assert!(d["paramDefs"]["wall"].get("control").is_none());
}

#[test]
fn switching_kind_carries_the_range() {
    let from = Control::Number { min: Some(2.), max: None, step: Some(1.) };
    assert_eq!(convert_control(Some(&from), "slider", 3.), Some(Control::Slider { min: 2., max: 6., step: Some(1.) }));
    assert_eq!(
        convert_control(None, "choice", 4.),
        Some(Control::Choice(vec![Choice { label: "4".into(), value: 4. }]))
    );
}

#[test]
fn a_configuration_captures_applies_and_drifts() {
    let mut d = doc();
    let id = add_configuration(&mut d, "Classic");
    assert_eq!(id, "c1");
    assert_eq!(active_configuration(&d).as_deref(), Some("c1"));
    let cfg = &d["paramExtras"]["configurations"][0];
    assert_eq!(cfg["values"], json!({"wall": "2", "width": "wall * 20", "solid": "1"}));
    set_value(&mut d, "wall", 4.).unwrap();
    assert_eq!(configuration_drift(&d, &id), ["wall"]);
    apply_configuration(&mut d, &id).unwrap();
    assert_eq!(d["paramDefs"]["wall"]["expr"], "2");
    assert_eq!(d["paramDefs"]["width"]["value"].as_f64(), Some(40.));
    assert_eq!(active_configuration(&d).as_deref(), Some("c1"));
    assert!(configuration_drift(&d, &id).is_empty());
}

#[test]
fn a_configuration_naming_a_lost_parameter_changes_nothing() {
    let mut d = doc();
    d["paramExtras"].as_object_mut().unwrap().insert(
        "configurations".into(),
        json!([{"id": "k", "name": "Old", "values": {"wall": "3", "gone": "1"}}]),
    );
    let before = d.clone();
    let e = apply_configuration(&mut d, "k").unwrap_err();
    assert!(e.contains("gone"), "{e}");
    assert_eq!(d, before);
}

#[test]
fn removing_a_group_ungroups_its_parameters() {
    let mut d = doc();
    remove_extra(&mut d, "groups", "g1");
    assert!(d["paramDefs"]["width"].get("group").is_none());
    assert_eq!(add_group(&mut d, "Fit"), "g1");
    assert_eq!(add_check(&mut d, "wall < 9", "ok", true), "k1");
}
