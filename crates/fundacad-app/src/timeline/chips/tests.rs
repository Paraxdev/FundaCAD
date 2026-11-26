use serde_json::json;

use super::{marks, tooltip, Marks};
use crate::timeline::fixture::doc;
use crate::timeline::{features, ops};
use crate::viewport::FeatureIssue;

fn issue(id: &str, message: &str, warning: bool, note: bool) -> FeatureIssue {
    FeatureIssue { feature_id: id.into(), message: message.into(), warning, note }
}

#[test]
fn a_clean_document_has_only_its_suppression() {
    let d = doc();
    let m = marks(&d, &[]);
    assert_eq!(m.len(), 7);
    assert!(m[..6].iter().all(|m| *m == Marks::default()));
    assert_eq!(m[6], Marks { suppressed: true, ..Marks::default() });
}

#[test]
fn an_error_wins_over_a_warning_of_the_same_step() {
    let d = doc();
    let issues = [
        issue("bore", "the cut misses the body", false, false),
        issue("bore", "faces left plain", true, false),
        issue("round", "the radius runs past the edge by 0.4 mm", true, true),
        issue("lid", "texture left plain", true, false),
    ];
    let m = marks(&d, &issues);
    assert_eq!(m[3], Marks { failed: Some("the cut misses the body".into()), ..Marks::default() });
    assert_eq!(
        m[4],
        Marks { warning: Some("the radius runs past the edge by 0.4 mm".into()), advisory: true, ..Marks::default() }
    );
    assert_eq!(m[5], Marks { warning: Some("texture left plain".into()), ..Marks::default() });
}

#[test]
fn an_import_shows_its_file_and_a_step_its_note() {
    let mut d = doc();
    d["features"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "imp", "type": "import", "source": "C:\\parts\\clip.step"}));
    d["features"].as_array_mut().unwrap().push(json!({"id": "imp2", "type": "import", "source": "parts/rail.stl"}));
    d["features"].as_array_mut().unwrap().push(json!({"id": "imp3", "type": "import"}));
    ops::set_note(&mut d, "pad", "check the draft").unwrap();
    let m = marks(&d, &[]);
    assert_eq!(m[7].file.as_deref(), Some("clip.step"));
    assert_eq!(m[8].file.as_deref(), Some("rail.stl"));
    assert_eq!(m[9].file, None);
    assert_eq!(m[1], Marks { note: Some("check the draft".into()), ..Marks::default() });
}

#[test]
fn the_tooltip_reads_place_and_type_then_each_mark() {
    let d = doc();
    let all = features(&d);
    assert_eq!(tooltip(all[1], 1, &Marks::default()), "2 · Extrude");
    let full = Marks {
        failed: Some("no profile".into()),
        warning: Some("ignored".into()),
        advisory: false,
        suppressed: true,
        file: Some("clip.step".into()),
        note: Some("ask Ana".into()),
    };
    assert_eq!(
        tooltip(all[0], 0, &full),
        "1 · Sketch\nFile: clip.step\nFailed: no profile\nSuppressed\nYour note: ask Ana"
    );
    let advisory = Marks { warning: Some("sealed a void".into()), advisory: true, ..Marks::default() };
    assert_eq!(tooltip(all[3], 3, &advisory), "4 · Extrude\nNote: sealed a void");
    let warned = Marks { warning: Some("faces left plain".into()), ..Marks::default() };
    assert_eq!(tooltip(all[3], 3, &warned), "4 · Extrude\nWarning: faces left plain");
}
