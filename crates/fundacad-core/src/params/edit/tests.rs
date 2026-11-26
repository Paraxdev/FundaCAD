use serde_json::{json, Map, Value};

use super::*;

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => panic!("not an object"),
    }
}

/// A table with a chain, a model parameter bound to an extrude, a legacy sketch reading `w` bare, a check and a
/// configuration.
fn doc() -> Map<String, Value> {
    obj(json!({
        "parameters": {"w": 12.5, "widths": 3, "h": 28, "d3": 28},
        "paramDefs": {
            "w": {"expr": "12.5", "value": 12.5, "unit": "mm", "comment": "outer"},
            "widths": {"expr": "3", "value": 3, "unit": "count"},
            "h": {"expr": "w * 2 + 3", "value": 28, "unit": "mm"},
            "d3": {"expr": "h", "value": 28, "unit": "mm", "target": {"kind": "feature", "feature": "e7", "field": "distance"}}
        },
        "paramExtras": {
            "checks": [{"id": "c1", "expr": "w > 4", "message": "too thin", "level": "warning"}],
            "configurations": [{"id": "k1", "name": "Big", "values": {"w": "20", "h": "w * 3"}}]
        },
        "features": [
            {"id": "s2", "type": "sketch", "name": "w", "plane": "XY", "entities": [
                {"type": "line", "id": "l1", "x1": "w", "y1": -4.5, "x2": 17, "y2": "widths"}
            ]},
            {"id": "e7", "type": "extrude", "sketch": "s2", "distance": 28, "operation": "new"}
        ]
    }))
}

#[test]
fn recompute_evaluates_the_chain_and_writes_cache_and_target() {
    let mut d = doc();
    d["paramDefs"]["w"]["expr"] = json!("7.25");
    let r = recompute(&mut d);
    assert_eq!(r, Recomputed::default());
    let mut want = doc();
    want["paramDefs"]["w"] = json!({"expr": "7.25", "value": 7.25, "unit": "mm", "comment": "outer"});
    want["paramDefs"]["h"]["value"] = json!(17.5);
    want["paramDefs"]["d3"]["value"] = json!(17.5);
    want["parameters"] = json!({"w": 7.25, "widths": 3, "h": 17.5, "d3": 17.5});
    want["features"][1]["distance"] = json!(17.5);
    assert_eq!(d, want);
}

#[test]
fn recompute_leaves_a_document_without_a_table_alone() {
    let mut d = obj(json!({"parameters": {"a": 3}, "features": []}));
    assert_eq!(recompute(&mut d), Recomputed::default());
    assert_eq!(d, obj(json!({"parameters": {"a": 3}, "features": []})));
}

#[test]
fn recompute_drops_an_orphan_model_parameter_and_keeps_a_read_one() {
    let mut d = doc();
    d["features"].as_array_mut().unwrap().pop();
    let r = recompute(&mut d);
    assert_eq!(r.issues, IndexMap::<String, String>::new());
    assert!(!d["paramDefs"].as_object().unwrap().contains_key("d3"));
    assert_eq!(d["parameters"], json!({"w": 12.5, "widths": 3, "h": 28}));

    let mut d = doc();
    d["features"].as_array_mut().unwrap().pop();
    d["paramDefs"]["widths"]["expr"] = json!("d3 + 1");
    let r = recompute(&mut d);
    assert_eq!(r.issues, IndexMap::from([("d3".to_owned(), TARGET_GONE.to_owned())]));
    assert_eq!(d["paramDefs"]["d3"]["value"], json!(28));
    assert_eq!(d["paramDefs"]["widths"]["value"], json!(29));
}

#[test]
fn recompute_reports_cycles_and_keeps_their_cache() {
    let mut d = doc();
    d["paramDefs"]["w"]["expr"] = json!("h - 1");
    let r = recompute(&mut d);
    let cycle = "circular reference".to_owned();
    assert_eq!(
        r.issues,
        IndexMap::from([("w".to_owned(), cycle.clone()), ("h".to_owned(), cycle.clone()), ("d3".to_owned(), cycle)])
    );
    assert_eq!(d["parameters"], json!({"w": 12.5, "widths": 3, "h": 28, "d3": 28}));
}

