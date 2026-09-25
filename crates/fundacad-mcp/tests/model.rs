//! The document an agent edits: ids, the timeline, and the parameter table.
//! A port of the Python MCP server's `test_model.py`.
//!
//! The property worth the most here is that a REFUSED edit changes nothing. An
//! agent works by trying things, and a tool that half-applies a bad edit leaves
//! it debugging a document it did not write.

use fundacad_mcp::model as m;
use serde_json::{json, Value};

fn doc_with(features: &[Value]) -> m::Doc {
    let mut d = m::new_document();
    for f in features {
        m::add_feature(&mut d, f, None).expect("the fixtures are well formed");
    }
    d
}

fn params(d: &m::Doc) -> Value {
    d.get("parameters").cloned().unwrap_or(Value::Null)
}

// --- the timeline ------------------------------------------------------------

#[test]
fn ids_are_assigned_by_type_and_are_unique() {
    let d = doc_with(&[
        json!({"type": "box", "length": 1, "width": 1, "height": 1}),
        json!({"type": "box", "length": 2, "width": 2, "height": 2}),
        json!({"type": "fillet", "edges": [], "radius": 1}),
    ]);
    assert_eq!(m::feature_ids(&d), ["bx1", "bx2", "fil1"]);
}

#[test]
fn an_explicit_id_is_kept_and_a_duplicate_is_refused() {
    let mut d = doc_with(&[json!({"id": "hub", "type": "cylinder", "radius": 1, "height": 1})]);
    assert_eq!(m::feature_ids(&d), ["hub"]);
    let again = m::add_feature(
        &mut d,
        &json!({"id": "hub", "type": "box", "length": 1, "width": 1, "height": 1}),
        None,
    );
    assert!(again.is_err(), "a duplicate id was accepted");
    assert_eq!(
        m::feature_ids(&d),
        ["hub"],
        "the refused add still changed the document"
    );
}

#[test]
fn insert_and_move_put_a_feature_where_asked() {
    let mut d = doc_with(&[
        json!({"id": "a", "type": "box", "length": 1, "width": 1, "height": 1}),
        json!({"id": "c", "type": "box", "length": 1, "width": 1, "height": 1}),
    ]);
    m::add_feature(
        &mut d,
        &json!({"id": "b", "type": "box", "length": 1, "width": 1, "height": 1}),
        Some(1),
    )
    .unwrap();
    assert_eq!(m::feature_ids(&d), ["a", "b", "c"]);
    m::move_feature(&mut d, "b", 2).unwrap();
    assert_eq!(m::feature_ids(&d), ["a", "c", "b"]);
}

#[test]
fn a_patch_merges_and_a_null_removes() {
    let mut d = doc_with(&[json!({"id": "pp", "type": "press-pull", "face": {},
                                  "distance": 2, "operation": "join",
                                  "upTo": {"kind": "face"}})]);
    m::update_feature(&mut d, "pp", &json!({"distance": 5}), false).unwrap();
    let f = &m::features(&d)[0];
    assert_eq!(f["distance"], json!(5));
    assert!(
        f.get("upTo").is_some(),
        "a merge must not drop fields it was not given"
    );
    m::update_feature(&mut d, "pp", &json!({"upTo": null}), false).unwrap();
    assert!(
        m::features(&d)[0].get("upTo").is_none(),
        "a null in a patch has to remove the field"
    );
}

#[test]
fn replace_swaps_the_body_but_keeps_the_id() {
    let mut d = doc_with(&[json!({"id": "pp", "type": "press-pull", "face": {},
                                  "distance": 2, "operation": "join",
                                  "upTo": {"kind": "face"}})]);
    m::update_feature(
        &mut d,
        "pp",
        &json!({"type": "press-pull", "face": {}, "distance": 1, "operation": "cut"}),
        true,
    )
    .unwrap();
    let f = &m::features(&d)[0];
    assert_eq!(f["id"], json!("pp"));
    assert!(f.get("upTo").is_none());
    assert_eq!(f["operation"], json!("cut"));
}

fn chute() -> m::Doc {
    doc_with(&[
        json!({"id": "bx", "type": "box", "length": 20, "width": 20, "height": 10}),
        json!({"id": "chute_edges", "type": "fillet", "radius": 1,
               "edges": {"kind": "edge", "by": "all", "body": "body1"}}),
    ])
}

