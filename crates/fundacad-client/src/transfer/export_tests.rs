use super::export::*;
use serde_json::{json, Map, Value};

fn names(pairs: &[(&'static str, &'static str)]) -> Vec<NamedBody<'static>> {
    pairs.iter().map(|(id, name)| NamedBody { id, name }).collect()
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn scope_follows_the_selection() {
    let bodies = names(&[("body1", "Base"), ("body2", "Lid"), ("body3", "Hinge")]);
    let groups = vec![TreeGroup {
        label: "Case".into(),
        bodies: ids(&["body1"]),
        children: vec![TreeGroup { label: "Top".into(), bodies: ids(&["body2", "body3"]), children: vec![] }],
    }];
    let none = scope_from_selection(&[], &bodies, &groups, "printer");
    assert_eq!(none, ExportStart { scope: BodyScope::All, selected: vec![], base: "printer".into() });

    let one = scope_from_selection(&ids(&["body2", "gone"]), &bodies, &groups, "printer");
    assert_eq!(one.scope, BodyScope::Body("body2".into()));
    assert_eq!(one.base, "Lid");

    let folder = scope_from_selection(&ids(&["body3", "body2"]), &bodies, &groups, "printer");
    assert_eq!(folder.scope, BodyScope::Selected);
    assert_eq!(folder.selected, ids(&["body2", "body3"]), "build order, not click order");
    assert_eq!(folder.base, "Top");

    let mixed = scope_from_selection(&ids(&["body1", "body3"]), &bodies, &groups, "printer");
    assert_eq!(mixed.base, "printer");
    let whole = scope_from_selection(&ids(&["body1", "body2", "body3"]), &bodies, &groups, "printer");
    assert_eq!(whole.base, "Case");
}

#[test]
fn refinement_presets_and_custom_values() {
    let mut s = ExportSettings::default();
    s.pick_refinement(Refinement::High);
    assert_eq!(s.faceting.surface_deviation, 0.005);
    s.set_faceting(0.02, |f| &mut f.surface_deviation);
    assert_eq!(s.refinement, Refinement::Custom);
    s.set_faceting(5.0, |f| &mut f.normal_deviation);
    assert_eq!(s.refinement, Refinement::Custom);
    s.set_faceting(15.0, |f| &mut f.normal_deviation);
    assert_eq!(s.refinement, Refinement::Medium);
    s.set_faceting(f64::NAN, |f| &mut f.normal_deviation);
    assert_eq!(s.faceting.normal_deviation, 15.0);
    s.pick_refinement(Refinement::Custom);
    assert!(s.show_advanced);
}

