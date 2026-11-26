use serde_json::{json, Map, Value};

use super::*;
use crate::document::Target;

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().expect("an object")
}

fn doc(features: Value) -> Map<String, Value> {
    obj(json!({ "features": features }))
}

fn set(p: options::Patch) -> Map<String, Value> {
    p.into_iter().map(|(k, v)| (k, v.expect("a value, not a removal"))).collect()
}

fn hole_patch(f: Value, field: &str, value: Value) -> Map<String, Value> {
    set(hole::choice_patch(&obj(f), field, &value, |_| false))
}

fn feature<'a>(d: &'a Map<String, Value>, id: &str) -> &'a Map<String, Value> {
    features(d).into_iter().find(|f| id_of(f) == id).expect("the feature")
}

fn choice<'a>(rows: &'a [Row], field: &str) -> &'a ChoiceRow {
    rows.iter()
        .find_map(|r| match r {
            Row::Choice(c) if c.field == field => Some(c),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no {field} choice"))
}

fn number<'a>(rows: &'a [Row], field: &str) -> Option<&'a NumRow> {
    rows.iter().find_map(|r| match r {
        Row::Number(n) if n.field == field => Some(n),
        _ => None,
    })
}

fn toggle(rows: &[Row], field: &str) -> Option<bool> {
    rows.iter().find_map(|r| match r {
        Row::Toggle { field: f, on, .. } if *f == field => Some(*on),
        _ => None,
    })
}

fn labels(c: &ChoiceRow) -> Vec<&str> {
    c.options.iter().map(|o| o.label.as_str()).collect()
}

fn m3_counterbore() -> Value {
    json!({ "type": "hole", "holeType": "counterbore", "standard": "clearance", "size": "M3", "fit": "normal",
        "diameter": 3.4, "cbDiameter": 6.5, "cbDepth": 3.4, "extent": "through" })
}

#[test]
fn a_hole_size_rewrites_every_dimension_its_standard_defines() {
    let p = hole_patch(m3_counterbore(), "size", json!("M5"));
    assert_eq!(p, obj(json!({ "size": "M5", "diameter": 5.5, "cbDiameter": 10, "cbDepth": 5.4 })));
}

#[test]
fn a_hole_fit_rewrites_only_the_diameter() {
    assert_eq!(hole_patch(m3_counterbore(), "fit", json!("loose")), obj(json!({ "fit": "loose", "diameter": 3.6 })));
}

#[test]
fn a_bound_hole_diameter_is_left_to_its_parameter() {
    let f = obj(json!({ "type": "hole", "size": "M3", "diameter": 3.4, "extent": "through" }));
    let p = set(hole::choice_patch(&f, "size", &json!("M5"), |k| k == "diameter"));
    assert_eq!(p, obj(json!({ "size": "M5" })));
}

#[test]
fn a_custom_hole_turned_counterbore_gets_stand_ins_scaled_off_its_diameter() {
    let f = json!({ "type": "hole", "holeType": "simple", "standard": "custom", "diameter": 4, "extent": "through" });
    let p = hole_patch(f, "holeType", json!("counterbore"));
    assert_eq!(p, obj(json!({ "holeType": "counterbore", "cbDiameter": 7.6, "cbDepth": 4 })));
}

#[test]
fn an_insert_is_blind_and_takes_its_bore() {
    let f = json!({ "type": "hole", "holeType": "simple", "size": "M3", "diameter": 3.4, "extent": "through" });
    let p = hole_patch(f, "holeType", json!("insert"));
    let want = json!({ "holeType": "insert", "extent": "blind", "diameter": 4, "depth": 6, "leadIn": 0.5 });
    assert_eq!(p, obj(want));
}

#[test]
fn a_blind_hole_without_a_depth_gets_twice_its_diameter() {
    let f = json!({ "type": "hole", "holeType": "simple", "size": "M3", "diameter": 3.4, "extent": "through" });
    assert_eq!(hole_patch(f, "extent", json!("blind")), obj(json!({ "extent": "blind", "depth": 6.8 })));
}

