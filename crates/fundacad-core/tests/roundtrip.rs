//! Every document in the repository survives a load and save unchanged, and the
//! known feature, entity, constraint, pattern and selector forms really land in
//! their typed variants rather than in `Unknown`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fundacad_core::schema::{Feature, Selector, SketchConstraint, SketchEntity, SketchPattern};
use fundacad_core::CadDocument;
use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// (label, document) for every real document the repository holds.
fn documents() -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for name in ["python_engine_tests.json", "plugin_tests.json", "app_shapes.json"] {
        let Value::Array(rows) = read(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
        ) else {
            panic!("{name} is not an array");
        };
        for (i, row) in rows.into_iter().enumerate() {
            let label = format!("{name}[{i}] {}", row["source"].as_str().unwrap_or(""));
            out.push((label, row["doc"].clone()));
        }
    }
    for corpus in [
        "tests/golden/corpus/corpus_fillet.json",
        "tests/golden/corpus/corpus_fillet_regression.json",
    ] {
        let v = read(&repo().join(corpus));
        for case in v["cases"].as_array().expect("cases") {
            out.push((format!("{corpus} {}", case["id"]), case["doc"].clone()));
        }
    }
    let funda = "tests/fixtures/textured_box.funda";
    out.push((funda.to_owned(), read(&repo().join(funda))));
    out
}

#[derive(Default)]
struct Coverage {
    known: BTreeMap<String, usize>,
    unknown: BTreeMap<String, usize>,
    invalid: BTreeMap<String, usize>,
}

#[derive(Clone, Copy)]
enum Landed {
    Known,
    Unknown,
    Invalid,
}

impl Coverage {
    fn add(&mut self, name: Option<&str>, landed: Landed) {
        let key = name.unwrap_or("<no type>").to_owned();
        let map = match landed {
            Landed::Known => &mut self.known,
            Landed::Unknown => &mut self.unknown,
            Landed::Invalid => &mut self.invalid,
        };
        *map.entry(key).or_default() += 1;
    }
}

macro_rules! landed {
    ($v:expr) => {
        if $v.is_unknown() {
            Landed::Unknown
        } else if $v.is_invalid() {
            Landed::Invalid
        } else {
            Landed::Known
        }
    };
}

/// Documents the Python tests build broken on purpose, to test the error the
/// engine gives. They must load and round trip, with the broken part `Invalid`.
const DELIBERATELY_BROKEN: &[&str] = &[
    "test_body_targets.py::test_a_missing_field_names_the_field",
    "test_datum_face.py::test_an_unresolvable_face_falls_back_to_the_cache",
    "test_hole_feature.py::test_bad_inputs_are_named",
    "test_sketch_on_face.py::test_a_reference_that_resolves_to_nothing_keeps_the_cache_and_says_so",
];

fn selectors_of(v: &Value, out: &mut Vec<Value>) {
    match v {
        Value::Object(m) => {
            if m.get("kind").is_some_and(|k| k == "edge" || k == "face") && m.contains_key("by") {
                out.push(v.clone());
            }
            m.values().for_each(|x| selectors_of(x, out));
        }
        Value::Array(a) => a.iter().for_each(|x| selectors_of(x, out)),
        _ => {}
    }
}