#[test]
fn a_patch_can_change_the_type_when_the_new_fields_come_with_it() {
    let mut d = chute();
    m::update_feature(
        &mut d,
        "chute_edges",
        &json!({"type": "chamfer", "distance": 0.8, "radius": null}),
        false,
    )
    .unwrap();
    let f = &m::features(&d)[1];
    assert_eq!(f["type"], json!("chamfer"));
    assert_eq!(f["distance"], json!(0.8));
    assert!(f.get("radius").is_none(), "the null had to remove radius");
    assert_eq!(f["edges"]["by"], json!("all"), "the edges carry over");
}

#[test]
fn a_type_change_missing_the_new_types_fields_is_refused_and_changes_nothing() {
    let mut d = chute();
    let before = m::features(&d).to_vec();
    let e = m::update_feature(
        &mut d,
        "chute_edges",
        &json!({"type": "chamfer", "radius": null}),
        false,
    )
    .expect_err("a chamfer with no distance was accepted");
    assert!(e.0.contains("distance"), "{e}");
    assert!(e.0.contains("chamfer"), "{e}");
    assert_eq!(m::features(&d), &before[..], "the refused update still changed the document");

    let e = m::update_feature(
        &mut d,
        "chute_edges",
        &json!({"type": "press-pull"}),
        false,
    )
    .expect_err("a press-pull with no face or distance was accepted");
    assert!(e.0.contains("face") && e.0.contains("distance"), "{e}");
    assert_eq!(m::features(&d), &before[..]);
}

#[test]
fn a_replace_that_changes_the_type_is_checked_against_the_new_type() {
    let mut d = chute();
    let e = m::update_feature(
        &mut d,
        "chute_edges",
        &json!({"type": "chamfer", "edges": {"kind": "edge", "by": "all", "body": "body1"}}),
        true,
    )
    .expect_err("a chamfer with no distance was accepted");
    assert!(e.0.contains("distance"), "{e}");
    m::update_feature(
        &mut d,
        "chute_edges",
        &json!({"type": "chamfer", "distance": 1,
                "edges": {"kind": "edge", "by": "all", "body": "body1"}}),
        true,
    )
    .unwrap();
    assert_eq!(m::features(&d)[1]["type"], json!("chamfer"));
}

#[test]
fn a_field_a_core_feature_does_not_read_is_refused_and_changes_nothing() {
    let mut d = chute();
    let before = m::features(&d).to_vec();
    let e = m::add_feature(
        &mut d,
        &json!({"type": "move", "dx": 5, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "targets": ["body1"]}),
        None,
    )
    .expect_err("a move with targets was accepted");
    assert!(e.0.contains("\"targets\"") && e.0.contains("\"bodies\""), "{e}");
    assert_eq!(m::features(&d), &before[..]);

    let e = m::update_feature(&mut d, "chute_edges", &json!({"radious": 2}), false)
        .expect_err("a misspelt radius was accepted");
    assert!(e.0.contains("\"radious\"") && e.0.contains("fillet"), "{e}");
    let e = m::update_feature(
        &mut d,
        "bx",
        &json!({"type": "box", "length": 1, "width": 1, "height": 1, "depth": 3}),
        true,
    )
    .expect_err("a replace with an unread field was accepted");
    assert!(e.0.contains("\"depth\""), "{e}");
    assert_eq!(m::features(&d), &before[..]);
}

#[test]
fn a_label_a_plugin_field_and_a_field_already_there_are_not_refused() {
    let mut d = chute();
    m::add_feature(&mut d, &json!({"id": "b2", "type": "box", "length": 1, "width": 1, "height": 1, "name": "Lid"}), None)
        .expect("any feature may carry a name");
    m::add_feature(
        &mut d,
        &json!({"type": "elephantFootChamfer", "size": 0.4, "anyPluginKey": 1}),
        None,
    )
    .expect("a plugin's feature is not checked here");
    d.get_mut("features").expect("features")[0]["futureField"] = json!(true);
    m::update_feature(&mut d, "bx", &json!({"length": 30}), false)
        .expect("a field from a newer build that this patch did not send stays");
    assert_eq!(m::features(&d)[0]["futureField"], json!(true));
}