#[test]
fn recompute_writes_sketch_targets_and_names_each_sketch_once() {
    let mut d = obj(json!({
        "paramDefs": {
            "r": {"expr": "6.5", "value": 1, "unit": "mm"},
            "d1": {"expr": "r * 2", "value": 0, "unit": "mm", "target": {"kind": "constraint", "sketch": "s4", "constraint": "k2"}},
            "d2": {"expr": "r", "value": 0, "unit": "mm", "target": {"kind": "entity", "sketch": "s4", "entity": "p1", "field": "radius"}},
            "d3": {"expr": "r - 2.2", "value": 0, "unit": "count", "target": {"kind": "pattern", "sketch": "s9", "pattern": "q1", "field": "count"}},
            "d4": {"expr": "r", "value": 0, "unit": "mm", "target": {"kind": "entity", "sketch": "s4", "entity": "l1", "field": "x1"}}
        },
        "features": [
            {"id": "s4", "type": "sketch", "entities": [
                {"type": "polygon", "id": "p1", "x": 3, "y": -1, "radius": 2, "sides": 6},
                {"type": "line", "id": "l1", "x1": 0, "y1": 0, "x2": 1, "y2": 1}
            ], "constraints": [{"type": "distance", "id": "k2", "value": 4}]},
            {"id": "s9", "type": "sketch", "entities": [], "patterns": [{"type": "boltCircle", "id": "q1", "count": 2}]}
        ]
    }));
    let r = recompute(&mut d);
    assert_eq!(r.sketches, vec!["s4".to_owned(), "s9".to_owned()]);
    assert_eq!(d["features"][0]["constraints"][0]["value"], json!(13));
    assert_eq!(d["features"][0]["entities"][0]["radius"], json!(6.5));
    assert_eq!(d["features"][1]["patterns"][0]["count"], json!(4));
    // A line is solved geometry, no parameter owns its points, so its target is gone and d4 drops.
    assert_eq!(d["features"][0]["entities"][1]["x1"], json!(0));
    assert!(!d["paramDefs"].as_object().unwrap().contains_key("d4"));

    assert_eq!(recompute(&mut d).sketches, Vec::<String>::new());
}

#[test]
fn next_d_name_counts_past_the_highest() {
    assert_eq!(next_d_name(&Map::new()), "d1");
    assert_eq!(next_d_name(&obj(json!({"d4": {}}))), "d5");
    assert_eq!(next_d_name(&obj(json!({"d2": {}, "d17": {}, "dx": {}, "w": {}, "d07": {}}))), "d18");
}

#[test]
fn validate_name_refuses_each_kind_of_bad_name() {
    let defs = obj(doc()["paramDefs"].clone());
    let chars = "names are letters, digits and _ (not starting with a digit)".to_owned();
    assert_eq!(validate_name(&defs, "9lives"), Err(chars.clone()));
    assert_eq!(validate_name(&defs, ""), Err(chars.clone()));
    assert_eq!(validate_name(&defs, "a-b"), Err(chars));
    assert_eq!(validate_name(&defs, "sin"), Err("\"sin\" is a reserved name".to_owned()));
    assert_eq!(validate_name(&defs, "mm"), Err("\"mm\" is a reserved name".to_owned()));
    assert_eq!(validate_name(&defs, "constructor"), Err("\"constructor\" is a reserved name".to_owned()));
    assert_eq!(validate_name(&defs, "h"), Err("\"h\" already exists".to_owned()));
    assert_eq!(validate_name(&defs, "d12"), Err("dN names are reserved for model parameters".to_owned()));
    assert_eq!(validate_name(&defs, "d"), Ok(()));
    assert_eq!(validate_name(&defs, "d1x"), Ok(()));
    assert_eq!(validate_name(&defs, "lid_gap2"), Ok(()));
}

#[test]
fn references_to_lists_none_one_and_many() {
    let d = doc();
    assert_eq!(references_to(&d, "d3"), Vec::<String>::new());
    assert_eq!(references_to(&d, "h"), vec!["d3".to_owned()]);
    assert_eq!(
        references_to(&d, "w"),
        vec![
            "h".to_owned(),
            "check \"too thin\"".to_owned(),
            "configuration Big \u{b7} h".to_owned(),
            "line in s2 \u{b7} x1".to_owned(),
        ]
    );
}