#[test]
fn every_repository_document_round_trips_and_lands_typed() {
    let docs = documents();
    assert!(
        docs.len() > 1000,
        "expected the fixture and corpus documents, found {}",
        docs.len()
    );

    let mut features = Coverage::default();
    let mut entities = Coverage::default();
    let mut constraints = Coverage::default();
    let mut patterns = Coverage::default();
    let mut selectors = Coverage::default();
    let mut failures = Vec::new();
    let mut invalid_docs = Vec::new();

    for (label, raw) in &docs {
        let doc: CadDocument = match serde_json::from_value(raw.clone()) {
            Ok(d) => d,
            Err(e) => {
                failures.push(format!("{label}: does not load: {e}"));
                continue;
            }
        };
        let back = serde_json::to_value(&doc).expect("serialize");
        if &back != raw {
            failures.push(format!(
                "{label}: changed in a round trip\n  before {raw}\n  after  {back}"
            ));
            continue;
        }
        let text = doc.to_json().expect("to_json");
        assert_eq!(
            CadDocument::from_json(&text).expect("from_json"),
            doc,
            "{label}"
        );

        let before =
            features.invalid.values().sum::<usize>() + selectors.invalid.values().sum::<usize>();
        for f in &doc.features {
            features.add(f.type_name(), landed!(f));
            if let Feature::Sketch(s) = f {
                s.entities
                    .iter()
                    .for_each(|e| entities.add(e.type_name(), landed!(e)));
                s.constraints
                    .iter()
                    .flatten()
                    .for_each(|c| constraints.add(c.type_name(), landed!(c)));
                s.patterns
                    .iter()
                    .flatten()
                    .for_each(|p| patterns.add(p.type_name(), landed!(p)));
            }
        }
        let mut sels = Vec::new();
        selectors_of(raw, &mut sels);
        for s in sels {
            let parsed: Selector = serde_json::from_value(s.clone()).expect("selector");
            let name = format!(
                "{}:{}",
                s["kind"].as_str().unwrap_or(""),
                s["by"].as_str().unwrap_or("")
            );
            let landed = match parsed {
                Selector::Known(_) => Landed::Known,
                Selector::Unknown(_) => Landed::Unknown,
                Selector::Invalid(_) => Landed::Invalid,
            };
            selectors.add(Some(&name), landed);
        }
        if features.invalid.values().sum::<usize>() + selectors.invalid.values().sum::<usize>()
            > before
        {
            invalid_docs.push(label.clone());
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} documents failed:\n{}",
        failures.len(),
        docs.len(),
        failures.join("\n")
    );

    let report = |title: &str, c: &Coverage| {
        eprintln!("{title}:");
        for (k, n) in &c.known {
            eprintln!("  {k:<22} {n}");
        }
        for (k, n) in &c.unknown {
            eprintln!("  {k:<22} {n} (unknown)");
        }
        for (k, n) in &c.invalid {
            eprintln!("  {k:<22} {n} (invalid)");
        }
    };
    eprintln!("{} documents round-tripped", docs.len());
    report("features", &features);
    report("sketch entities", &entities);
    report("constraints", &constraints);
    report("sketch patterns", &patterns);
    report("selectors", &selectors);

    let check = |title: &str, c: &Coverage, known: &[&str]| {
        for k in known {
            assert!(
                c.known.get(*k).copied().unwrap_or(0) > 0,
                "{title} {k} never parsed as typed"
            );
            assert!(!c.unknown.contains_key(*k), "{title} {k} fell into Unknown");
        }
    };
    check("feature", &features, Feature::KNOWN);
    check("entity", &entities, SketchEntity::KNOWN);
    check("constraint", &constraints, SketchConstraint::KNOWN);
    check("pattern", &patterns, SketchPattern::KNOWN);
    for sel in [
        "edge:axis",
        "edge:nearest",
        "edge:all",
        "face:normal",
        "face:nearest",
        "edge:match",
        "face:match",
        "edge:tangentChain",
        "edge:ofFace",
    ] {
        check("selector", &selectors, &[sel]);
    }

    for label in &invalid_docs {
        assert!(
            DELIBERATELY_BROKEN.iter().any(|b| label.contains(b)),
            "{label} has an Invalid feature or selector but is not a known broken document"
        );
    }
    eprintln!(
        "{} documents are broken on purpose and loaded with Invalid parts",
        invalid_docs.len()
    );

    for plugin in ["texture", "teardropHole", "combine"] {
        assert!(
            features.unknown.get(plugin).copied().unwrap_or(0) > 0,
            "{plugin} should be carried as Unknown"
        );
    }
}