#[test]
fn a_mirror_that_names_bodies_writes_its_plane_as_a_name_object() {
    let mut d = chute();
    m::add_feature(&mut d, &json!({"id": "m1", "type": "mirror", "plane": "YZ", "bodies": ["body1"]}), None).unwrap();
    m::add_feature(&mut d, &json!({"id": "m2", "type": "mirror", "plane": "XZ"}), None).unwrap();
    let f = |d: &m::Doc, id: &str| m::features(d).iter().find(|f| f["id"] == id).cloned().unwrap();
    assert_eq!(f(&d, "m1")["plane"], json!({"name": "YZ"}));
    assert_eq!(f(&d, "m2")["plane"], json!("XZ"), "without bodies the old form stays");
    m::update_feature(&mut d, "m2", &json!({"bodies": ["body1"]}), false).unwrap();
    assert_eq!(f(&d, "m2")["plane"], json!({"name": "XZ"}));
    m::update_feature(&mut d, "m1", &json!({"plane": "XY"}), false).unwrap();
    assert_eq!(f(&d, "m1")["plane"], json!({"name": "XY"}));
}

// --- parameters --------------------------------------------------------------

#[test]
fn a_parameter_table_evaluates_in_dependency_order() {
    let mut d = m::new_document();
    m::set_parameter(&mut d, "hub_d", &json!(54), "mm", None).unwrap();
    m::set_parameter(&mut d, "wall", &json!(2.4), "mm", None).unwrap();
    m::set_parameter(&mut d, "hub_r", &json!("hub_d/2 - wall"), "mm", None).unwrap();
    assert_eq!(
        params(&d),
        json!({"hub_d": 54.0, "hub_r": 24.6, "wall": 2.4})
    );
}

#[test]
fn the_derived_cache_is_rewritten_when_a_dependency_changes() {
    // The cache is the interface to the engine, which has no evaluator. A
    // dependent left at its old number is a document that builds at a dimension
    // nobody asked for.
    let mut d = m::new_document();
    m::set_parameter(&mut d, "hub_d", &json!(54), "mm", None).unwrap();
    m::set_parameter(&mut d, "hub_r", &json!("hub_d/2"), "mm", None).unwrap();
    m::set_parameter(&mut d, "hub_d", &json!(60), "mm", None).unwrap();
    assert_eq!(params(&d)["hub_r"], json!(30.0));
    assert_eq!(
        m::param_defs(&d)["hub_r"]["expr"],
        json!("hub_d/2"),
        "the expression must survive the edit"
    );
}

#[test]
fn a_bad_definition_is_refused_and_leaves_the_table_as_it_was() {
    let mut d = m::new_document();
    m::set_parameter(&mut d, "a", &json!(3), "mm", None).unwrap();
    let before = params(&d);
    let out = m::set_parameter(&mut d, "b", &json!("a + nope"), "mm", None);
    assert!(out.is_err(), "an expression naming nothing was accepted");
    assert!(
        !m::param_defs(&d).contains_key("b"),
        "the refused definition was left behind"
    );
    assert_eq!(params(&d), before);
}

#[test]
fn a_cycle_in_a_loaded_file_is_named_rather_than_looped_on() {
    // set_parameter cannot create a cycle (each name must already resolve), but
    // a hand-edited file can carry one, and the recompute has to terminate and
    // say which parameters are in it.
    let mut d = m::new_document();
    d.insert(
        "paramDefs".into(),
        json!({"x": {"expr": "y + 1", "value": 0, "unit": "mm"},
               "y": {"expr": "x + 1", "value": 0, "unit": "mm"},
               "ok": {"expr": "7", "value": 0, "unit": "mm"}}),
    );
    let issues = m::recompute_parameters(&mut d);
    let named: Vec<&String> = issues.keys().collect();
    assert_eq!(named, ["x", "y"], "{issues:?}");
    assert!(issues["x"].contains("cycle"), "{}", issues["x"]);
    assert_eq!(
        params(&d)["ok"],
        json!(7.0),
        "one bad definition must not take the table down"
    );
}

#[test]
fn a_parameter_still_in_use_cannot_be_removed() {
    let mut d = m::new_document();
    m::set_parameter(&mut d, "a", &json!(3), "mm", None).unwrap();
    m::set_parameter(&mut d, "b", &json!("a * 2"), "mm", None).unwrap();
    let out = m::remove_parameter(&mut d, "a");
    let Err(e) = out else {
        panic!("a parameter with a dependent was removed");
    };
    assert!(e.0.contains('b'), "{}", e.0);
    assert!(m::param_defs(&d).contains_key("a"));
}