#[test]
fn a_hole_switch_passes_through() {
    let p = hole_patch(m3_counterbore(), "drillPoint", json!(true));
    assert_eq!(p, obj(json!({ "drillPoint": true })));
}

#[test]
fn hole_rows_follow_the_hole_type_and_standard() {
    let insert = obj(json!({ "holeType": "insert" }));
    assert!(!hole::field_applies("standard", &insert));
    assert!(hole::field_applies("size", &insert));
    assert!(hole::field_applies("leadIn", &insert));
    assert!(hole::field_applies("depth", &insert));
    assert!(!hole::field_applies("drillPoint", &insert));
    let custom = obj(json!({ "standard": "custom", "extent": "through" }));
    assert!(!hole::field_applies("size", &custom));
    assert!(!hole::field_applies("depth", &custom));
    assert!(!hole::field_applies("fit", &custom));
    let tap = obj(json!({ "standard": "tap" }));
    assert!(hole::field_applies("tapped", &tap));
    assert!(!hole::field_applies("fit", &tap));
    assert!(!hole::field_applies("cbDepth", &tap));
}

fn mirror_doc(plane: Value, bodies: Value) -> Map<String, Value> {
    doc(json!([
        { "id": "dp1", "type": "datumPlane", "name": "Shelf" },
        { "id": "dp3", "type": "datumPlane" },
        { "id": "m", "type": "mirror", "plane": plane, "bodies": bodies },
        { "id": "dp4", "type": "datumPlane" },
    ]))
}

#[test]
fn a_mirror_offers_the_datum_planes_above_it_and_keeps_a_missing_one() {
    let d = mirror_doc(json!({ "name": "dp9" }), json!(["b1"]));
    let rows = rows(&d, "m", &[]);
    let c = choice(&rows, "plane");
    assert_eq!(labels(c), ["XY", "XZ", "YZ", "Shelf", "dp3", "dp9 (missing)"]);
    assert_eq!(c.current, "dp9");
}

#[test]
fn a_mirror_plane_is_wrapped_only_while_it_names_bodies() {
    let mut d = mirror_doc(json!("XY"), json!(["b1"]));
    set_option(&mut d, "m", "plane", &json!("dp1")).unwrap();
    assert_eq!(feature(&d, "m")["plane"], json!({ "name": "dp1" }));
    let mut d = mirror_doc(json!("XY"), json!([]));
    set_option(&mut d, "m", "plane", &json!("dp1")).unwrap();
    assert_eq!(feature(&d, "m")["plane"], json!("dp1"));
    assert_eq!(choice(&rows(&d, "m", &[]), "plane").current, "dp1");
}

fn mechanism(drive: &str) -> Map<String, Value> {
    doc(json!([{ "id": "mech", "type": "mechanism", "drive": drive, "offset": 3, "angle": 10, "joints": [
        { "id": "slide1", "mode": "slider" },
        { "id": "pin1", "mode": "revolute" },
        { "id": "weld", "mode": "fixed" },
    ] }]))
}

#[test]
fn a_mechanism_drives_its_movable_joints_and_shows_the_value_it_reads() {
    let d = mechanism("slide1");
    let rows = rows(&d, "mech", &[]);
    let c = choice(&rows, "drive");
    assert_eq!(labels(c), ["None", "slide1 (slider)", "pin1 (revolute)"]);
    assert_eq!(c.current, "slide1");
    assert!(number(&rows, "offset").is_some());
    assert!(number(&rows, "angle").is_none());
}

#[test]
fn a_mechanism_keeps_a_drive_it_cannot_move_and_none_removes_it() {
    let mut d = mechanism("gone");
    let c = choice(&rows(&d, "mech", &[]), "drive").clone();
    assert_eq!(c.current, "gone");
    assert_eq!(c.options.last().map(|o| o.value.as_str()), Some("gone"));
    set_option(&mut d, "mech", "drive", &json!("")).unwrap();
    assert!(!feature(&d, "mech").contains_key("drive"));
}

