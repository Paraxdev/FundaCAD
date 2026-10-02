//! The `stress` tool: a cantilever against the real engine, with its report
//! and its picture, arguments refused before the engine is asked anything,
//! and a body that is not there named alongside the features that failed.

mod common;

use std::collections::BTreeMap;

use common::{FakeEngine, Mcp};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

fn face(dir: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "normal", "dir": dir, "body": "body1"})
}

/// The number after `label` in the report, up to the next space.
fn number_after(text: &str, label: &str) -> f64 {
    let at = text.find(label).unwrap_or_else(|| panic!("no '{label}' in {text}"));
    let rest = &text[at + label.len()..];
    let end = rest.find(' ').unwrap_or(rest.len());
    rest[..end].parse().unwrap_or_else(|_| panic!("no number after '{label}' in {text}"))
}

/// A PNG's width and height, from its header.
fn png_size(png: &[u8]) -> (u32, u32) {
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"), "not a PNG");
    let be = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
    (be(16), be(20))
}

#[test]
fn a_cantilever_answers_with_its_peaks_its_balance_and_a_picture() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    // A 100 x 10 x 10 aluminium bar from x = 0 to 100, held at x = 0 and
    // pushed down 100 N at x = 100.
    let r = mcp.call(
        "edit",
        json!({"ops": [
            {"op": "add", "feature": {"type": "box", "length": 100, "width": 10, "height": 10, "name": "Bar"}},
            {"op": "add", "feature": {"type": "move", "dx": 50, "bodies": ["body1"]}}
        ], "build": true}),
    );
    assert!(!r.is_error, "{}", r.text);
    let r = mcp.call(
        "stress",
        json!({"body": "Bar", "fixed": face([-1.0, 0.0, 0.0]),
               "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -100]}],
               "material": "aluminium", "size": 2.5, "view": "front", "width": 400, "height": 300}),
    );
    assert!(!r.is_error, "{}", r.text);
    let text = &r.text;
    assert!(
        text.starts_with("Stress in body1 \"Bar\", aluminium 6061-T6 (E 69000 MPa, nu 0.33, yield 275 MPa):"),
        "{text}"
    );

    // Euler-Bernoulli plus shear: P L^3 / 3 E I + P L / k G A is 0.584 mm.
    let deflection = number_after(text, "largest deflection ");
    assert!((deflection - 0.584).abs() < 0.05 * 0.584, "{deflection}\n{text}");
    // M c / I at the root is 60 MPa; the corner where the fixture ends reads higher.
    let peak = number_after(text, "peak von Mises ");
    assert!(peak > 50.0 && peak < 200.0, "{peak}\n{text}");
    let sf = number_after(text, "safety factor ");
    assert!((sf - 275.0 / peak).abs() < 0.01 * sf, "{sf} vs {}", 275.0 / peak);
    assert!(text.contains("applied (0, 0, -100) N, reaction at the fixed faces (0, 0, 100) N"), "{text}");
    assert!(text.contains(" quadratic tetrahedra, "), "{text}");
    assert!(text.contains("warnings:\n- "), "{text}");
    assert!(text.contains("where a fixed face ends"), "{text}");
    assert!(text.contains("\nfront view of body1, 400x300. Coloured by von Mises stress, blue "), "{text}");
    assert!(text.ends_with(" MPa, the bar at the right is the scale."), "{text}");

    assert_eq!(r.images.len(), 1, "{text}");
    assert_eq!(png_size(&r.images[0]), (400, 300));

    // The report alone, when the picture is not wanted.
    let r = mcp.call(
        "stress",
        json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]),
               "loads": {"faces": face([1.0, 0.0, 0.0]), "pressure": 1},
               "material": {"E": 2300, "nu": 0.35, "name": "my PETG"}, "size": 2.5, "image": false}),
    );
    assert!(!r.is_error, "{}", r.text);
    assert!(r.images.is_empty());
    assert!(r.text.contains("my PETG (E 2300 MPa, nu 0.35):"), "{}", r.text);
    assert!(r.text.contains("no safety factor, the material has no yield strength"), "{}", r.text);
    // 1 MPa on the 10 x 10 end is 100 N along -X.
    assert!(r.text.contains("applied (-100, 0, 0) N"), "{}", r.text);

    // A body that is not there is named, with the bodies there are and the
    // feature that failed, which may be why.
    let r = mcp.call(
        "feature_add",
        json!({"feature": {"id": "fil1", "type": "fillet",
                           "edges": {"kind": "edge", "by": "all", "body": "body1"}, "radius": 500}}),
    );
    assert!(!r.is_error, "{}", r.text);
    let r = mcp.call(
        "stress",
        json!({"body": "Spring", "fixed": face([-1.0, 0.0, 0.0]),
               "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1]}]}),
    );
    assert!(r.is_error, "{}", r.text);
    assert!(r.text.starts_with("no body 'Spring' in this build, have body1 \"Bar\"."), "{}", r.text);
    assert!(r.text.contains("FEATURE FAILED (fil1)"), "{}", r.text);

    // An argument the tool does not take is refused by name.
    let r = mcp.call(
        "stress",
        json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]),
               "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1]}], "force": [0, 0, -1]}),
    );
    assert!(r.is_error, "{}", r.text);
    assert!(r.text.starts_with("stress takes no argument 'force', nothing was done."), "{}", r.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_arguments_are_refused_before_the_engine_is_asked() {
    let engine = FakeEngine::always(json!({"ok": true, "result": {}}));
    let srv = FundaCad::with_link(engine.link());
    let good_load = json!([{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1]}]);
    let cases = [
        (json!({"fixed": face([-1.0, 0.0, 0.0]), "loads": good_load}), "`body` is missing"),
        (json!({"body": "body1", "loads": good_load}), "`fixed` is missing"),
        (json!({"body": "body1", "fixed": [4], "loads": good_load}), "`fixed[0]` is not a face selector"),
        (json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0])}), "`loads` is missing"),
        (
            json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]),
                   "loads": [{"faces": [face([1.0, 0.0, 0.0])]}]}),
            "`loads[0]` needs a force [x, y, z] in N or a pressure in MPa",
        ),
        (
            json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]), "loads": good_load,
                   "material": {"E": -1, "nu": 0.3}}),
            "`material.E`",
        ),
        (
            json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]), "loads": good_load, "size": -2}),
            "`size`",
        ),
        (
            json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]), "loads": good_load, "view": "under"}),
            "no view 'under'",
        ),
    ];
    for (args, want) in cases {
        let args: Map<String, Value> = args.as_object().cloned().unwrap_or_default();
        let r = srv.t_stress(args).await.expect("a tool never errors out");
        let text = common::text_of(&r);
        assert!(common::is_error(&r), "{text}");
        assert!(text.contains(want), "{want}: {text}");
    }
    assert!(engine.ops().is_empty(), "{:?}", engine.ops());
}
