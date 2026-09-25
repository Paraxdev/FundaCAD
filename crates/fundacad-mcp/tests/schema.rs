//! The schema, held to the engine. A port of
//! the Python MCP server's `test_schema.py`.
//!
//! `schema.json` is hand-written, because the authority, `src/types.ts`, is a
//! TypeScript union whose value is in its comments, and no generator turns that
//! into prose worth reading. Hand-written documentation rots, and this is the
//! test that stops it: every type documented there must be one the document
//! schema knows, and every type it knows must be documented.
//!
//! Without this, a new feature type ships and the agent that could have used it
//! never hears about it. The failure mode is silence, which is the kind no
//! end-to-end test finds.

use std::collections::BTreeSet;

use fundacad_core::schema::Feature;
use fundacad_mcp::schema as s;
use serde_json::Value;

/// Types a PLUGIN owns outright, geometry included (docs/PLUGINS.md). The core
/// schema carries them as unknown features and the engine hands them to the
/// plugin host, so they are not in `Feature::KNOWN` and must not be: an entry
/// here is a claim that this build ships that plugin, which is worth failing on
/// if it ever stops being true.
const PLUGIN_TYPES: &[&str] = &[
    "counterboreBridge",
    "elephantFootChamfer",
    "roofBridge",
    "sacrificialLayer",
    "teardropHole",
    "texture",
    "threadRibs",
    "verticalFillet",
    "zipTieChannel",
];

fn documented() -> BTreeSet<String> {
    s::features().keys().cloned().collect()
}

fn buildable() -> BTreeSet<String> {
    Feature::KNOWN
        .iter()
        .map(|s| (*s).to_string())
        .chain(PLUGIN_TYPES.iter().map(|s| (*s).to_string()))
        .collect()
}

#[test]
fn every_documented_type_is_one_the_engine_handles() {
    let (doc, build) = (documented(), buildable());
    let unknown: Vec<&String> = doc.difference(&build).collect();
    assert!(unknown.is_empty(), "documented but not buildable: {unknown:?}");
}

#[test]
fn every_buildable_type_is_documented() {
    let (doc, build) = (documented(), buildable());
    let missing: Vec<&String> = build.difference(&doc).collect();
    assert!(
        missing.is_empty(),
        "the engine handles {missing:?} and the schema does not mention them, an agent reading \
         this schema cannot use them"
    );
}

#[test]
fn every_entry_has_a_summary_and_fields() {
    for (kind, e) in s::features() {
        assert!(
            e.get("summary").and_then(Value::as_str).is_some_and(|t| !t.is_empty()),
            "{kind}"
        );
        assert!(
            e.get("fields")
                .and_then(Value::as_object)
                .is_some_and(|f| !f.is_empty()),
            "{kind}"
        );
    }
}

#[test]
fn every_example_matches_its_own_type() {
    for (kind, e) in s::features() {
        let Some(ex) = e.get("example").filter(|v| !v.is_null()) else {
            continue;
        };
        assert_eq!(
            ex.get("type").and_then(Value::as_str),
            Some(kind.as_str()),
            "{kind} example says type {:?}",
            ex.get("type")
        );
        assert!(
            ex.get("id").and_then(Value::as_str).is_some_and(|i| !i.is_empty()),
            "{kind} example has no id"
        );
        serde_json::to_string(ex).expect("it has to survive the wire");
    }
}

#[test]
fn the_examples_only_use_documented_fields() {
    // An example is the thing an agent copies, so a field in one that is not in
    // the field list is a field nobody can look up.
    for (kind, e) in s::features() {
        let Some(ex) = e.get("example").and_then(Value::as_object) else {
            continue;
        };
        let fields = e.get("fields").and_then(Value::as_object).expect("checked");
        let extra: Vec<&String> = ex
            .keys()
            .filter(|k| !fields.contains_key(*k) && k.as_str() != "id" && k.as_str() != "type")
            .collect();
        assert!(
            extra.is_empty(),
            "{kind} example uses undocumented fields {extra:?}"
        );
    }
}

#[test]
fn the_overview_names_every_type() {
    let body = s::schema_text(None);
    for kind in s::features().keys() {
        assert!(body.contains(kind.as_str()), "{kind} is missing from the overview");
    }
    for name in s::sketch_entities().keys() {
        assert!(
            body.contains(name.as_str()),
            "sketch entity {name} is missing from the overview"
        );
    }
}

#[test]
fn one_type_returns_its_own_detail() {
    let body = s::schema_text(Some("revolve"));
    assert!(body.contains("pitch") && body.to_lowercase().contains("thread"));
    assert!(body.contains("sketch"));
}

#[test]
fn every_pattern_says_it_can_repeat_features() {
    for kind in ["patternLinear", "patternCircular", "patternRect"] {
        let body = s::schema_text(Some(kind));
        assert!(body.contains("  features: optional list of feature ids"), "{kind}: {body}");
        assert!(body.contains("hole") && body.contains("cannot be patterned"), "{kind}: {body}");
    }
}

#[test]
fn every_pattern_lists_the_bodies_it_can_repeat() {
    for kind in ["patternLinear", "patternCircular", "patternRect"] {
        let body = s::schema_text(Some(kind));
        assert!(body.contains("  bodies: optional list of body ids"), "{kind}: {body}");
    }
}

#[test]
fn a_circular_pattern_says_how_to_place_its_axis() {
    let body = s::schema_text(Some("patternCircular"));
    assert!(body.contains("  axisRef: optional Selector"), "{body}");
    assert!(body.contains("\"origin\"") && body.contains("datumAxis"), "{body}");
    assert!(body.contains("drawn from a corner"), "{body}");
}

#[test]
fn an_unknown_type_is_answered_with_the_list_rather_than_nothing() {
    let body = s::schema_text(Some("extrood"));
    assert!(body.contains("extrude") && body.contains("No feature type"));
}

#[test]
fn the_working_order_says_the_things_that_are_easy_to_get_wrong() {
    // Three facts that cost a build each if the agent has to discover them: Z
    // is up, primitives are centred on the origin, and body ids are not feature
    // ids.
    let how = s::how_to();
    assert!(how.contains("Z is up"));
    assert!(how.contains("CENTRED ON THE ORIGIN"));
    assert!(how.contains("body1"));
}

#[test]
fn the_import_tool_still_says_what_to_do_when_there_is_no_path() {
    // The description is a literal in the tool attribute and the refusals quote
    // a constant, so the two can drift. An agent that decides a part cannot be
    // sent models against something it made up, which is the failure the
    // sentence exists to prevent, so it has to be in both.
    let tool = fundacad_mcp::server::FundaCad::with_link(fundacad_mcp::link::EngineLink::private());
    let router = tool.tools();
    let doc_import = router
        .iter()
        .find(|t| t.name == "doc_import")
        .expect("doc_import is offered");
    let description = doc_import.description.clone().unwrap_or_default();
    assert!(
        description.contains(fundacad_mcp::upload::ASK_FOR_A_PATH),
        "doc_import no longer says what to do when there is no path"
    );
}