#[test]
fn an_extrude_defaults_to_a_new_body_and_writes_its_switches() {
    let mut d = doc(json!([{ "id": "e", "type": "extrude", "distance": 10 }, { "id": "l", "type": "loft" }]));
    let r = rows(&d, "e", &[]);
    assert_eq!(choice(&r, "operation").current, "new");
    assert_eq!(toggle(&r, "symmetric"), Some(false));
    assert_eq!(choice(&rows(&d, "l", &[]), "operation").current, "new");
    set_option(&mut d, "e", "symmetric", &json!(true)).unwrap();
    assert_eq!(feature(&d, "e")["symmetric"], json!(true));
    let r = rows(&d, "e", &[]);
    assert_eq!(toggle(&r, "symmetric"), Some(true));
    assert_eq!(toggle(&r, "twoSided"), None);
}

#[test]
fn thin_sets_a_wall_thickness_and_shows_it() {
    let mut d = doc(json!([{ "id": "e", "type": "extrude", "distance": 10 }]));
    assert!(number(&rows(&d, "e", &[]), "thickness").is_none());
    set_option(&mut d, "e", "thin", &json!(true)).unwrap();
    assert_eq!(feature(&d, "e")["thickness"], json!(2));
    assert_eq!(number(&rows(&d, "e", &[]), "thickness").and_then(|n| n.value), Some(2.));
}

#[test]
fn a_two_distance_chamfer_starts_from_its_distance() {
    let mut d = doc(json!([{ "id": "c", "type": "chamfer", "distance": 1.5, "edges": [] }]));
    assert!(number(&rows(&d, "c", &[]), "distance2").is_none());
    set_option(&mut d, "c", "chamferType", &json!("twoDistance")).unwrap();
    assert_eq!(feature(&d, "c")["distance2"], json!(1.5));
}

#[test]
fn a_pattern_axis_datum_is_written_wrapped_and_drops_the_placed_axis() {
    let mut d = doc(json!([
        { "id": "ax1", "type": "datumAxis", "name": " Spindle " },
        { "id": "p", "type": "patternCircular", "axis": "Z", "axisRef": { "edge": 1 }, "count": 4 },
    ]));
    let c = choice(&rows(&d, "p", &[]), "axis").clone();
    assert_eq!(labels(&c), ["X", "Y", "Z", "Spindle", "Picked"]);
    assert_eq!(c.current, "placed");
    set_option(&mut d, "p", "axis", &json!("ax1")).unwrap();
    let p = feature(&d, "p");
    assert_eq!(p["axis"], json!({ "datum": "ax1" }));
    assert!(!p.contains_key("axisRef"));
    assert_eq!(choice(&rows(&d, "p", &[]), "axis").current, "ax1");
}

#[test]
fn choose_one_and_a_picked_point_write_nothing() {
    let d = doc(json!([{ "id": "e", "type": "extrude", "startType": "plane", "startPlane": "XZ" }]));
    assert_eq!(option_patch(&d, "e", "startPlane", &json!("")), None);
    assert_eq!(option_patch(&d, "e", "startPoint", &json!("picked")), None);
}

#[test]
fn an_absent_fillet_profile_reads_as_round() {
    let mut d = doc(json!([{ "id": "f", "type": "fillet", "radius": 2, "edges": [{ "by": "all" }] }]));
    let r = rows(&d, "f", &[]);
    let profile = number(&r, "profile").unwrap();
    assert_eq!(profile.value, Some(0.));
    let target = profile.target.clone().unwrap();
    set_number(&mut d, &target, 0.5).unwrap();
    assert_eq!(feature(&d, "f")["profile"], json!(0.5));
    set_number(&mut d, &target, 0.).unwrap();
    assert!(!feature(&d, "f").contains_key("profile"));
}