#[test]
fn references_to_finds_bare_names_in_feature_fields_and_entry_lists() {
    let d = obj(json!({
        "paramDefs": {"gap": {"expr": "2", "value": 2, "unit": "mm"}},
        "features": [{"id": "m3", "type": "move", "dx": "gap", "name": "gap", "nodes": [
            {"id": "n2", "sx": "gap", "label": "x"}, {"sx": "gap"}
        ]}]
    }));
    assert_eq!(references_to(&d, "gap"), vec!["move m3 \u{b7} dx".to_owned(), "move m3 \u{b7} nodes.n2.sx".to_owned()]);
}

#[test]
fn add_param_appends_an_evaluated_row() {
    let mut d = doc();
    let r = add_param(&mut d, "lid", "h / 4 + 0.5", "mm").unwrap();
    assert_eq!(r, Recomputed::default());
    assert_eq!(d["paramDefs"]["lid"], json!({"expr": "h / 4 + 0.5", "value": 7.5, "unit": "mm"}));
    assert_eq!(d["paramDefs"].as_object().unwrap().keys().last().unwrap(), "lid");
    assert_eq!(d["parameters"]["lid"], json!(7.5));
}

#[test]
fn add_param_refuses_and_changes_nothing() {
    for (name, expr, unit, why) in [
        ("h", "1", "mm", "\"h\" already exists"),
        ("lid", "nope + 1", "mm", "unknown parameter \"nope\""),
        ("lid", "lid + 1", "mm", "unknown parameter \"lid\""),
        ("lid", "1", "inch", "\"inch\" is not a parameter unit"),
        ("lid", "1 / 0", "count", "does not evaluate to a finite number"),
    ] {
        let mut d = doc();
        assert_eq!(add_param(&mut d, name, expr, unit), Err(why.to_owned()), "{name} = {expr}");
        assert_eq!(d, doc());
    }
}

#[test]
fn add_param_seeds_the_table_from_plain_parameters() {
    let mut d = obj(json!({"parameters": {"a": 3, "b": 0.25}, "features": []}));
    add_param(&mut d, "c", "a + b", "deg").unwrap();
    assert_eq!(
        d,
        obj(json!({
            "parameters": {"a": 3, "b": 0.25, "c": 3.25},
            "features": [],
            "paramDefs": {
                "a": {"expr": "3", "value": 3, "unit": "mm"},
                "b": {"expr": "0.25", "value": 0.25, "unit": "mm"},
                "c": {"expr": "a + b", "value": 3.25, "unit": "deg"}
            }
        }))
    );
}

#[test]
fn set_param_expr_moves_dependents_and_the_bound_field() {
    let mut d = doc();
    set_param_expr(&mut d, "w", "max(4; 9.5)").unwrap();
    assert_eq!(d["paramDefs"]["w"]["expr"], json!("max(4; 9.5)"));
    assert_eq!(d["parameters"], json!({"w": 9.5, "widths": 3, "h": 22, "d3": 22}));
    assert_eq!(d["features"][1]["distance"], json!(22));
}

#[test]
fn set_param_expr_refuses_and_changes_nothing() {
    for (name, expr, why) in [
        ("w", "d3 + 1", "circular reference: w \u{2192} d3 \u{2192} h \u{2192} w"),
        ("w", "w * 2", "\"w\" cannot reference itself"),
        ("w", "2 +", "unexpected end of expression"),
        ("q", "1", "no parameter named \"q\""),
    ] {
        let mut d = doc();
        let got = set_param_expr(&mut d, name, expr);
        assert!(got.is_err(), "{name} = {expr}");
        if name != "w" || expr != "2 +" {
            assert_eq!(got, Err(why.to_owned()), "{name} = {expr}");
        }
        assert_eq!(d, doc());
    }
}

#[test]
fn set_param_comment_sets_and_clears() {
    let mut d = doc();
    set_param_comment(&mut d, "h", "inner height").unwrap();
    assert_eq!(d["paramDefs"]["h"]["comment"], json!("inner height"));
    set_param_comment(&mut d, "w", "").unwrap();
    assert_eq!(d["paramDefs"]["w"], json!({"expr": "12.5", "value": 12.5, "unit": "mm"}));
    assert_eq!(set_param_comment(&mut d, "q", "x"), Err("no parameter named \"q\"".to_owned()));
}

