//! Text on a face: embossed or engraved, wrapped onto round faces without
//! stretching. A glyph of planar area A thickened by d on a surface of normal
//! curvature k (across the text) adds A*d*(1 + d*k/2), negative k on the
//! concave side, so the volumes below pin both the size and the side.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::text::{self, fonts::Aspect, HAlign, TextSpec};
use serde_json::{json, Value};

const TEXT: &str = "FUNDA";

/// The planar area of `TEXT` at height 8, None when no font draws it.
fn glyph_area() -> Option<f64> {
    let spec = TextSpec {
        text: TEXT.into(),
        size: 8.0,
        font: None,
        aspect: Aspect::from_style("regular"),
        align: HAlign::Center,
        rotation: 0.0,
        x: 0.0,
        y: 0.0,
        position_on_path: 0.0,
        box_width: None,
    };
    let faces = text::build_faces(&text::glyphs(&spec, None));
    let a: f64 = faces.iter().map(kernel::area).sum();
    if a > 0.0 {
        Some(a)
    } else {
        eprintln!("skipped: no usable system font on this machine");
        None
    }
}

fn square(id: &str) -> Value {
    let p = [[-20.0, -20.0], [20.0, -20.0], [20.0, 20.0], [-20.0, 20.0]];
    let lines: Vec<Value> = (0..4)
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % 4]);
            json!({"type": "line", "id": format!("{id}{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        })
        .collect();
    json!({"id": id, "type": "sketch", "plane": "XY", "entities": lines})
}

fn build(parameters: Value, features: Vec<Value>) -> builder::Rebuild {
    let raw = json!({"parameters": parameters, "features": features});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled")
}

fn text_at(point: [f64; 3], op: &str) -> Value {
    json!({"id": "t1", "type": "textOnFace", "text": TEXT, "height": 8, "depth": 1, "operation": op,
        "face": {"kind": "face", "by": "nearest", "point": point, "body": "body1"}, "point": point})
}

fn plate(op: Option<&str>) -> builder::Rebuild {
    let mut f =
        vec![square("sk"), json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"})];
    f.extend(op.map(|op| text_at([0.0, 0.0, 10.0], op)));
    build(json!({}), f)
}

fn round(base: Value, point: [f64; 3], op: Option<&str>) -> builder::Rebuild {
    let mut f = vec![base];
    f.extend(op.map(|op| text_at(point, op)));
    build(json!({}), f)
}

fn volume(r: &builder::Rebuild) -> f64 {
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 1, "one solid");
    kernel::volume(&r.bodies[0].shape)
}

fn near(got: f64, want: f64, rel: f64, what: &str) {
    eprintln!("{what}: {got:.4} against {want:.4}");
    assert!((got - want).abs() <= rel * want.abs(), "{what}: {got:.4}, expected {want:.4} within {:.1} %", rel * 100.0);
}

#[test]
fn embossed_text_on_a_flat_face_adds_area_times_depth() {
    let Some(a) = glyph_area() else { return };
    let dv = volume(&plate(Some("join"))) - volume(&plate(None));
    near(dv, a, 0.005, "embossed volume");
    let bb = kernel::bbox(&plate(Some("join")).bodies[0].shape).unwrap();
    near(bb[5], 11.0, 1e-6, "top of the letters");
}

#[test]
fn engraved_text_on_a_flat_face_removes_area_times_depth() {
    let Some(a) = glyph_area() else { return };
    let dv = volume(&plate(None)) - volume(&plate(Some("cut")));
    near(dv, a, 0.005, "engraved volume");
}

fn cylinder() -> Value {
    json!({"id": "cyl", "type": "cylinder", "radius": 20, "height": 40})
}

#[test]
fn text_wraps_onto_a_cylinder_without_stretching() {
    let Some(a) = glyph_area() else { return };
    let r = round(cylinder(), [20.0, 0.0, 0.0], Some("join"));
    let dv = volume(&r) - volume(&round(cylinder(), [20.0, 0.0, 0.0], None));
    near(dv, a * (1.0 + 1.0 / 40.0), 0.005, "embossed volume on r20");
    let bb = kernel::bbox(&r.bodies[0].shape).unwrap();
    let reach = bb[3].max(bb[4]).max(-bb[0]).max(-bb[1]);
    assert!(reach <= 21.0 + 1e-3, "the letters stand at most 1 mm off the r20 surface, reach {reach:.4}");
    assert!(bb[3] > 20.9, "the letters stand out of the surface at the anchor, x max {:.4}", bb[3]);
}

#[test]
fn engraved_text_on_a_cylinder() {
    let Some(a) = glyph_area() else { return };
    let dv =
        volume(&round(cylinder(), [20.0, 0.0, 0.0], None)) - volume(&round(cylinder(), [20.0, 0.0, 0.0], Some("cut")));
    near(dv, a * (1.0 - 1.0 / 40.0), 0.005, "engraved volume on r20");
}

#[test]
fn text_on_a_cone_keeps_its_area() {
    let Some(a) = glyph_area() else { return };
    let cone = json!({"id": "cn", "type": "cone", "bottomRadius": 20, "topRadius": 10, "height": 40});
    let p = [15.0, 0.0, 0.0];
    let base = volume(&round(cone.clone(), p, None));
    let k = (10.0f64 / 40.0).atan().cos() / 15.0;
    near(
        volume(&round(cone.clone(), p, Some("join"))) - base,
        a * (1.0 + k / 2.0),
        0.01,
        "embossed volume on the cone",
    );
    near(base - volume(&round(cone, p, Some("cut"))), a * (1.0 - k / 2.0), 0.01, "engraved volume on the cone");
}

#[test]
fn text_on_a_bore_embosses_into_the_hole() {
    let Some(a) = glyph_area() else { return };
    let tube = |op: Option<&str>| {
        let mut f = vec![
            cylinder(),
            json!({"id": "core", "type": "cylinder", "radius": 10, "height": 40}),
            json!({"id": "cut", "type": "boolean", "operation": "cut", "target": "body1", "tools": ["body2"]}),
        ];
        f.extend(op.map(|op| text_at([10.0, 0.0, 0.0], op)));
        build(json!({}), f)
    };
    let dv = volume(&tube(Some("join"))) - volume(&tube(None));
    near(dv, a * (1.0 - 1.0 / 20.0), 0.005, "embossed volume inside the r10 bore");
}

#[test]
fn text_follows_its_face_when_an_upstream_edit_moves_it() {
    let Some(a) = glyph_area() else { return };
    let at = |h: f64, with: bool| {
        let mut f = vec![
            square("sk"),
            json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": "h", "operation": "new"}),
        ];
        if with {
            f.push(text_at([0.0, 0.0, 10.0], "join"));
        }
        build(json!({"h": h}), f)
    };
    let tall = at(15.0, true);
    near(volume(&tall) - volume(&at(15.0, false)), a, 0.005, "text volume after the edit");
    let bb = kernel::bbox(&tall.bodies[0].shape).unwrap();
    near(bb[5], 16.0, 1e-6, "the letters sit on the moved top face");
}

#[test]
fn a_lost_face_asks_for_a_repick() {
    if glyph_area().is_none() {
        return;
    }
    let mut t = text_at([0.0, 0.0, 10.0], "join");
    t["face"] = json!({"kind": "face", "by": "normal", "dir": [0.6, 0.0, 0.8], "body": "body1"});
    let r = build(
        json!({}),
        vec![
            square("sk"),
            json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"}),
            t,
        ],
    );
    let e = r.errors.iter().find(|e| e.feature_id.as_deref() == Some("t1")).expect("the text fails");
    assert_eq!(e.code.as_deref(), Some("referenceNotFound"), "{}", e.message);
    assert!(e.message.contains("re-pick"), "{}", e.message);
}

#[test]
fn a_sphere_is_refused_plainly() {
    if glyph_area().is_none() {
        return;
    }
    let r = round(json!({"id": "s", "type": "sphere", "radius": 20}), [20.0, 0.0, 0.0], Some("join"));
    let e = r.errors.iter().find(|e| e.feature_id.as_deref() == Some("t1")).expect("the text fails");
    assert!(e.message.contains("flat, a cylinder or a cone"), "{}", e.message);
}

/// The bbox of what the text added, from left aligned text so a mirrored
/// layout shows as ink on the wrong side of the anchor.
fn added_ink(base: Vec<Value>, point: [f64; 3]) -> [f64; 6] {
    let mut t = text_at(point, "join");
    t["align"] = json!("left");
    let mut with = base.clone();
    with.push(t);
    let (a, b) = (build(json!({}), with), build(json!({}), base));
    let ink = kernel::serial_bool(&a.bodies[0].shape, &[&b.bodies[0].shape], kernel::BoolKind::Cut).unwrap();
    kernel::bbox(&ink).unwrap()
}

#[test]
fn text_reads_left_to_right_seen_from_outside() {
    if glyph_area().is_none() {
        return;
    }
    let top = added_ink(
        vec![square("sk"), json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"})],
        [0.0, 0.0, 10.0],
    );
    assert!(top[0] > -0.5 && top[3] > 10.0, "on a top face the text runs towards +X: {top:?}");
    let side = added_ink(vec![cylinder()], [20.0, 0.0, 0.0]);
    assert!(side[1] > -0.5 && side[4] > 10.0, "seen from +X the text runs towards +Y: {side:?}");
}

#[test]
fn text_on_a_round_face_follows_a_radius_edit_by_match_and_fractions() {
    let Some(a) = glyph_area() else { return };
    let cyl = |r: f64, text: Option<&Value>| {
        let mut f = vec![json!({"id": "cyl", "type": "cylinder", "radius": "r", "height": 40})];
        if let Some(fp) = text {
            f.push(
                json!({"id": "t1", "type": "textOnFace", "text": TEXT, "height": 8, "depth": 1, "operation": "join",
                "face": {"kind": "face", "by": "match", "fp": fp, "body": "body1"},
                "point": [0.0, 20.0, 0.0], "at": [0.25, 0.5]}),
            );
        }
        build(json!({"r": r}), f)
    };
    let picked = cyl(20.0, None);
    let round = kernel::subshapes(&picked.bodies[0].shape, Kind::Face)
        .into_iter()
        .map(|f| fundacad_geom::select::face_fingerprint(&f).unwrap())
        .find(|fp| fp["surface"] == "cylinder")
        .expect("a round face");
    let wide = cyl(25.0, Some(&round));
    near(volume(&wide) - volume(&cyl(25.0, None)), a * (1.0 + 1.0 / 50.0), 0.005, "embossed volume after r 20 to 25");
    let bb = kernel::bbox(&wide.bodies[0].shape).unwrap();
    assert!(
        bb[4] > 25.9 && bb[4] <= 26.0 + 1e-3,
        "the letters stand 1 mm off the r25 face at a quarter turn, y max {:.4}",
        bb[4]
    );
    assert!(bb[3] <= 25.0 + 1e-3, "no letter on the +X side, x max {:.4}", bb[3]);
}

#[test]
fn the_mcp_schema_example_builds_on_a_cylinder() {
    let Some(a) = glyph_area() else { return };
    let schema: Value = serde_json::from_str(include_str!("../../fundacad-mcp/src/schema.json")).expect("schema.json");
    let example = schema["features"]["textOnFace"]["example"].clone();
    assert_eq!(example["type"], "textOnFace");
    let dv = volume(&build(json!({}), vec![cylinder(), example])) - volume(&round(cylinder(), [20.0, 0.0, 0.0], None));
    near(dv, a * (1.0 + 1.0 / 40.0), 0.005, "the schema example embosses its text on r20");
}

#[test]
fn the_face_anchor_op_gives_what_a_round_face_text_stores() {
    use fundacad_geom::features::text_on_face::face_anchor_result;
    let anchor = |r: f64, point: [f64; 3]| {
        let raw = json!({"parameters": {"r": r}, "features": [{"id": "cyl", "type": "cylinder", "radius": "r", "height": 40}]});
        let req = json!({"document": raw, "point": point, "face": {"kind": "face", "by": "nearest", "point": point}});
        let fundacad_protocol::JobResult::Json(got) = face_anchor_result(req.as_object().unwrap(), &NoWatch) else {
            panic!("a json reply");
        };
        got
    };
    let side = anchor(20.0, [0.0, 20.0, 0.0]);
    assert_eq!(side["surface"], "cylinder", "{side:?}");
    assert_eq!(side["body"], "body1", "{side:?}");
    let at = [side["at"][0].as_f64().unwrap(), side["at"][1].as_f64().unwrap()];
    assert!((at[0] - 0.25).abs() < 1e-6 && (at[1] - 0.5).abs() < 1e-6, "a quarter turn, half way up: {at:?}");
    let n = &side["normal"];
    assert!((n[1].as_f64().unwrap() - 1.0).abs() < 1e-6, "outward at +Y: {n:?}");
    assert_eq!(side["fp"]["surface"], "cylinder", "{side:?}");

    let top = anchor(20.0, [5.0, 5.0, 20.0]);
    assert_eq!(top["surface"], "plane", "{top:?}");
    assert!((top["normal"][2].as_f64().unwrap() - 1.0).abs() < 1e-6, "{top:?}");

    let Some(a) = glyph_area() else { return };
    let cyl = |r: f64, text: bool| {
        let mut f = vec![json!({"id": "cyl", "type": "cylinder", "radius": "r", "height": 40})];
        if text {
            f.push(
                json!({"id": "t1", "type": "textOnFace", "text": TEXT, "height": 8, "depth": 1, "operation": "join",
                "face": {"kind": "face", "by": "match", "fp": side["fp"], "body": "body1"},
                "point": [0.0, 20.0, 0.0], "at": side["at"]}),
            );
        }
        build(json!({"r": r}), f)
    };
    let wide = cyl(25.0, true);
    near(volume(&wide) - volume(&cyl(25.0, false)), a * (1.0 + 1.0 / 50.0), 0.005, "embossed volume after r 20 to 25");
    let bb = kernel::bbox(&wide.bodies[0].shape).unwrap();
    assert!(bb[4] > 25.9 && bb[4] <= 26.0 + 1e-3, "the letters stay at the picked quarter turn, y max {:.4}", bb[4]);
}