#[test]
fn redefining_a_parameter_keeps_how_the_panel_shows_it() {
    // The app's parameters panel stores a control, a group and a hidden flag on
    // the definition. An agent changing the VALUE must not strip them, the
    // slider would quietly turn back into a text box.
    let mut d = m::new_document();
    m::set_parameter(&mut d, "rings", &json!(22), "count", None).unwrap();
    {
        let defs = d.get_mut("paramDefs").unwrap().as_object_mut().unwrap();
        let rings = defs.get_mut("rings").unwrap().as_object_mut().unwrap();
        rings.insert(
            "control".into(),
            json!({"kind": "slider", "min": 1, "max": 40}),
        );
        rings.insert("group".into(), json!("g1"));
        rings.insert("hidden".into(), json!(true));
    }
    m::set_parameter(&mut d, "rings", &json!(30), "count", None).unwrap();
    let kept = m::param_defs(&d)["rings"].clone();
    assert_eq!(kept["control"], json!({"kind": "slider", "min": 1, "max": 40}));
    assert_eq!(kept["group"], json!("g1"));
    assert_eq!(kept["hidden"], json!(true));
    assert_eq!(kept["value"], json!(30.0));
}

#[test]
fn a_check_blocks_a_removal_and_a_configuration_entry_goes_with_it() {
    let mut d = m::new_document();
    m::set_parameter(&mut d, "gap", &json!(0.5), "mm", None).unwrap();
    m::set_parameter(&mut d, "rings", &json!(22), "count", None).unwrap();
    d.insert(
        "paramExtras".into(),
        json!({
            "checks": [{"id": "k1", "expr": "gap >= 0.3", "message": "gap too small",
                        "level": "warning"}],
            "configurations": [{"id": "c1", "name": "Dense", "values": {"rings": "30"}}]
        }),
    );
    let out = m::remove_parameter(&mut d, "gap");
    let Err(e) = out else {
        panic!("a parameter a check reads was removed");
    };
    assert!(e.0.contains("gap too small"), "{}", e.0);
    m::remove_parameter(&mut d, "rings").unwrap();
    assert_eq!(
        d["paramExtras"]["configurations"][0]["values"],
        json!({}),
        "{:?}",
        d.get("paramExtras")
    );
}

#[test]
fn a_reserved_name_is_refused() {
    let mut d = m::new_document();
    for name in ["sin", "mm", "PI"] {
        assert!(
            m::set_parameter(&mut d, name, &json!(1), "mm", None).is_err(),
            "{name} was accepted as a parameter name"
        );
    }
}

// --- validation --------------------------------------------------------------

#[test]
fn a_reference_to_a_missing_sketch_is_reported() {
    let mut d = doc_with(&[json!({"id": "ex1", "type": "extrude", "sketch": "nope",
                                  "distance": 1, "operation": "new"})]);
    let problems = m::validate(&mut d);
    assert!(
        problems.iter().any(|p| p.contains("nope")),
        "{problems:?}"
    );
}

#[test]
fn a_reference_pointing_down_the_timeline_is_reported() {
    // A feature can only use what is above it. This one builds to an error deep
    // in the engine with no explanation, so it is worth catching here.
    let mut d = m::new_document();
    m::add_feature(
        &mut d,
        &json!({"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": 1,
                "operation": "new"}),
        None,
    )
    .unwrap();
    m::add_feature(
        &mut d,
        &json!({"id": "sk1", "type": "sketch", "plane": "XY", "entities": []}),
        None,
    )
    .unwrap();
    let problems = m::validate(&mut d);
    assert!(
        problems.iter().any(|p| p.contains("AFTER")),
        "{problems:?}"
    );
}

#[test]
fn a_correct_document_reports_nothing() {
    // The control. A validator that flagged something on a healthy document
    // would be noise an agent learns to ignore.
    let mut d = m::new_document();
    m::set_parameter(&mut d, "h", &json!(12), "mm", None).unwrap();
    m::add_feature(
        &mut d,
        &json!({"id": "sk1", "type": "sketch", "plane": "XY",
                "entities": [{"id": "c", "type": "circle", "radius": 5}]}),
        None,
    )
    .unwrap();
    m::add_feature(
        &mut d,
        &json!({"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": "h",
                "operation": "new"}),
        None,
    )
    .unwrap();
    assert_eq!(m::validate(&mut d), Vec::<String>::new());
}