#[test]
fn a_number_is_written_as_the_field_holds_it() {
    let mut d = doc(json!([{ "id": "p", "type": "patternLinear", "count": 3, "spacing": 5 }]));
    let field = |key: &str| Target::Field { feature: "p".into(), key: key.into() };
    set_number(&mut d, &field("spacing"), 12.).unwrap();
    set_number(&mut d, &field("count"), 4.4).unwrap();
    assert_eq!(feature(&d, "p")["spacing"], json!(12));
    assert_eq!(feature(&d, "p")["count"], json!(4));
    assert!(set_number(&mut d, &field("nope"), 1.).is_err());
    assert!(set_number(&mut d, &field("spacing"), f64::NAN).is_err());
}

#[test]
fn impossible_values_are_refused_in_words() {
    let radius = fields::value_rule("fillet", "radius");
    assert_eq!(value_problem("Radius", radius, -1.).as_deref(), Some("Radius must be more than 0"));
    assert_eq!(value_problem("Radius", radius, 1.), None);
    let count = fields::value_rule("patternLinear", "count");
    assert_eq!(value_problem("Count", count, 2.5).as_deref(), Some("Count must be a whole number"));
    assert_eq!(value_problem("Count", count, 0.).as_deref(), Some("Count must be at least 1"));
    assert_eq!(value_problem("Count", count, 3.), None);
    assert_eq!(value_problem("Seed", fields::value_rule("x", "seed"), -40.), None);
}

fn reads(kind: Kind, typed: &str) -> f64 {
    parse(kind, typed).unwrap_or_else(|why| panic!("{typed}: {why}"))
}

#[test]
fn typed_values_read_units_and_fractions() {
    let cases = [
        (Kind::Length, "5in", 127.),
        (Kind::Length, "2 cm", 20.),
        (Kind::Length, " 10 ", 10.),
        (Kind::Length, "-3", -3.),
        (Kind::Length, "10MM", 10.),
        (Kind::Length, "1/2\"", 12.7),
        (Kind::Length, "1 1/2 in", 38.1),
        (Kind::Angle, "45 °", 45.),
        (Kind::Angle, "90deg", 90.),
        (Kind::Angle, "3.14159265358979 rad", 180.),
        (Kind::Count, "3", 3.),
    ];
    for (kind, typed, want) in cases {
        assert!((reads(kind, typed) - want).abs() < 1e-9, "{typed}");
    }
}

#[test]
fn typed_values_of_the_wrong_kind_are_refused() {
    assert_eq!(parse(Kind::Angle, "2in"), Err("in is not an angle".into()));
    assert_eq!(parse(Kind::Length, "30deg"), Err("° is not a length".into()));
    assert_eq!(parse(Kind::Count, "3mm"), Err("this field is unitless, write a plain number".into()));
    assert_eq!(parse(Kind::Length, "abc"), Err("not a number or a measurement".into()));
    assert_eq!(parse(Kind::Length, "2 + 3"), Err("not a number or a measurement".into()));
    assert_eq!(parse(Kind::Length, "  "), Err("empty value".into()));
}

