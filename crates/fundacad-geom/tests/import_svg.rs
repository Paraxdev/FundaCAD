//! SVG, tests/fixtures written by tests/svg/gen_svg.py.

use std::f64::consts::PI;
use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Map, Value};

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-svg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    })
}

fn imported(name: &str) -> Map<String, Value> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"));
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&p.to_string_lossy(), "svg", &store).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn sketches(r: &Map<String, Value>) -> &Vec<Value> {
    r["sketches"].as_array().unwrap()
}

fn notes(r: &Map<String, Value>) -> Vec<String> {
    r.get("notes").and_then(Value::as_array).map(|a| a.iter().map(|n| n.as_str().unwrap().to_string()).collect()).unwrap_or_default()
}

/// The sketch extruded 2 mm with no regions, as the app's whole sketch extrude does.
fn extruded(s: &Value) -> Rebuild {
    let mut sk = json!({"id": "f1", "type": "sketch", "plane": "XY", "entities": s["entities"]});
    if let Some(r) = s.get("fillRule") {
        sk["fillRule"] = r.clone();
    }
    let doc = json!({"version": 6, "parameters": {}, "features": [sk,
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 2, "operation": "new"}]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn volume(r: &Rebuild) -> f64 {
    r.bodies.iter().map(|b| kernel::volume(&b.shape)).sum()
}

fn solids(r: &Rebuild) -> usize {
    r.bodies.iter().map(|b| kernel::count(&b.shape, Kind::Solid)).sum()
}

fn near(got: f64, want: f64, rel: f64, what: &str) {
    assert!((got - want).abs() <= want.abs() * rel, "{what}: {got}, want {want}");
}

fn shoelace(p: &[(f64, f64)]) -> f64 {
    (0..p.len()).map(|i| p[i].0 * p[(i + 1) % p.len()].1 - p[(i + 1) % p.len()].0 * p[i].1).sum::<f64>().abs() / 2.0
}

#[test]
fn an_evenodd_o_keeps_its_hole() {
    let r = imported("svg_letter_o.svg");
    let s = sketches(&r);
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["name"], "svg_letter_o");
    assert_eq!(s[0]["fillRule"], "evenodd");
    assert_eq!(r["unit"], "mm");
    assert!(!notes(&r).iter().any(|n| n.contains("open end")), "{:?}", notes(&r));
    let ents = s[0]["entities"].as_array().unwrap();
    assert!(ents.iter().all(|e| e["type"] == "arc"), "A commands with rx == ry stay arcs: {ents:?}");
    let b = extruded(&s[0]);
    assert_eq!(solids(&b), 1);
    near(volume(&b), 2.0 * PI * 75.0, 5e-3, "ring");
}

#[test]
fn a_nonzero_counter_is_a_hole_only_when_it_runs_the_other_way() {
    let outer = shoelace(&[(0.0, 20.0), (8.0, 0.0), (12.0, 0.0), (20.0, 20.0), (14.0, 20.0), (12.5, 15.0), (7.5, 15.0), (6.0, 20.0)]);
    let counter = 9.0;
    let same = imported("svg_letter_a_same.svg");
    near(volume(&extruded(&sketches(&same)[0])), 2.0 * outer, 1e-3, "same way fills the counter");
    let opposite = imported("svg_letter_a_opposite.svg");
    let b = extruded(&sketches(&opposite)[0]);
    assert_eq!(solids(&b), 1);
    near(volume(&b), 2.0 * (outer - counter), 1e-3, "the other way is a hole");
}

#[test]
fn a_tiny_gap_is_closed() {
    let r = imported("svg_gap.svg");
    let n = notes(&r);
    assert!(n.iter().any(|n| n == "closed 1 small gap"), "{n:?}");
    assert!(!n.iter().any(|n| n.contains("open end") || n.contains("straight line")), "{n:?}");
    let b = extruded(&sketches(&r)[0]);
    assert_eq!(solids(&b), 1);
    near(volume(&b), 2.0 * 2500.0, 1e-3, "square");
}

#[test]
fn a_figure_eight_is_split_where_it_crosses() {
    let r = imported("svg_figure8.svg");
    assert!(notes(&r).iter().any(|n| n == "split 1 crossing where outlines cross"), "{:?}", notes(&r));
    let b = extruded(&sketches(&r)[0]);
    near(volume(&b), 2.0 * 200.0, 1e-3, "two triangles");
}

#[test]
fn duplicate_and_overlapping_shapes_become_one_outline() {
    let r = imported("svg_overlap.svg");
    let s = &sketches(&r)[0];
    assert_eq!(s["entities"].as_array().unwrap().len(), 8, "the union's eight sides");
    let b = extruded(s);
    assert_eq!(solids(&b), 1);
    near(volume(&b), 2.0 * 700.0, 1e-3, "union");
}

#[test]
fn an_icon_reads_groups_transforms_units_and_layers() {
    let r = imported("svg_icon.svg");
    let names: Vec<&str> = sketches(&r).iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Base", "Marks", "Marks strokes"]);
    let n = notes(&r);
    for want in ["skipped 1 image, 1 text", "ignored 1 clip path, 1 filter, the shapes under them are kept whole", "1 gradient or pattern fill kept as plain fills"] {
        assert!(n.iter().any(|x| x == want), "{want} in {n:?}");
    }
    assert!(n.iter().any(|x| x.starts_with("1 outline is drawn as strokes only")), "{n:?}");

    let base = extruded(&sketches(&r)[0]);
    let bb = kernel::bbox(&base.bodies[0].shape).unwrap();
    for (got, want) in [(bb[0], 2.5), (bb[1], 27.5), (bb[3], 37.5), (bb[4], 37.5)] {
        near(got, want, 1e-6, "Base box, 4 px per mm with the top of the page at high Y");
    }
    near(volume(&base), 2.0 * (5600.0 - (4.0 - PI) * 64.0) / 16.0, 1e-3, "rounded rect");

    let marks = &sketches(&r)[1];
    let circle = marks["entities"].as_array().unwrap().iter().find(|e| e["type"] == "circle").expect("a circle under rotate and scale stays a circle");
    near(circle["radius"].as_f64().unwrap(), 2.5, 1e-9, "radius");
    let b = extruded(marks);
    assert_eq!(solids(&b), 7, "seven separate marks");
    near(volume(&b), 2.0 * (43.0 * PI + 346.0) / 4.0, 1e-3, "marks keep their areas through skew and matrix");
}

fn imported_text(name: &str, svg: &str) -> Map<String, Value> {
    let p = blob_dir().join(format!("{name}.svg"));
    std::fs::write(&p, svg).unwrap();
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&p.to_string_lossy(), "svg", &store).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// A circle as four quarter A commands whose last one stops `gap` short of the start.
fn arc_circle(cx: f64, cy: f64, r: f64, gap: f64) -> String {
    format!(
        "M {x0} {cy} A {r} {r} 0 0 1 {cx} {y1} A {r} {r} 0 0 1 {x2} {cy} A {r} {r} 0 0 1 {cx} {y3} A {r} {r} 0 0 1 {x0} {yg} Z",
        x0 = cx + r, y1 = cy + r, x2 = cx - r, y3 = cy - r, yg = cy - gap
    )
}

#[test]
fn a_ring_of_arcs_keeps_its_hole_across_tiny_gaps() {
    for (size, gap) in [(1000.0, 0.0), (1000.0, 1e-7), (1000.0, 1e-4), (1000.0, 5e-3), (100.0, 5e-4)] {
        let (c, r_out, r_in) = (size / 2.0, size * 0.4, size * 0.2);
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{size}mm" height="{size}mm" viewBox="0 0 {size} {size}"><path fill-rule="evenodd" d="{} {}"/></svg>"#,
            arc_circle(c, c, r_out, gap),
            arc_circle(c, c, r_in, gap)
        );
        let r = imported_text("ring_gap", &svg);
        let b = extruded(&sketches(&r)[0]);
        assert_eq!(solids(&b), 1, "size {size} gap {gap}");
        near(volume(&b), 2.0 * PI * (r_out * r_out - r_in * r_in), 1e-3, &format!("ring, size {size} gap {gap}"));
    }
}

