//! A join whose flat sides only touch a cylinder along a line has to come out
//! closed. In the claw grabber a blade 10 wide joined onto an r 5 hub, and
//! OCCT's fuse left the two touch lines on the blade's side faces as INTERNAL
//! edges: the shell stayed closed and the volume right, but each line bounded
//! one face and inspect listed it OPEN. The clean after a boolean drops them.
//!
//! And a feature that does leave a solid with holes in its skin says so in the
//! build, since no volume check sees it.

use base64::Engine;
use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::inspect::{self, InspectBody};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r
}

/// An r 5 hub along z, centred on the origin, and a blade 10 wide in x whose
/// sides at x = +-5 touch it along the lines y = 0, from z 2.5 up to the top.
fn hub_and_blade() -> (Shape, Shape) {
    let hub = kernel::make_cylinder(5.0, 8.0).expect("hub");
    let blade = kernel::translated(&kernel::make_box(10.0, 30.0, 3.0).expect("blade"), [0.0, 12.0, 4.0])
        .expect("moved");
    (hub, blade)
}

/// Lines left drawn inside the faces of `s`.
fn lines_in_faces(s: &Shape) -> usize {
    kernel::subshapes(s, Kind::Face)
        .iter()
        .map(|f| kernel::subshapes(f, Kind::Edge).iter().filter(|e| kernel::edge_inside_face(f, e)).count())
        .sum()
}

fn assert_closed(out: &Shape, what: &str) {
    assert_eq!(kernel::count(out, Kind::Solid), 1, "{what}: one solid");
    assert_eq!(kernel::open_edge_count(out), 0, "{what}: edges that bound one face");
    assert_eq!(lines_in_faces(out), 0, "{what}: touch lines left inside a face");
}

#[test]
fn a_box_touching_a_cylinder_along_a_line_joins_closed() {
    let (hub, blade) = hub_and_blade();
    let sum = kernel::volume(&hub) + kernel::volume(&blade);
    for (what, out) in [
        ("serial", kernel::serial_bool(&hub, &[&blade], BoolKind::Fuse)),
        ("plain", kernel::boolean_op(&hub, &[&blade], BoolKind::Fuse)),
        ("swapped", kernel::serial_bool(&blade, &[&hub], BoolKind::Fuse)),
    ] {
        let out = out.expect("join");
        assert_closed(&out, what);
        let v = kernel::volume(&out);
        assert!(v < sum && v > kernel::volume(&blade), "{what}: volume {v}");
    }
}

/// A cut or an intersect along the same touch lines leaves no line behind either.
#[test]
fn a_cut_or_intersect_along_a_touch_line_leaves_none_behind() {
    let (hub, blade) = hub_and_blade();
    for kind in [BoolKind::Cut, BoolKind::Common] {
        for (base, tool) in [(&hub, &blade), (&blade, &hub)] {
            let out = kernel::serial_bool(base, &[tool], kind).expect("boolean");
            assert_eq!(kernel::open_edge_count(&out), 0, "{kind:?}: edges that bound one face");
            assert_eq!(lines_in_faces(&out), 0, "{kind:?}: touch lines left inside a face");
        }
    }
}

/// A body that still carries such a line, as OCCT's own fuse gives it, is not
/// called open: inspect names the line as drawn in its face.
#[test]
fn a_line_inside_a_face_is_not_an_open_edge() {
    let (hub, blade) = hub_and_blade();
    let raw = hub.union(&blade).shape;
    assert_eq!(lines_in_faces(&raw), 2, "the raw fuse keeps both touch lines");
    assert_eq!(kernel::open_edge_count(&raw), 0);
    let report = inspect::inspect_bodies(
        &[InspectBody { id: json!("body1"), name: json!("raw"), shape: Some(&raw) }],
        true,
        10_000,
        10_000,
    )
    .expect("inspected");
    let edges = report[0]["edges"].as_array().expect("edges");
    assert_eq!(edges.iter().filter(|e| e["inFace"] == json!(true)).count(), 2);
    assert!(!edges.iter().any(|e| e["openBoundary"] == json!(true)));
}