fn target_text(f: Value, label: &str) -> String {
    let d = doc(json!([f]));
    let id = id_of(&features(&d)[0]).to_string();
    rows(&d, &id, &[])
        .into_iter()
        .find_map(|r| match r {
            Row::Target { label: l, text, .. } if l == label => Some(text),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no {label} row"))
}

#[test]
fn targets_are_counted_or_worded() {
    assert_eq!(target_text(json!({ "id": "f", "type": "fillet", "edges": [{ "by": "all" }] }), "Edges"), "every edge");
    let edges = json!([{ "e": 1 }, { "e": 2 }, { "by": "tangentChain" }]);
    assert_eq!(
        target_text(json!({ "id": "f", "type": "fillet", "edges": edges }), "Edges"),
        "2 edges, 1 tangent chain"
    );
    assert_eq!(target_text(json!({ "id": "b", "type": "boolean", "target": "body1" }), "Body kept"), "1 body");
    assert_eq!(target_text(json!({ "id": "s", "type": "shell", "faces": [] }), "Faces to open"), "sealed hollow");
}

#[test]
fn a_pattern_of_features_lists_them_and_acts_on_no_bodies() {
    let d = doc(json!([
        { "id": "e1", "type": "extrude", "name": "Peg" },
        { "id": "f1", "type": "fillet" },
        { "id": "p", "type": "patternLinear", "features": ["e1", "f1", "gone"], "count": 3 },
    ]));
    let r = rows(&d, "p", &[]);
    assert_eq!(r[0], Row::Repeats { names: "Peg, Fillet, gone".into() });
    assert!(!r.iter().any(|r| matches!(r, Row::Target { .. })));
}

#[test]
fn the_build_note_comes_first() {
    let d = doc(json!([{ "id": "e", "type": "extrude", "distance": 10 }]));
    let issue =
        FeatureIssue { feature_id: "e".into(), message: "the profile is open".into(), warning: false, note: false };
    let r = rows(&d, "e", &[issue]);
    assert_eq!(r[0], Row::Note { text: "the profile is open".into(), warning: false });
    assert!(rows(&d, "missing", &[]).is_empty());
}

#[test]
fn a_bound_literal_is_edited_through_its_parameter_and_an_expression_is_read_only() {
    let mut d = doc(json!([{ "id": "e", "type": "extrude", "distance": 10, "taper": 2 }]));
    d.insert(
        "paramDefs".into(),
        json!({
            "d1": { "expr": "10", "value": 10, "unit": "mm",
                "target": { "kind": "feature", "feature": "e", "field": "distance" } },
            "d2": { "expr": "wall * 2", "value": 2, "unit": "deg",
                "target": { "kind": "feature", "feature": "e", "field": "taper" } },
        }),
    );
    let r = rows(&d, "e", &[]);
    let distance = number(&r, "distance").unwrap();
    assert_eq!((distance.value, distance.expr.as_deref()), (Some(10.), None));
    assert_eq!(distance.target, Some(Target::Def("d1".into())));
    let taper = number(&r, "taper").unwrap();
    assert_eq!((taper.expr.as_deref(), taper.target.as_ref()), (Some("wall * 2"), None));
    set_number(&mut d, &Target::Def("d1".into()), 12.).unwrap();
    assert_eq!(number(&rows(&d, "e", &[]), "distance").and_then(|n| n.value), Some(12.));
}

#[test]
fn the_box_with_lid_cavity_shows_its_choices_switches_and_numbers() {
    let file: Value = serde_json::from_str(include_str!("../../../../examples/templates/box-with-lid.funda")).unwrap();
    let d = obj(file);
    let r = rows(&d, "cavity", &[]);
    assert!(r.contains(&Row::Target { label: "Profile", text: "the whole sketch".into(), empty: true }));
    assert!(r.contains(&Row::Target { label: "Bodies acted on", text: "1 body".into(), empty: false }));
    assert_eq!(choice(&r, "operation").current, "cut");
    assert_eq!(choice(&r, "startType").current, "offset");
    assert_eq!(choice(&r, "endType").current, "throughAll");
    assert!(!r.iter().any(|r| matches!(r, Row::Choice(c) if c.field == "startPlane")));
    assert_eq!((toggle(&r, "symmetric"), toggle(&r, "thin")), (Some(false), Some(false)));
    let offset = number(&r, "startOffset").unwrap();
    assert_eq!((offset.value, offset.expr.as_deref(), offset.target.as_ref()), (Some(2.), Some("floor"), None));
    let taper = number(&r, "taper").unwrap();
    assert_eq!(taper.value, None);
    assert_eq!(taper.target, Some(Target::Field { feature: "cavity".into(), key: "taper".into() }));
    assert!(number(&r, "thickness").is_none());
}
