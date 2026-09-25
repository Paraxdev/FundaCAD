//! A region seed picks from the sketch it names, and model edges cut its areas
//! only where coplanar material starts or stops.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn rect(id: &str, plane: &str, (x1, y1): (Value, Value), (x2, y2): (Value, Value)) -> Value {
    json!({"id": id, "type": "sketch", "plane": plane, "constraints": [], "entities": [
        {"id": "e1", "type": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y1},
        {"id": "e2", "type": "line", "x1": x2, "y1": y1, "x2": x2, "y2": y2},
        {"id": "e3", "type": "line", "x1": x2, "y1": y2, "x2": x1, "y2": y2},
        {"id": "e4", "type": "line", "x1": x1, "y1": y2, "x2": x1, "y2": y1},
    ]})
}

fn extrude(id: &str, sketch: &str, distance: Value, seed: [f64; 3]) -> Value {
    json!({"id": id, "type": "extrude", "sketch": sketch, "distance": distance,
           "operation": "new", "regions": [seed]})
}

fn revolve(id: &str, sketch: &str, seed: [f64; 3]) -> Value {
    json!({"id": id, "type": "revolve", "sketch": sketch, "axis": "Z", "angle": 180,
           "operation": "new", "regions": [seed]})
}

fn frame_params() -> Value {
    json!({"base_w": 20, "base_h": 40, "upright_size": 20,
           "frame_width": 480, "frame_depth": 460, "upright_len": 440})
}

/// The tester's order: shape A, shape B, then A again.
fn frame_steps() -> Vec<Vec<Value>> {
    vec![
        vec![
            rect(
                "f1",
                "XY",
                (json!(0), json!(0)),
                (json!("base_w"), json!("base_h")),
            ),
            extrude("f3", "f1", json!("frame_depth"), [10.0, 20.0, 0.0]),
        ],
        vec![
            rect(
                "f2",
                "XY",
                (json!(0), json!(0)),
                (json!("upright_size"), json!("upright_size")),
            ),
            extrude("f4", "f2", json!("upright_len"), [10.0, 10.0, 0.0]),
        ],
        vec![
            rect(
                "f9",
                "XY",
                (json!(0), json!(0)),
                (json!("base_w"), json!("base_h")),
            ),
            extrude("f10", "f9", json!("frame_width"), [10.0, 20.0, 0.0]),
        ],
    ]
}

fn revolve_steps() -> Vec<Vec<Value>> {
    vec![
        vec![
            rect("f1", "XZ", (json!(10), json!(0)), (json!(30), json!(40))),
            revolve("f3", "f1", [20.0, 0.0, 20.0]),
        ],
        vec![
            rect("f2", "XZ", (json!(10), json!(0)), (json!(30), json!(20))),
            revolve("f4", "f2", [20.0, 0.0, 10.0]),
        ],
        vec![
            rect("f9", "XZ", (json!(10), json!(0)), (json!(30), json!(40))),
            revolve("f10", "f9", [20.0, 0.0, 20.0]),
        ],
    ]
}

fn doc(params: &Value, steps: &[Vec<Value>]) -> Value {
    json!({"parameters": params, "features": steps.concat()})
}

fn sizes(r: &Rebuild) -> Vec<(String, [i64; 3])> {
    assert!(
        r.errors.is_empty(),
        "{:?}",
        r.errors.iter().map(|e| e.wire()).collect::<Vec<_>>()
    );
    r.bodies
        .iter()
        .map(|b| {
            let bb = kernel::bbox(&b.shape).expect("a body has a box");
            (
                b.id.clone(),
                [0, 1, 2].map(|k| (bb[k + 3] - bb[k]).round() as i64),
            )
        })
        .collect()
}