#[test]
fn unknown_data_is_carried_and_typed_data_is_reachable() {
    let v = read(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/app_shapes.json"));
    let doc: CadDocument = serde_json::from_value(v[0]["doc"].clone()).expect("load");
    assert_eq!(
        doc.extra
            .get("futureTopLevelKey")
            .map(|x| x["anything"][2].clone()),
        Some(Value::from("x"))
    );
    assert_eq!(doc.rollback, Some(None));
    let Some(Feature::Extrude(e)) = doc.feature("f2") else {
        panic!("f2 is an extrude")
    };
    assert_eq!(e.distance.as_number(), Some(25.0));
    assert!(matches!(&e.active_when, Some(fundacad_core::schema::Num::Expr(n)) if n == "solid"));
    assert_eq!(doc.feature("f38").map(Feature::id), Some("f38"));
    assert!(doc
        .feature("f38")
        .is_some_and(|f| f.active_when().is_some()));

    let odd: CadDocument = serde_json::from_value(v[1]["doc"].clone()).expect("load");
    let Feature::Sketch(s) = &odd.features[0] else {
        panic!("sketch")
    };
    assert!(s.entities[0].is_unknown());
    let SketchEntity::Circle(c) = &s.entities[1] else {
        panic!("circle")
    };
    assert_eq!(c.extra.get("futureFlag"), Some(&Value::from(2.5)));
    let Feature::Extrude(e) = &odd.features[1] else {
        panic!("extrude")
    };
    assert_eq!(e.operation.as_str(), "emboss");
    assert_eq!(odd.rollback.clone().flatten().map(|r| r.get()), Some(3.0));
}

#[test]
fn a_known_type_that_does_not_fit_loads_as_invalid_and_saves_unchanged() {
    let bad = serde_json::json!({"parameters": {}, "features": [{"id": "x", "type": "extrude", "sketch": "s"}]});
    let doc: CadDocument = serde_json::from_value(bad.clone()).expect("loads");
    let Feature::Invalid(i) = &doc.features[0] else {
        panic!("invalid")
    };
    assert!(i.error.contains("distance"), "{}", i.error);
    assert_eq!(doc.features[0].id(), "x");
    assert_eq!(serde_json::to_value(&doc).expect("save"), bad);
}

#[test]
fn legacy_parameter_names_resolve_and_expressions_do_not() {
    use fundacad_core::schema::Num;
    let doc: CadDocument =
        serde_json::from_value(serde_json::json!({"parameters": {"w": 40}, "features": []}))
            .expect("load");
    assert_eq!(Num::Expr("w".into()).resolve(|n| doc.param(n)), Ok(40.0));
    assert!(Num::Expr("w/2".into()).resolve(|n| doc.param(n)).is_err());
}

#[test]
fn a_pattern_carries_the_features_it_repeats() {
    let raw = serde_json::json!({"parameters": {"n": 6}, "features": [
        {"id": "pc", "type": "patternCircular", "count": "n", "angle": 360, "axis": "Z", "features": ["h"]},
        {"id": "pl", "type": "patternLinear", "count": 3, "spacing": 10, "axis": "X", "features": ["h", "pc"]},
        {"id": "pr", "type": "patternRect", "countX": 2, "countY": 2, "spacingX": 5, "spacingY": 5, "features": ["h"]},
        {"id": "pb", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z", "bodies": ["body1"]}
    ]});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("load");
    let Some(Feature::PatternCircular(pc)) = doc.feature("pc") else {
        panic!("pc is a circular pattern")
    };
    assert_eq!(pc.features.as_deref(), Some(&["h".to_owned()][..]));
    assert!(pc.bodies.is_none() && pc.extra.is_empty());
    let Some(Feature::PatternLinear(pl)) = doc.feature("pl") else {
        panic!("pl is a linear pattern")
    };
    assert_eq!(pl.features.as_ref().map(Vec::len), Some(2));
    let Some(Feature::PatternRect(pr)) = doc.feature("pr") else {
        panic!("pr is a rect pattern")
    };
    assert!(pr.features.is_some() && pr.extra.is_empty());
    let Some(Feature::PatternCircular(pb)) = doc.feature("pb") else {
        panic!("pb is a circular pattern")
    };
    assert!(pb.features.is_none());
    assert_eq!(serde_json::to_value(&doc).expect("save"), raw);
}

#[test]
fn a_circular_pattern_axis_is_a_name_a_line_a_datum_or_a_reference() {
    use fundacad_core::schema::{Axis3, PatternAxis};
    let raw = serde_json::json!({"parameters": {}, "features": [
        {"id": "old", "type": "patternCircular", "count": 6, "angle": 360, "axis": "Z", "features": ["h"]},
        {"id": "line", "type": "patternCircular", "count": 6, "angle": 360,
         "axis": {"origin": [30, 30, 0], "dir": [0, 0, 1]}, "features": ["h"]},
        {"id": "datum", "type": "patternCircular", "count": 6, "angle": 360, "axis": {"datum": "ax1"}, "features": ["h"]},
        {"id": "picked", "type": "patternCircular", "count": 6, "angle": 360,
         "axis": {"origin": [30, 30, 0], "dir": [0, 0, 1]},
         "axisRef": {"kind": "face", "by": "nearest", "point": [35, 30, 5], "body": "body1"},
         "features": ["h"]},
        {"id": "rect", "type": "patternRect", "countX": 2, "countY": 1, "spacingX": 20, "spacingY": 0,
         "bodies": ["body1"]}
    ]});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("load");
    let pc = |id: &str| match doc.feature(id) {
        Some(Feature::PatternCircular(p)) => p.clone(),
        other => panic!("{id} is a circular pattern, got {other:?}"),
    };
    assert_eq!(pc("old").axis, PatternAxis::Named(Axis3::Z));
    assert!(pc("old").axis_ref.is_none() && pc("old").extra.is_empty());
    assert!(matches!(pc("line").axis, PatternAxis::Line(_)));
    assert!(matches!(&pc("datum").axis, PatternAxis::Datum(d) if d.datum == "ax1" && d.extra.is_empty()));
    let picked = pc("picked");
    assert_eq!(picked.axis_ref.as_ref().and_then(|s| s.kind()), Some("face"));
    assert!(picked.extra.is_empty());
    let Some(Feature::PatternRect(pr)) = doc.feature("rect") else {
        panic!("rect is a rect pattern")
    };
    assert_eq!(pr.bodies.as_deref(), Some(&["body1".to_owned()][..]));
    assert!(pr.extra.is_empty());
    assert_eq!(serde_json::to_value(&doc).expect("save"), raw);
}

/// What a build from before placed axes (main at 286c7c8e) makes of each form.
/// Its `patternCircular` was this struct; a known type that does not fit its
/// struct loads as `Feature::Invalid` and builds as an error naming the
/// feature, so every form but X, Y and Z is refused there, never turned about
/// world Z. A bare datum id is what it would misread, which is why a datum
/// axis is `{datum}`.
#[test]
fn a_build_before_placed_axes_refuses_every_new_axis_form() {
    use fundacad_core::schema::{Axis3, Extra, Num};
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct BeforePlacedAxes {
        id: String,
        count: Num,
        angle: Num,
        axis: Axis3,
        #[serde(default)]
        bodies: Option<Vec<String>>,
        #[serde(default)]
        features: Option<Vec<String>>,
        #[serde(default)]
        active_when: Option<Num>,
        #[serde(flatten)]
        extra: Extra,
    }
    let with = |axis: Value| {
        serde_json::json!({"id": "pc", "type": "patternCircular", "count": 6, "angle": 360, "axis": axis})
    };
    let before = |axis: Value| serde_json::from_value::<BeforePlacedAxes>(with(axis));
    assert_eq!(before(serde_json::json!("Z")).expect("X, Y, Z as ever").axis, Axis3::Z);
    for axis in [
        serde_json::json!({"origin": [30, 30, 0], "dir": [0, 0, 1]}),
        serde_json::json!({"datum": "ax1"}),
    ] {
        assert!(before(axis.clone()).is_err(), "{axis} is refused");
    }
    let mut picked = with(serde_json::json!({"origin": [30, 30, 0], "dir": [0, 0, 1]}));
    picked["axisRef"] = serde_json::json!({"kind": "edge", "by": "nearest", "point": [0, 0, 0]});
    assert!(serde_json::from_value::<BeforePlacedAxes>(picked).is_err(), "axisRef rides on a line");
    assert_eq!(before(serde_json::json!("ax1")).expect("a bare id loads").axis, Axis3::Other("ax1".into()));
    let unfit: Feature = serde_json::from_value(with(serde_json::json!(5))).expect("load");
    assert!(matches!(unfit, Feature::Invalid(_)), "{unfit:?}");
}
