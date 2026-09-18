//! Sketch text against the Python engine (tests/text/gen_fixtures.py on the legacy branch writes
//! tests/text/fixtures.json).
//!
//! The two engines draw the same outlines through different machinery, OCCT's
//! FreeType-backed text builder there and ttf-parser here, so the oracle is a
//! tolerance one: the same number of glyph regions with the same number of
//! counters, each within a few percent of its area and its box. The fonts are
//! the ones Windows ships, so the whole file is skipped where they are not
//! installed.

use fundacad_geom::kernel;
use fundacad_geom::text::{self, TextPath, TextSpec};
use serde_json::Value;

/// Of the area, and of the text's own height for a box coordinate.
const AREA_REL: f64 = 0.01;
const BOX_REL: f64 = 0.005;

fn measured(name: &str, case: &Value) -> Vec<Value> {
    let entity = &case["entity"];
    let path = case["pathEntity"]
        .as_object()
        .and_then(|_| fundacad_geom::features::sketch::path_edge_json(&case["pathEntity"]));
    let Some(spec) = TextSpec::from_json(entity, &text::num_or_zero) else {
        panic!("{name}: the fixture entity has no height");
    };
    let glyphs = text::glyphs(&spec, path.as_ref().map(|edge| TextPath { edge }).as_ref());
    text::build_faces(&glyphs)
        .iter()
        .map(|f| {
            let bb = kernel::bbox(f).unwrap_or([0.0; 6]);
            serde_json::json!({
                "area": kernel::area(f),
                "bbox": [bb[0], bb[1], bb[3], bb[4]],
                "holes": kernel::count(f, kernel::Kind::Wire).saturating_sub(1),
            })
        })
        .collect()
}

fn sorted(faces: &[Value]) -> Vec<&Value> {
    let mut v: Vec<&Value> = faces.iter().collect();
    v.sort_by(|a, b| {
        let key = |f: &Value| (f["bbox"][0].as_f64().unwrap_or(0.0), f["bbox"][1].as_f64().unwrap_or(0.0));
        key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    v
}

/// The preview op over the same glyphs: one entry per face, holes and all.
fn check_tessellation(name: &str, case: &Value) -> Vec<String> {
    let path = case["pathEntity"]
        .as_object()
        .and_then(|_| fundacad_geom::features::sketch::path_edge_json(&case["pathEntity"]));
    let spec = TextSpec::from_json(&case["entity"], &text::num_or_zero).expect("a spec");
    let glyphs = text::glyphs(&spec, path.as_ref().map(|edge| TextPath { edge }).as_ref());
    let got = text::tessellate(&glyphs);
    let faces = got["faces"].as_array().cloned().unwrap_or_default();
    let want = case["expect"]["tessellated"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut bad = Vec::new();
    if faces.len() != want.len() {
        bad.push(format!(
            "{name}: {} tessellated faces, expected {}",
            faces.len(),
            want.len()
        ));
        return bad;
    }
    let holes = |f: &Value| f["holes"].as_array().map_or(0, Vec::len);
    let mut got_holes: Vec<usize> = faces.iter().map(holes).collect();
    let mut want_holes: Vec<usize> = want
        .iter()
        .map(|f| usize::try_from(f["holes"].as_u64().unwrap_or(0)).unwrap_or(0))
        .collect();
    got_holes.sort_unstable();
    want_holes.sort_unstable();
    if got_holes != want_holes {
        bad.push(format!("{name}: holes {got_holes:?} != {want_holes:?}"));
    }
    for f in &faces {
        if f["outer"].as_array().map_or(0, Vec::len) < 3 {
            bad.push(format!("{name}: a face came back without an outer contour"));
            break;
        }
    }
    bad
}

fn check(name: &str, case: &Value) -> Vec<String> {
    let mut bad = check_tessellation(name, case);
    let got = measured(name, case);
    let want = case["expect"]["faces"].as_array().cloned().unwrap_or_default();
    if got.len() != want.len() {
        bad.push(format!(
            "{name}: {} glyph faces, expected {}",
            got.len(),
            want.len()
        ));
        return bad;
    }
    let size = text::num_or_zero(case["entity"].get("height")).abs().max(1.0);
    for (g, w) in sorted(&got).into_iter().zip(sorted(&want)) {
        let (ga, wa) = (g["area"].as_f64().unwrap_or(0.0), w["area"].as_f64().unwrap_or(0.0));
        if (ga - wa).abs() > AREA_REL * wa.abs().max(1e-9) {
            bad.push(format!("{name}: face area {ga:.4} != {wa:.4}"));
        }
        if g["holes"] != w["holes"] {
            bad.push(format!("{name}: {} holes != {}", g["holes"], w["holes"]));
        }
        for k in 0..4 {
            let (gb, wb) = (
                g["bbox"][k].as_f64().unwrap_or(0.0),
                w["bbox"][k].as_f64().unwrap_or(0.0),
            );
            if (gb - wb).abs() > BOX_REL * size {
                bad.push(format!("{name}: bbox {} != {}", g["bbox"], w["bbox"]));
                break;
            }
        }
    }
    bad
}

#[test]
fn glyph_faces_match_the_python_engine() {
    let families = text::list_fonts()["families"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let has = |n: &str| families.iter().any(|f| f.as_str() == Some(n));
    if !(has("Arial") && has("Times New Roman") && has("Consolas") && has("Segoe UI")) {
        eprintln!("skipped: this machine does not have the Windows fonts the oracle uses");
        return;
    }
    let text = include_str!("text/fixtures.json");
    let fixtures: serde_json::Map<String, Value> =
        serde_json::from_str(text).expect("fixtures parse");
    let only = std::env::var("TEXT_CASE").ok();
    let mut bad = Vec::new();
    for (name, case) in &fixtures {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        bad.extend(check(name, case));
    }
    assert!(
        bad.is_empty(),
        "{} mismatches:\n{}",
        bad.len(),
        bad.join("\n")
    );
}

#[test]
fn font_families_are_found_and_an_unknown_name_falls_back() {
    let out = text::list_fonts();
    let families = out["families"].as_array().cloned().unwrap_or_default();
    if families.is_empty() {
        eprintln!("skipped: no system fonts on this machine");
        return;
    }
    if let Ok(path) = std::env::var("FUNDACAD_FONT_LIST") {
        std::fs::write(path, out.to_string()).expect("the font list is written");
    }
    let has = |n: &str| families.iter().any(|f| f.as_str() == Some(n));
    if !has("Arial") {
        eprintln!("skipped: this machine does not have Arial");
        return;
    }
    let spec = |font: &str| {
        TextSpec::from_json(
            &serde_json::json!({"text": "A", "height": 10, "font": font}),
            &text::num_or_zero,
        )
        .expect("a spec")
    };
    // A name nothing matches draws in Arial, the way Font_FontMgr falls back.
    assert_eq!(
        text::glyphs(&spec("NoSuchFontAnywhere"), None),
        text::glyphs(&spec("Arial"), None)
    );
    // And the aliases OCCT ships.
    assert_eq!(
        text::glyphs(&spec("sans-serif"), None),
        text::glyphs(&spec("Arial"), None)
    );
}