#[test]
fn rename_param_rewrites_every_reader_and_keeps_its_place() {
    let mut d = doc();
    rename_param(&mut d, "w", "wall").unwrap();
    let mut want = doc();
    want["paramDefs"] = json!({
        "wall": {"expr": "12.5", "value": 12.5, "unit": "mm", "comment": "outer"},
        "widths": {"expr": "3", "value": 3, "unit": "count"},
        "h": {"expr": "wall * 2 + 3", "value": 28, "unit": "mm"},
        "d3": {"expr": "h", "value": 28, "unit": "mm", "target": {"kind": "feature", "feature": "e7", "field": "distance"}}
    });
    want["parameters"] = json!({"wall": 12.5, "widths": 3, "h": 28, "d3": 28});
    want["paramExtras"] = json!({
        "checks": [{"id": "c1", "expr": "wall > 4", "message": "too thin", "level": "warning"}],
        "configurations": [{"id": "k1", "name": "Big", "values": {"wall": "20", "h": "wall * 3"}}]
    });
    want["features"][0]["entities"][0]["x1"] = json!("wall");
    assert_eq!(d, want);
}

#[test]
fn rename_param_to_its_own_name_changes_nothing() {
    let mut d = doc();
    assert_eq!(rename_param(&mut d, "h", "h"), Ok(Recomputed::default()));
    assert_eq!(d, doc());
}

#[test]
fn rename_param_refuses_and_changes_nothing() {
    for (from, to, why) in [
        ("w", "h", "\"h\" already exists"),
        ("w", "d9", "dN names are reserved for model parameters"),
        ("w", "2w", "names are letters, digits and _ (not starting with a digit)"),
        ("q", "r", "no parameter named \"q\""),
    ] {
        let mut d = doc();
        assert_eq!(rename_param(&mut d, from, to), Err(why.to_owned()), "{from} to {to}");
        assert_eq!(d, doc());
    }
}

#[test]
fn delete_param_is_refused_while_read() {
    let mut d = doc();
    assert_eq!(
        delete_param(&mut d, "w"),
        Err("\"w\" is referenced by: h, check \"too thin\", configuration Big \u{b7} h, line in s2 \u{b7} x1".to_owned())
    );
    assert_eq!(delete_param(&mut d, "q"), Err("no parameter \"q\"".to_owned()));
    assert_eq!(d, doc());
}

#[test]
fn delete_param_drops_the_row_and_what_configurations_set() {
    let mut d = doc();
    d["paramExtras"]["configurations"][0]["values"]["widths"] = json!("5");
    d["features"][0]["entities"][0]["y2"] = json!(1.5);
    delete_param(&mut d, "widths").unwrap();
    let mut want = doc();
    want["features"][0]["entities"][0]["y2"] = json!(1.5);
    want["paramDefs"].as_object_mut().unwrap().shift_remove("widths");
    want["parameters"] = json!({"w": 12.5, "h": 28, "d3": 28});
    assert_eq!(d, want);
    assert_eq!(d["paramDefs"].as_object().unwrap().keys().collect::<Vec<_>>(), ["w", "h", "d3"]);
}

#[test]
fn check_expr_evaluates_without_changing_anything() {
    let d = doc();
    assert_eq!(check_expr(&d, Some("w"), "h / 7"), Err("circular reference: w \u{2192} h \u{2192} w".to_owned()));
    assert_eq!(check_expr(&d, Some("widths"), "h / 7"), Ok(4.0));
    assert_eq!(check_expr(&d, None, "w - 13"), Ok(-0.5));
    assert_eq!(check_expr(&obj(json!({"parameters": {"a": 2.5}})), None, "a * 3"), Ok(7.5));
}

#[test]
fn table_seeds_from_plain_parameters_only_when_there_is_no_table() {
    assert_eq!(table(&doc()), obj(doc()["paramDefs"].clone()));
    assert_eq!(
        table(&obj(json!({"parameters": {"a": -2, "b": "x"}}))),
        obj(json!({"a": {"expr": "-2", "value": -2, "unit": "mm"}}))
    );
    assert_eq!(table(&obj(json!({"features": []}))), Map::new());
}