#[test]
fn a_string_in_a_numeric_field_must_name_a_parameter() {
    let mut d = m::new_document();
    m::add_feature(
        &mut d,
        &json!({"id": "bx1", "type": "box", "length": "wide", "width": 1, "height": 1}),
        None,
    )
    .unwrap();
    let problems = m::validate(&mut d);
    assert!(problems.iter().any(|p| p.contains("wide")), "{problems:?}");
    m::set_parameter(&mut d, "wide", &json!(40), "mm", None).unwrap();
    assert_eq!(m::validate(&mut d), Vec::<String>::new());
}

#[test]
fn a_plugin_features_text_options_are_not_mistaken_for_parameters() {
    let mut d = m::new_document();
    let face = json!({"kind": "face", "by": "nearest", "point": [0, 0, 13], "body": "body1"});
    m::add_feature(
        &mut d,
        &json!({"id": "td1", "type": "teardropHole", "faces": face, "angle": 45,
                "roof": "pointed", "buildDir": "+Z"}),
        None,
    )
    .unwrap();
    assert_eq!(m::validate(&mut d), Vec::<String>::new());
    m::update_feature(&mut d, "td1", &json!({"angle": "lean"}), false).unwrap();
    let problems = m::validate(&mut d);
    assert!(problems.iter().any(|p| p.contains("'lean'")), "{problems:?}");
}

#[test]
fn a_joints_body_id_and_mode_are_not_mistaken_for_parameters() {
    // `moving` names a body and `mode` is an enum, neither is a numeric field,
    // so a healthy joint reports nothing. The control: `offset` IS numeric, so
    // a string there that names no parameter still flags, the rule is not
    // switched off for the whole feature.
    fn face(p: [f64; 3], body: &str) -> Value {
        json!({"kind": "face", "by": "nearest", "point": p, "body": body})
    }
    fn boxes() -> m::Doc {
        doc_with(&[
            json!({"id": "a", "type": "box", "length": 20, "width": 20, "height": 20}),
            json!({"id": "b", "type": "box", "length": 6, "width": 6, "height": 6}),
        ])
    }
    let joint = json!({"id": "j", "type": "joint", "moving": "body2", "mode": "revolute",
                       "mate": {"body": "body2", "face": face([50.0, 0.0, -3.0], "body2")},
                       "to": {"body": "body1", "face": face([0.0, 0.0, 10.0], "body1")}});

    let mut d = boxes();
    m::add_feature(&mut d, &joint, None).unwrap();
    assert_eq!(m::validate(&mut d), Vec::<String>::new());

    let mut d2 = boxes();
    let mut with_offset = joint.as_object().unwrap().clone();
    with_offset.insert("offset".into(), json!("nope"));
    m::add_feature(&mut d2, &Value::Object(with_offset), None).unwrap();
    let problems = m::validate(&mut d2);
    assert!(
        problems
            .iter()
            .any(|p| p.contains("offset") && p.contains("nope")),
        "{problems:?}"
    );
}

#[test]
fn text_fields_are_not_mistaken_for_parameters() {
    // A STEP import carries its colour and a G2 fillet its continuity as text;
    // both built fine and were reported as problems that WILL fail a build.
    let mut d = m::new_document();
    m::add_feature(
        &mut d,
        &json!({"id": "f1", "type": "import", "format": "step", "name": "Imported", "geom": "abc",
                "source": "a.step", "solid": true, "color": "#3f0276"}),
        None,
    )
    .unwrap();
    m::add_feature(
        &mut d,
        &json!({"id": "fil1", "type": "fillet", "edges": [], "radius": 1, "continuity": "G2",
                "sizeType": "chord"}),
        None,
    )
    .unwrap();
    assert_eq!(m::validate(&mut d), Vec::<String>::new());
}