#[test]
fn an_arc_meets_a_neighbour_a_hair_away() {
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="1000mm" viewBox="0 0 1000 1000">
<path d="M 0 0 H 500 V 500 H 0 Z"/><path d="M 500 0.003 A 250 250 0 0 1 500 500.003 Z"/></svg>"#;
    let r = imported_text("rect_half_disc", svg);
    let b = extruded(&sketches(&r)[0]);
    assert_eq!(solids(&b), 1);
    near(volume(&b), 2.0 * (250_000.0 + PI * 62_500.0 / 2.0), 1e-3, "rect and half disc");
}

#[test]
fn a_use_fan_out_is_refused_quickly() {
    let mut defs = String::from(r#"<g id="u0"/>"#);
    for k in 1..15 {
        defs.push_str(&format!(r#"<g id="u{k}">"#));
        for _ in 0..6 {
            defs.push_str(&format!(r##"<use href="#u{}"/>"##, k - 1));
        }
        defs.push_str("</g>");
    }
    let svg = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs>{defs}</defs><use href="#u14"/></svg>"##);
    let p = blob_dir().join("fan_out.svg");
    std::fs::write(&p, svg).unwrap();
    let store = BlobStore::open(blob_dir()).unwrap();
    let t = std::time::Instant::now();
    let err = import::import_geometry(&p.to_string_lossy(), "svg", &store).expect_err("a fan out of 6^14 elements");
    assert!(err.contains("elements"), "{err}");
    assert!(t.elapsed().as_secs_f64() < 10.0, "{:?}", t.elapsed());
}