#[test]
fn saved_settings_read_back_clamped() {
    let s = ExportSettings::parse(Some(
        r#"{"format":"3mf","unit":"in","binary":false,"faceting":{"surfaceDeviation":50,"normalDeviation":0.1},
            "showAdvanced":true,"tolerance":7}"#,
    ));
    assert_eq!(s.format, ExportFormat::ThreeMf);
    assert_eq!(s.unit, "in");
    assert!(!s.binary && s.show_advanced);
    assert_eq!(s.faceting, Faceting { surface_deviation: 10.0, normal_deviation: 0.5, max_edge_length: 0.0 });
    assert_eq!(s.refinement, Refinement::Custom);
    assert_eq!(s.tolerance, 1.0);

    let junk = ExportSettings::parse(Some(r#"{"format":"obj","unit":"yd","binary":"no","faceting":3}"#));
    assert_eq!(junk, ExportSettings { binary: true, ..ExportSettings::default() });
    assert_eq!(ExportSettings::parse(Some("not json")), ExportSettings::default());
    assert_eq!(ExportSettings::parse(None), ExportSettings::default());

    let back = ExportSettings::parse(Some(&s.to_json()));
    assert_eq!(back, s);
}

#[test]
fn a_flat_export_keeps_the_last_3d_format() {
    let before = ExportSettings { format: ExportFormat::Step, ..Default::default() };
    let svg = ExportSettings { format: ExportFormat::Svg, tolerance: 0.2, ..Default::default() };
    let kept = svg.remembered(&before);
    assert_eq!(kept.format, ExportFormat::Step);
    assert_eq!(kept.tolerance, 0.2);
}

fn start(sel: &[&str]) -> ExportStart {
    ExportStart { scope: BodyScope::Selected, selected: ids(sel), base: "x".into() }
}

#[test]
fn export_fields_carry_scope_mesh_and_colours() {
    let s = ExportSettings { format: ExportFormat::ThreeMf, unit: "cm", ..Default::default() };
    let palette = json!([{"name": "Red", "color": "#f00"}]);
    let colors = json!({"body1": 0});
    let m = export_fields(
        &s,
        &BodyScope::SelectedSeparate,
        &start(&["body2", "body4"]),
        None,
        "C:/out/a.3mf",
        Some(Colors { palette: &palette, body_colors: &colors }),
    );
    assert_eq!(
        Value::Object(m),
        json!({
            "format": "3mf", "path": "C:/out/a.3mf", "separate": true, "bodies": ["body2", "body4"],
            "palette": palette, "bodyColors": colors,
            "mesh": {"unit": "cm", "binary": true, "surfaceDeviation": 0.02, "normalDeviation": 15.0, "maxEdgeLength": 0.0},
        })
    );

    let step = ExportSettings { format: ExportFormat::Step, ..Default::default() };
    let m = export_fields(&step, &BodyScope::Body("body3".into()), &start(&["body3"]), None, "p.step", None);
    assert_eq!(Value::Object(m), json!({"format": "step", "path": "p.step", "body": "body3"}));
    let m = export_fields(&step, &BodyScope::Separate, &start(&[]), None, "p.step", None);
    assert_eq!(m.get("separate"), Some(&json!(true)));
    assert!(!m.contains_key("bodies") && !m.contains_key("body"));
}

#[test]
fn a_flat_export_draws_its_source_and_ignores_the_scope() {
    let s = ExportSettings { format: ExportFormat::Dxf, tolerance: 5.0, ..Default::default() };
    let face = FlatSource::Face { face: json!({"body": "body1", "face": 4}), plane: json!("XY"), label: "Top".into() };
    let m = export_fields(&s, &BodyScope::Body("body1".into()), &start(&[]), Some(&face), "t.dxf", None);
    assert_eq!(
        Value::Object(m),
        json!({"format": "dxf", "path": "t.dxf", "face": {"body": "body1", "face": 4}, "plane": "XY", "tolerance": 1.0})
    );
    let sk = FlatSource::Sketch { sketch: "f3".into(), label: "Plate".into() };
    let svg = ExportSettings { format: ExportFormat::Svg, ..Default::default() };
    let m = export_fields(&svg, &BodyScope::All, &start(&[]), Some(&sk), "t.svg", None);
    assert_eq!(m.get("sketch"), Some(&json!("f3")));
    assert_eq!(sk.label(), "Plate");
}

#[test]
fn file_names_are_safe_and_stamped() {
    let now = Stamp { year: 2026, month: 3, day: 7, hour: 9, minute: 4, second: 5 };
    assert_eq!(export_file_name("bracket", "stl", now), "bracket_20260307090405.stl");
    assert_eq!(export_file_name("a<b>:c\"d/e\\f|g?h*\u{1}. .", "step", now), "a_b__c_d_e_f_g_h___20260307090405.step");
    assert_eq!(export_file_name("  ", "3mf", now), "part_20260307090405.3mf");
    assert_eq!(export_dir_of("C:\\out\\a.stl"), Some("C:\\out"));
    assert_eq!(export_dir_of("/a.stl"), None);
    assert_eq!(export_dir_of("a.stl"), None);
}

#[test]
fn formats_by_path_and_kind() {
    assert_eq!(format_of_path("x/y.GLB"), ExportFormat::Glb);
    assert_eq!(format_of_path("x/y.stp"), ExportFormat::Step);
    assert_eq!(format_of_path("x/y"), ExportFormat::Step);
    assert!(ExportFormat::Glb.is_mesh() && !ExportFormat::Glb.takes_unit());
    assert!(ExportFormat::Svg.is_flat() && !ExportFormat::Step.is_mesh());
    assert_eq!(ExportFormat::Step.ext(), "step");
}

#[test]
fn replies_list_written_files_and_failed_features() {
    let r = |v: Value| -> Map<String, Value> { v.as_object().unwrap().clone() };
    assert_eq!(written_paths(&r(json!({"path": "a.stl"}))), ["a.stl"]);
    assert_eq!(written_paths(&r(json!({"path": "a.stl", "paths": ["a-1.stl", "a-2.stl"]}))), ["a-1.stl", "a-2.stl"]);
    assert_eq!(written_paths(&r(json!({"paths": []}))), Vec::<String>::new());
    let w =
        export_warnings(&r(json!({"warnings": [{"message": "fillet failed", "feature_id": "f4"}, {"message": "x"}]})));
    assert_eq!(w, [(Some("f4".into()), "fillet failed".into()), (None, "x".into())]);
}
