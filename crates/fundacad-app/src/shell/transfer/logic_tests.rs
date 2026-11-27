use fundacad_client::transfer::export::{BodyScope, ExportFormat, FlatSource};
use fundacad_client::transfer::insert::{InsertError, StaleLinks};
use fundacad_client::{Doc, Refused};
use serde_json::{json, Value};

use super::logic::*;

fn doc(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

#[test]
fn every_sketch_is_a_flat_source_named_by_its_name_or_id() {
    let d = doc(json!({"features": [
        {"id": "f1", "type": "sketch", "name": "Plate"},
        {"id": "f2", "type": "extrude"},
        {"id": "f3", "type": "sketch", "name": ""},
    ]}));
    assert_eq!(
        flat_sources(&d),
        [
            FlatSource::Sketch { sketch: "f1".into(), label: "Plate".into() },
            FlatSource::Sketch { sketch: "f3".into(), label: "f3".into() },
        ]
    );
    assert!(flat_sources(&Doc::new()).is_empty());
}

#[test]
fn selected_scopes_need_a_selection() {
    let scopes = |s| scope_choices(s).into_iter().map(|(s, _)| s).collect::<Vec<_>>();
    assert_eq!(scopes(0), [BodyScope::All, BodyScope::Separate]);
    assert_eq!(scopes(2).len(), 4);
}

#[test]
fn the_format_extension_is_added_unless_one_of_its_own_is_there() {
    assert_eq!(with_ext("C:/a/part", ExportFormat::Stl), "C:/a/part.stl");
    assert_eq!(with_ext("C:/a/part.STL", ExportFormat::Stl), "C:/a/part.STL");
    assert_eq!(with_ext("C:/a/part.stp", ExportFormat::Step), "C:/a/part.stp");
    assert_eq!(with_ext("C:/a.b/part.txt", ExportFormat::Svg), "C:/a.b/part.txt.svg");
}

#[test]
fn features_append_at_the_end_and_a_missing_list_is_made() {
    let mut d = doc(json!({"features": [{"id": "f1"}]}));
    append_features(&mut d, &[json!({"id": "f2"}), json!({"id": "f3"})]).unwrap();
    assert_eq!(d["features"], json!([{"id": "f1"}, {"id": "f2"}, {"id": "f3"}]));
    let mut empty = Doc::new();
    append_features(&mut empty, &[json!({"id": "f1"})]).unwrap();
    assert_eq!(empty["features"], json!([{"id": "f1"}]));
    let mut bad = doc(json!({"features": 3}));
    assert!(append_features(&mut bad, &[]).is_err());
}

#[test]
fn a_link_path_is_read_from_its_feature() {
    let d = doc(json!({"features": [{"id": "f1", "link": {"path": "C:/b.funda"}}, {"id": "f2"}]}));
    assert_eq!(link_path(&d, "f1").as_deref(), Some("C:/b.funda"));
    assert_eq!(link_path(&d, "f2"), None);
    assert_eq!(link_path(&d, "f9"), None);
}

#[test]
fn stale_links_are_summed_up_and_missing_ones_are_not_refreshed() {
    let s = StaleLinks { changed: vec!["f1".into()], missing: vec!["f2".into()], unknown: vec!["f3".into()] };
    assert_eq!(stale_count(&s), 3);
    assert_eq!(refreshable(&s), ["f1", "f3"]);
    assert_eq!(stale_summary(&s), "Linked files: 1 changed, 1 missing, 1 may have changed.");
    assert_eq!(stale_summary(&StaleLinks::default()), "Linked files are up to date.");
}

#[test]
fn a_cancelled_insert_says_nothing() {
    let cancelled = Refused { message: "cancelled".into(), cancelled: true };
    assert_eq!(insert_error_text(&InsertError::Build(cancelled)), None);
    assert!(insert_error_text(&InsertError::Empty).is_some());
    let failed = Refused { message: "boom".into(), cancelled: false };
    assert_eq!(
        insert_error_text(&InsertError::ReadBack(failed)).as_deref(),
        Some("Its geometry did not read back: boom")
    );
}

#[test]
fn written_paths_are_named_by_file_or_counted() {
    assert_eq!(written_summary(&["C:/out/a.stl".into()]), "Exported a.stl");
    assert_eq!(written_summary(&["C:/out/a.stl".into(), "C:/out/b.stl".into()]), "Exported 2 files to C:/out");
    assert_eq!(written_summary(&[]), "The export wrote nothing.");
}

#[test]
fn unix_time_turns_into_a_calendar_stamp() {
    let s = stamp_from_unix(1_792_150_927, 0);
    assert_eq!((s.year, s.month, s.day, s.hour, s.minute, s.second), (2026, 10, 16, 11, 42, 7));
    let s = stamp_from_unix(0, -60);
    assert_eq!((s.year, s.month, s.day, s.hour), (1969, 12, 31, 23));
    let s = stamp_from_unix(951_782_400, 0);
    assert_eq!((s.year, s.month, s.day), (2000, 2, 29));
}

#[test]
fn an_ambiguous_point_blocks_the_typed_number() {
    assert!(typed_number("1.500", ',').is_err());
    assert_eq!(typed_number(" 1,5 ", ','), Ok(Some(1.5)));
    assert_eq!(typed_number("1.500", '.'), Ok(Some(1.5)));
    assert_eq!(typed_number("abc", ','), Ok(None));
    assert_eq!(typed_number("", '.'), Ok(None));
}