#[test]
fn hole_enum_fields_are_not_mistaken_for_parameters() {
    let mut d = m::new_document();
    m::add_feature(
        &mut d,
        &json!({
            "id": "ho1",
            "type": "hole",
            "holeType": "simple",
            "standard": "custom",
            "size": "M3",
            "fit": "normal",
            "extent": "blind",
            "diameter": 3.3,
            "depth": 10.1
        }),
        None,
    )
    .unwrap();
    assert_eq!(m::validate(&mut d), Vec::<String>::new());
}

#[test]
fn a_feature_turned_into_a_join_forgets_the_id_it_had_as_a_new_body() {
    let mut d = m::new_document();
    m::add_feature(&mut d, &json!({"id": "rv", "type": "revolve", "sketch": "s", "axis": "Z",
                                   "angle": 360, "operation": "new"}), None)
        .unwrap();
    d.insert("bodyIds".into(), json!({"bx:0": "body1", "rv:0": "body3"}));
    m::update_feature(&mut d, "rv", &json!({"angle": 180}), false).unwrap();
    assert_eq!(d["bodyIds"], json!({"bx:0": "body1", "rv:0": "body3"}));
    m::update_feature(&mut d, "rv", &json!({"operation": "join", "targets": ["body1"]}), false)
        .unwrap();
    assert_eq!(d["bodyIds"], json!({"bx:0": "body1"}));
}

#[test]
fn a_press_pull_label_that_contradicts_its_sign_is_named() {
    fn push(id: &str, distance: Value, op: &str) -> Value {
        json!({"id": id, "type": "press-pull", "distance": distance, "operation": op,
               "face": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}})
    }
    let mut d = doc_with(&[
        json!({"id": "bx", "type": "box", "length": 20, "width": 20, "height": 20}),
        push("deeper", json!(-5.85), "cut"),
        push("taller", json!(2), "join"),
    ]);
    m::set_parameter(&mut d, "depth", &json!(-3), "mm", None).unwrap();
    m::add_feature(&mut d, &push("named", json!("depth"), "cut"), None).unwrap();
    assert_eq!(m::validate(&mut d), Vec::<String>::new());

    m::add_feature(&mut d, &push("wrong", json!(4), "cut"), None).unwrap();
    m::add_feature(&mut d, &push("wrong_named", json!("depth"), "join"), None).unwrap();
    let problems = m::validate(&mut d);
    assert_eq!(problems.len(), 2, "{problems:?}");
    assert!(problems[0].starts_with("wrong: operation is 'cut' but distance 4"), "{problems:?}");
    assert!(problems[0].contains("`mode`"), "{problems:?}");
    assert!(problems[1].starts_with("wrong_named: operation is 'join'"), "{problems:?}");
}

#[test]
fn a_build_completes_only_the_tracked_faces_written_without_an_extent() {
    let hole = |id: &str, face: Value| {
        json!({"id": id, "type": "hole", "diameter": 3, "points": [[0, 0, 5]], "face": face})
    };
    let tracked = json!({"kind": "face", "by": "tracked", "point": [0, 0, 5], "normal": [0, 0, 1]});
    let mut kept = tracked.clone();
    kept["extent"] = json!([-9, 9, -9, 9]);
    let mut older = tracked.clone();
    older["center"] = json!([0, 0, 5]);
    let near = json!({"kind": "face", "by": "nearest", "point": [0, 0, 5]});
    let mut d = doc_with(&[
        json!({"id": "bx", "type": "box", "length": 10, "width": 10, "height": 10}),
        hole("a", tracked),
        hole("b", kept),
        hole("c", near.clone()),
        hole("d", older.clone()),
    ]);
    let extent = json!({"extent": [-5.0, 5.0, -5.0, 5.0], "point": [0.0, 0.0, 5.0], "points": [[0.0, 0.0, 5.0]]});
    let tracked_faces = json!({"a": extent, "b": extent, "c": extent, "d": extent});
    m::write_tracked_faces(&mut d, tracked_faces.as_object().unwrap());
    let face = |id: &str| m::find_feature(&d, id).unwrap().1["face"].clone();
    assert_eq!(face("a")["extent"], json!([-5.0, 5.0, -5.0, 5.0]));
    assert_eq!(face("b")["extent"], json!([-9, 9, -9, 9]), "a written extent is the author's");
    assert_eq!(face("c"), near, "only a tracked face takes one");
    assert_eq!(face("d"), older, "a centre written by the older form keeps that form");
}