/// Built the way the MCP builds, one feature pair at a time against one cache,
/// then cold, and every prefix has to agree.
fn build_incrementally(params: Value, steps: Vec<Vec<Value>>) -> Vec<(String, [i64; 3])> {
    let mut cache = RebuildCache::new(None);
    let mut last = Vec::new();
    for n in 1..=steps.len() {
        let raw = doc(&params, &steps[..n]);
        let typed: CadDocument = serde_json::from_value(raw.clone()).unwrap();
        let warm = cache
            .rebuild(&typed, &raw, &NoWatch)
            .unwrap_or_else(|_| panic!("cancelled"));
        let cold = builder::rebuild(&typed, &raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
        last = sizes(&warm);
        assert_eq!(
            last,
            sizes(&cold),
            "a warm build of {n} steps differs from a cold one"
        );
    }
    last
}

#[test]
fn a_repeated_frame_profile_extrudes_its_own_sketch() {
    let got = build_incrementally(frame_params(), frame_steps());
    assert_eq!(
        got,
        [
            ("body1".to_owned(), [20, 40, 460]),
            ("body2".to_owned(), [20, 20, 440]),
            ("body3".to_owned(), [20, 40, 480])
        ]
    );
}

#[test]
fn a_repeated_revolve_profile_revolves_its_own_sketch() {
    let got = build_incrementally(json!({}), revolve_steps());
    assert_eq!(got[2].0, "body3");
    assert_eq!(
        got[2].1[2], 40,
        "the third revolve lost part of its profile: {got:?}"
    );
    assert_eq!(got[0].1, got[2].1);
}

#[test]
fn a_profile_running_off_a_face_still_picks_the_overhang_alone() {
    let raw = json!({"features": [
        rect("f1", "XY", (json!(0), json!(0)), (json!(20), json!(20))),
        extrude("f2", "f1", json!(10), [10.0, 10.0, 0.0]),
        rect("f3", "XY", (json!(0), json!(0)), (json!(20), json!(40))),
        extrude("f4", "f3", json!(5), [10.0, 30.0, 0.0]),
    ]});
    let typed: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let r = builder::rebuild(&typed, &raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    let got = sizes(&r);
    assert_eq!(got[1], ("body2".to_owned(), [20, 20, 5]));
}

fn build(features: Vec<Value>) -> Vec<(String, [i64; 3])> {
    let raw = json!({ "features": features });
    let typed: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    sizes(&builder::rebuild(&typed, &raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled")))
}

fn block(id: &str, sketch: &str, (x1, y1): (f64, f64), (x2, y2): (f64, f64)) -> Vec<Value> {
    vec![
        rect(sketch, "XY", (json!(x1), json!(y1)), (json!(x2), json!(y2))),
        extrude(id, sketch, json!(10), [(x1 + x2) / 2.0, (y1 + y2) / 2.0, 0.0]),
    ]
}

/// Material stops 3 mm before the end of a 20 mm edge, between any fixed samples
/// of it, so only cutting the edge where it happens finds it.
#[test]
fn material_stopping_partway_along_an_edge_still_cuts_there() {
    let pick = |seed: [f64; 3]| {
        let mut f = block("a", "sa", (0.0, 0.0), (20.0, 20.0));
        f.extend(block("b", "sb", (20.0, 0.0), (40.0, 17.0)));
        f.push(rect("s", "XY", (json!(10), json!(10)), (json!(30), json!(30))));
        f.push(extrude("e", "s", json!(5), seed));
        build(f)[2].1
    };
    assert_eq!(pick([15.0, 15.0, 0.0]), [20, 10, 5], "the area over the two blocks");
    assert_eq!(pick([25.0, 25.0, 0.0]), [20, 13, 5], "the area off them");
}

/// A frame corner: the cross rail's end overlaps the side rail, so each rail's
/// edge is half inside the other and half a real outline.
#[test]
fn a_gusset_over_overlapping_rail_ends_picks_the_whole_corner() {
    let mut f = block("side", "s1", (0.0, 0.0), (20.0, 460.0));
    f.extend(block("cross", "s2", (0.0, 0.0), (480.0, 20.0)));
    f.push(rect("g", "XY", (json!(0), json!(0)), (json!(40), json!(40))));
    f.push(extrude("gusset", "g", json!(5), [10.0, 10.0, 0.0]));
    assert_eq!(build(f)[2].1, [40, 40, 5]);
}

/// What the overlay splits with is the union's outline, nothing inside it.
#[test]
fn the_overlay_cuts_are_the_outline_of_the_coplanar_material() {
    let mut f = block("side", "s1", (0.0, 0.0), (20.0, 460.0));
    f.extend(block("cross", "s2", (0.0, 0.0), (480.0, 20.0)));
    let raw = json!({ "features": f });
    let typed: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let r = builder::rebuild(&typed, &raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    let shapes: Vec<_> = r.bodies.iter().map(|b| &b.shape).collect();
    let cuts = kernel::profile_cuts(&shapes, [0.0; 3], [0.0, 0.0, 1.0], 600.0, 0.1).unwrap();
    let length: f64 = cuts
        .iter()
        .flat_map(|l| l.windows(2))
        .map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt())
        .sum();
    assert!((length - 2.0 * (480.0 + 460.0)).abs() < 1e-6, "outline length {length}");
    let top = kernel::profile_cuts(&shapes, [0.0, 0.0, 10.0], [0.0, 0.0, 1.0], 600.0, 0.1).unwrap();
    assert_eq!(top.len(), cuts.len());
}
