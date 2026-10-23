use fundacad_mcp::render::stress_color;
use fundacad_mcp::stress::*;
use serde_json::{json, Map, Value};

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn face(dir: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "normal", "dir": dir})
}

#[test]
fn a_well_formed_request_passes_through_and_draws_by_default() {
    let r = request_of(&args(json!({
        "body": "body1",
        "fixed": face([-1.0, 0.0, 0.0]),
        "loads": {"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -100]},
        "material": {"E": 2300, "nu": 0.35, "yield": 40, "name": "my PETG"},
        "size": 2.5,
        "maxElements": 20000,
        "refine": "fine",
    })))
    .expect("a good request");
    assert_eq!(r.payload["refine"], json!("fine"));
    assert!(r.image);
    assert_eq!(r.payload["loads"].as_array().map(Vec::len), Some(1));
    assert_eq!(r.payload["maxElements"], json!(20000));
    assert!(r.payload.get("document").is_none());
}

#[test]
fn a_null_force_or_pressure_is_left_out_of_the_request() {
    let r = request_of(&args(json!({
        "body": "body1",
        "fixed": face([-1.0, 0.0, 0.0]),
        "loads": [
            {"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1], "pressure": null},
            {"faces": [face([0.0, 0.0, 1.0])], "force": null, "pressure": 1},
        ],
    })))
    .expect("nulls read as absent");
    let loads = r.payload["loads"].as_array().expect("loads");
    assert!(loads[0].get("pressure").is_none(), "{}", loads[0]);
    assert_eq!(loads[0]["force"], json!([0, 0, -1]));
    assert!(loads[1].get("force").is_none(), "{}", loads[1]);
    assert!(r.payload.get("refine").is_none());
    assert_eq!(loads[1]["pressure"], json!(1));
}

#[test]
fn malformed_arguments_are_named() {
    let base = || {
        json!({"body": "body1", "fixed": [face([-1.0, 0.0, 0.0])],
               "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1]}]})
    };
    let refused = |patch: Value| {
        let mut a = base();
        for (k, v) in patch.as_object().expect("an object") {
            a[k] = v.clone();
        }
        request_of(&args(a)).err().expect("refused")
    };
    assert!(refused(json!({"body": null})).contains("`body` is missing"));
    assert!(refused(json!({"fixed": []})).contains("`fixed` names no faces"));
    assert!(refused(json!({"fixed": [3]})).contains("`fixed[0]` is not a face selector"));
    assert!(refused(json!({"loads": []})).contains("`loads` is empty"));
    let both = refused(json!({"loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, 1], "pressure": 1}]}));
    assert!(both.contains("both a force and a pressure"), "{both}");
    assert!(refused(json!({"loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 1]}]}))
        .contains("`loads[0].force` is three numbers"));
    assert!(refused(json!({"loads": [{"faces": [face([1.0, 0.0, 0.0])], "push": 1}]})).contains("takes no 'push'"));
    assert!(refused(json!({"material": {"E": 2300}})).contains("`material.nu`"));
    assert!(refused(json!({"material": 7})).contains("`material` is a preset name"));
    assert!(refused(json!({"size": 0})).contains("`size`"));
    assert!(refused(json!({"maxElements": 1.5})).contains("`maxElements`"));
    assert!(refused(json!({"image": "yes"})).contains("`image`"));
    assert!(refused(json!({"refine": "Fine"})).contains("`refine` is off, standard or fine"));
    assert!(refused(json!({"refine": 2})).contains("`refine`"));
}

#[test]
fn the_report_names_the_peaks_the_balance_and_the_warnings() {
    let r = json!({
        "body": "body1", "name": "Bar",
        "material": {"name": "PLA", "E": 3500.0, "nu": 0.36, "yield": 50.0},
        "mesh": {"nodes": 1200, "elements": 600, "size": 2.5, "minDihedral": 11.2},
        "maxVonMises": {"value": 61.23456, "at": [0.0, 5.0, 5.0], "face": 0},
        "maxDisplacement": {"value": 0.84, "at": [100.0, 5.0, -5.0], "vector": [0.0, 0.01, -0.84]},
        "safetyFactor": 0.8165,
        "applied": [0.0, 0.0, -100.0], "reaction": [0.0, 0.0, 100.0],
        "warnings": ["printed parts are weaker across their layers"],
    });
    let text = report(&r, &["fixed".to_string()]);
    assert!(text.starts_with("Stress in body1 \"Bar\", PLA (E 3500 MPa, nu 0.36, yield 50 MPa):"), "{text}");
    assert!(text.contains("peak von Mises 61.23 MPa at (0, 5, 5) on face 0"), "{text}");
    assert!(text.contains("largest deflection 0.84 mm at (100, 5, -5)"), "{text}");
    assert!(text.contains("safety factor 0.8165 against yield, BELOW 1"), "{text}");
    assert!(text.contains("applied (0, 0, -100) N, reaction at the fixed faces (0, 0, 100) N"), "{text}");
    assert!(text.contains("mesh: 600 quadratic tetrahedra, 1200 nodes, element size 2.5 mm"), "{text}");
    assert!(text.ends_with("warnings:\n- printed parts are weaker across their layers"), "{text}");
    assert!(!text.contains("passes"), "{text}");

    let mut refined = r.clone();
    refined["mesh"] = json!({"nodes": 2900, "elements": 1700, "size": 2.5, "finest": 0.64, "minDihedral": 9.4,
        "passes": [{"elements": 600, "maxVonMises": 55.1}, {"elements": 1700, "maxVonMises": 61.23456}]});
    let text = report(&refined, &["fixed".to_string()]);
    assert!(text.contains("element size 2.5 mm, refined in 2 passes down to 0.64 mm, smallest dihedral"), "{text}");
    let mut one = refined.clone();
    one["mesh"]["passes"] = json!([{"elements": 1700, "maxVonMises": 61.23456}]);
    assert!(!report(&one, &["fixed".to_string()]).contains("passes"));
}

#[test]
fn supports_and_gravity_pass_through_named_in_order() {
    let r = request_of(&args(json!({
        "body": "body1",
        "fixed": face([-1.0, 0.0, 0.0]),
        "supports": [
            {"type": "pinned", "faces": [face([0.0, 1.0, 0.0])]},
            {"faces": face([0.0, 0.0, -1.0])},
        ],
        "gravity": [0, 0, -9.81],
        "material": {"E": 2300, "nu": 0.35, "density": 1.27},
    })))
    .expect("a good request");
    assert_eq!(r.supports, vec!["fixed", "supports[0] (pinned)", "supports[1] (fixed)"]);
    assert_eq!(r.payload["gravity"], json!([0, 0, -9.81]));
    assert_eq!(r.payload["supports"].as_array().map(Vec::len), Some(2));
    assert_eq!(r.payload["loads"], json!([]));
    // Supports alone hold the body, and an empty `fixed` beside them is dropped.
    let r = request_of(&args(json!({
        "body": "body1", "fixed": [],
        "supports": {"type": "Slider", "faces": face([0.0, 0.0, -1.0])},
        "loads": [{"faces": face([0.0, 0.0, 1.0]), "pressure": 0.1}],
        "gravity": false,
    })))
    .expect("supports alone");
    assert!(r.payload.get("fixed").is_none() && r.payload.get("gravity").is_none());
    assert_eq!(r.supports, vec!["supports[0] (slider)"]);
}

#[test]
fn spots_stand_in_for_faces_and_are_checked() {
    let spot = json!({"at": [95, 0, 5], "radius": 4});
    let r = request_of(&args(json!({
        "body": "body1",
        "supports": [{"spots": [{"at": [0, 0, 0], "radius": 3}]}],
        "loads": {"spots": spot, "force": [0, 0, -5], "faces": null},
    })))
    .expect("spots alone");
    assert_eq!(r.supports, vec!["supports[0] (fixed)"]);
    assert_eq!(r.payload["loads"], json!([{"spots": spot, "force": [0, 0, -5]}]));

    let refused = |patch: Value| {
        let mut a = json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]),
                           "loads": [{"spots": [spot], "force": [0, 0, -1]}]});
        for (k, v) in patch.as_object().expect("an object") {
            a[k] = v.clone();
        }
        request_of(&args(a)).err().expect("refused")
    };
    assert!(refused(json!({"loads": [{"spots": [{"at": [0, 0], "radius": 2}], "force": [0, 0, -1]}]}))
        .contains("`loads[0].spots[0]` is {at, radius}"));
    assert!(refused(json!({"loads": [{"spots": [{"at": [0, 0, 0], "radius": 0}], "force": [0, 0, -1]}]}))
        .contains("a radius in mm above 0"));
    assert!(refused(json!({"loads": [{"spots": [], "force": [0, 0, -1]}]})).contains("`loads[0].faces` is missing"));
    let slider = refused(json!({"supports": [{"type": "slider", "spots": [spot]}]}));
    assert!(slider.contains("`supports[0]` is slider and has spots"), "{slider}");
}

#[test]
fn malformed_supports_and_gravity_are_named() {
    let base = || {
        json!({"body": "body1", "supports": [{"type": "slider", "faces": face([0.0, 0.0, -1.0])}],
                         "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1]}]})
    };
    let refused = |patch: Value| {
        let mut a = base();
        for (k, v) in patch.as_object().expect("an object") {
            a[k] = v.clone();
        }
        request_of(&args(a)).err().expect("refused")
    };
    let none = refused(json!({"supports": null}));
    assert!(
        none.contains("`fixed` is missing, hold at least one face with `fixed`") && none.contains("`supports`"),
        "{none}"
    );
    assert!(refused(json!({"supports": [{"type": "glued", "faces": face([0.0, 0.0, 1.0])}]}))
        .contains("`supports[0].type` is fixed (held still), pinned"));
    assert!(refused(json!({"supports": [{"type": "slider"}]})).contains("`supports[0].faces` is missing"));
    assert!(refused(json!({"supports": [{"faces": face([0.0, 0.0, 1.0]), "axis": [0, 0, 1]}]}))
        .contains("`supports[0]` takes no 'axis'"));
    assert!(refused(json!({"supports": [7]})).contains("`supports[0]` is {type, faces}"));
    assert!(refused(json!({"gravity": "down"})).contains("`gravity` is true for 9.81 m/s2 along -Z"));
    assert!(refused(json!({"gravity": [0, -9.81]})).contains("`gravity`"));
    let dense = refused(json!({"gravity": true, "material": {"E": 2000, "nu": 0.3}}));
    assert!(dense.contains("`gravity` needs the material's density in g/cm3"), "{dense}");
    assert!(refused(json!({"material": {"E": 2000, "nu": 0.3, "density": 0}})).contains("`material.density`"));
    let no_load = refused(json!({"loads": []}));
    assert!(no_load.contains("or turn `gravity` on"), "{no_load}");
    // With gravity on the loads may be left out.
    let mut a = base();
    a.as_object_mut().unwrap().remove("loads");
    a["gravity"] = json!(true);
    assert!(request_of(&args(a.clone())).is_ok());
    // A vector of no length pulls nowhere: it is no gravity, so no load is refused, and
    // beside a load it is not sent on.
    a["gravity"] = json!([0, 0, 0]);
    let none = request_of(&args(a)).err().expect("refused");
    assert!(none.contains("`loads` is missing"), "{none}");
    let mut a = base();
    a["gravity"] = json!([0.0, -0.0, 0.0]);
    assert!(request_of(&args(a)).expect("a load").payload.get("gravity").is_none());
}

#[test]
fn the_report_names_the_weight_and_each_supports_reaction() {
    let r = json!({
        "body": "body1",
        "material": {"name": "PLA", "E": 3500.0, "nu": 0.36, "yield": 50.0, "density": 1.24},
        "maxVonMises": {"value": 1.0, "at": [0.0, 0.0, 0.0], "face": 0},
        "applied": [0.0, 0.0, -100.121644], "weight": [0.0, 0.0, -0.121644],
        "reaction": [0.0, 0.0, 100.121644],
        "reactions": [[0.0, 0.0, 60.0], [0.0, 0.0, 40.121644]],
    });
    let names = ["fixed".to_string(), "supports[0] (slider)".to_string()];
    let text = report(&r, &names);
    assert!(text.contains("applied (0, 0, -100.1) N, reaction at the supports (0, 0, 100.1) N"), "{text}");
    assert!(text.contains("\nweight (0, 0, -0.1216) N from gravity, part of the applied load\n"), "{text}");
    assert!(
        text.contains("reaction at each support:\n- fixed: (0, 0, 60) N\n- supports[0] (slider): (0, 0, 40.12) N"),
        "{text}"
    );
    // One support and no gravity add no weight and no per support lines.
    let one = json!({"applied": [0.0, 0.0, -1.0], "reaction": [0.0, 0.0, 1.0], "weight": null,
                     "reactions": [[0.0, 0.0, 1.0]]});
    let text = report(&one, &["supports[0] (pinned)".to_string()]);
    assert!(text.contains("reaction at the supports (0, 0, 1) N"), "{text}");
    assert!(!text.contains("weight") && !text.contains("each support"), "{text}");
}

#[test]
fn the_surface_is_coloured_from_low_to_high_and_outlines_its_faces() {
    // Two triangles of a square on different faces, sharing the diagonal.
    let r = json!({"body": "body1", "surface": {
        "positions": [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        "indices": [0, 1, 2, 0, 2, 3],
        "faceIds": [0, 1],
        "vonMises": [0.0, 5.0, 10.0, 5.0],
    }});
    let s = surface_of(&r).expect("a surface");
    assert_eq!(s.colors[0], stress_color(0.0));
    assert_eq!(s.colors[2], stress_color(1.0));
    assert_eq!(s.edges.len(), 1);
    assert_eq!((s.low, s.high), (0.0, 10.0));
    assert!(s.scale().contains("blue 0 MPa to red 10 MPa"), "{}", s.scale());
}
