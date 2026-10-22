//! The app and the engine agree on the built-in feature types and the document version, so both judge a file the
//! same way when deciding what this build does not know.

use std::collections::BTreeSet;
use std::path::Path;

use fundacad_core::schema::{Feature, DOCUMENT_VERSION};

fn source(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn ts_core_feature_types() -> BTreeSet<String> {
    let text = source("src/types.ts");
    let start = text.find("const CORE_FEATURE_TYPES = {").expect("CORE_FEATURE_TYPES in src/types.ts");
    let body = &text[start..];
    let body = &body[body.find('{').unwrap() + 1..body.find('}').expect("its closing brace")];
    body.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|entry| {
            let key = entry.split(':').next().unwrap().trim();
            key.trim_matches('"').to_owned()
        })
        .collect()
}

#[test]
fn the_app_and_the_engine_build_the_same_feature_types() {
    let ts = ts_core_feature_types();
    let rust: BTreeSet<String> = Feature::KNOWN.iter().map(|s| (*s).to_owned()).collect();
    assert!(ts.len() > 30, "read {} types from src/types.ts", ts.len());
    assert_eq!(
        ts.difference(&rust).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "in src/types.ts CORE_FEATURE_TYPES but not in Feature::KNOWN"
    );
    assert_eq!(
        rust.difference(&ts).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "in Feature::KNOWN but not in src/types.ts CORE_FEATURE_TYPES"
    );
}

#[test]
fn the_app_and_the_engine_write_the_same_document_version() {
    let text = source("src/document/migrate.ts");
    let line = text
        .lines()
        .find(|l| l.starts_with("export const FORMAT_VERSION = "))
        .expect("FORMAT_VERSION in src/document/migrate.ts");
    let ts: u32 =
        line["export const FORMAT_VERSION = ".len()..].trim_end_matches(';').trim().parse().expect("a number");
    assert_eq!(ts, DOCUMENT_VERSION);
}