/// The claw's slider as features: the hub turned to lie along y and moved
/// down, the blade spanning its axis, joined by a union.
#[test]
fn the_claw_slider_union_inspects_closed() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "hub", "type": "cylinder", "radius": 5, "height": 8},
        {"id": "m1", "type": "move", "rx": 90, "dz": -92.35, "bodies": ["body1"]},
        {"id": "blade", "type": "box", "length": 10, "width": 3, "height": 30},
        {"id": "m2", "type": "move", "dy": 5.0, "dz": -92.35 - 3.0 + 15.0, "bodies": ["body2"]},
        {"id": "u", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]},
    ]});
    let r = build(&doc);
    assert_eq!(r.bodies.len(), 1);
    assert_closed(&r.bodies[0].shape, "slider");
    let report = inspect::inspect_bodies(
        &[InspectBody { id: json!("body1"), name: json!("slider"), shape: Some(&r.bodies[0].shape) }],
        true,
        10_000,
        10_000,
    )
    .expect("inspected");
    let open: Vec<&Value> = report[0]["edges"]
        .as_array()
        .expect("edges")
        .iter()
        .filter(|e| e["openBoundary"] == json!(true))
        .collect();
    assert!(open.is_empty(), "inspect lists open edges {open:?}");
    assert!(!r.diagnostics.iter().any(|d| d["code"] == "openShell"), "{:?}", r.diagnostics);
}

/// A solid whose shell lost a face, as an inline BREP import brings it in.
fn open_box_brep() -> String {
    let dir = std::env::temp_dir().join(format!("fundacad-open-box-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("box.brep");
    kernel::make_box(10.0, 10.0, 10.0).expect("box").write_brep_text(&path).expect("written");
    let text = std::fs::read_to_string(&path).expect("read");
    let _ = std::fs::remove_dir_all(&dir);
    // The shell's line lists its six faces, "-26 0 +16 0 ... *": drop the first.
    // The writer heads the file with a DBRep line the importer does not take.
    let lines: Vec<&str> = text.lines().skip_while(|l| !l.starts_with("CASCADE")).collect();
    let sh = lines.iter().position(|l| *l == "Sh").expect("a shell");
    let faces = sh + lines[sh + 1..].iter().position(|l| l.ends_with('*')).expect("its faces") + 1;
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
    let tokens: Vec<&str> = lines[faces].split(' ').collect();
    out[faces] = tokens[2..].join(" ");
    base64::engine::general_purpose::STANDARD.encode(out.join("\n") + "\n")
}

#[test]
fn a_solid_left_open_is_called_out_in_the_build() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "imp", "type": "import", "name": "open box", "format": "step", "brep": open_box_brep()},
    ]});
    let r = build(&doc);
    assert_eq!(r.bodies.len(), 1);
    assert!(kernel::open_edge_count(&r.bodies[0].shape) > 0, "the shell lost a face");
    let note = r.diagnostics.iter().find(|d| d["code"] == "openShell");
    let note = note.unwrap_or_else(|| panic!("no openShell note in {:?}", r.diagnostics));
    assert_eq!(note["feature_id"], "imp");
    assert!(note["reason"].as_str().is_some_and(|s| s.contains("not a closed solid")), "{note}");
}

#[test]
fn closed_solids_count_no_open_edges() {
    assert_eq!(kernel::open_edge_count(&kernel::make_cylinder(5.0, 10.0).expect("rod")), 0);
    assert_eq!(kernel::open_edge_count(&kernel::make_box(1.0, 2.0, 3.0).expect("box")), 0);
    assert_eq!(kernel::open_edge_count(&kernel::make_sphere(3.0).expect("ball")), 0);
}
