use std::path::PathBuf;

use super::{leftovers, plan, Plan};

fn paths(names: &[&str]) -> Vec<PathBuf> {
    names.iter().map(PathBuf::from).collect()
}

#[test]
fn nothing_dropped_opens_nothing_and_says_nothing() {
    let p = plan(&[]);
    assert_eq!(p, Plan::default());
    assert_eq!(leftovers(&p), None);
}

#[test]
fn one_document_opens() {
    for name in ["D:/w/Lid v2.funda", "D:/w/arm.FUNDAB", "C:/scan/part.stl"] {
        let p = plan(&paths(&[name]));
        assert_eq!(p, Plan { open: Some(PathBuf::from(name)), skipped: vec![], rejected: vec![] }, "{name}");
        assert_eq!(leftovers(&p), None);
    }
}

#[test]
fn the_first_document_opens_and_the_rest_are_named() {
    let p = plan(&paths(&["E:/a/notes.txt", "E:/a/one.funda", "E:/a/two.stl", "E:/a/README", "E:/a/three.fundab"]));
    assert_eq!(
        p,
        Plan {
            open: Some(PathBuf::from("E:/a/one.funda")),
            skipped: paths(&["E:/a/two.stl", "E:/a/three.fundab"]),
            rejected: paths(&["E:/a/notes.txt", "E:/a/README"]),
        }
    );
    assert_eq!(
        leftovers(&p).as_deref(),
        Some("FundaCAD cannot open notes.txt, README. Only one document opens at a time, so two.stl, three.fundab stayed closed.")
    );
}

#[test]
fn only_unreadable_files_open_nothing() {
    let p = plan(&paths(&["F:/m/bracket.step", "F:/m/funda"]));
    assert_eq!(p.open, None);
    assert_eq!(leftovers(&p).as_deref(), Some("FundaCAD cannot open bracket.step, funda."));
}
