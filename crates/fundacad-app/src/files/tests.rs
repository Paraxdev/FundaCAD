use std::path::{Path, PathBuf};

use serde_json::json;

use super::recent::{forgotten, noted, Recent, MAX};
use super::{new_document, saves_in_place, shown_name, window_title, with_doc_ext, write};

#[test]
fn a_new_document_is_empty_at_the_current_version() {
    let doc = serde_json::Value::Object(new_document());
    let version = fundacad_core::schema::DOCUMENT_VERSION;
    assert_eq!(doc, json!({"version": version, "parameters": {}, "paramDefs": {}, "features": [], "bodyIds": {}}));
}

#[test]
fn names_and_titles() {
    assert_eq!(shown_name(None), "Untitled");
    assert_eq!(shown_name(Some(Path::new("D:/parts/Lid v2.funda"))), "Lid v2");
    assert_eq!(window_title("Lid v2", false), "Lid v2, FundaCAD 2");
    assert_eq!(window_title("Untitled", true), "Untitled*, FundaCAD 2");
}

#[test]
fn only_a_funda_saves_in_place() {
    assert!(saves_in_place(Some(Path::new("a/b.funda"))));
    assert!(saves_in_place(Some(Path::new("a/b.FUNDA"))));
    assert!(!saves_in_place(Some(Path::new("a/b.fundab"))));
    assert!(!saves_in_place(Some(Path::new("a/b.stl"))));
    assert!(!saves_in_place(None));
    assert_eq!(with_doc_ext(PathBuf::from("a/b.funda")), PathBuf::from("a/b.funda"));
    assert_eq!(with_doc_ext(PathBuf::from("a/b")), PathBuf::from("a/b.funda"));
    assert_eq!(with_doc_ext(PathBuf::from("a/b.v2")), PathBuf::from("a/b.v2.funda"));
}

#[test]
fn a_written_document_reads_back_with_its_values() {
    let dir = std::env::temp_dir().join(format!("fundacad-app-test-{}-write", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let blobs = dir.join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let current = fundacad_core::schema::DOCUMENT_VERSION;
    let mut doc = new_document();
    doc.insert("parameters".into(), json!({"width": 37.5, "depth": -12.25}));
    doc.insert("features".into(), json!([{"id": "f7", "type": "box", "params": {"x": 3.5, "y": -8.0}}]));
    doc.insert("version".into(), json!(current + 4));
    doc.insert("geometry".into(), json!({"stale": true}));
    let path = dir.join("part.funda");
    write(&path, &doc, None).unwrap();

    let read: serde_json::Value =
        serde_json::from_str(&fundacad_format::read_document(&path, &blobs).unwrap()).unwrap();
    let mut want = serde_json::Value::Object(doc);
    want["version"] = json!(current);
    want.as_object_mut().unwrap().remove("geometry");
    assert_eq!(read, want);
    std::fs::remove_dir_all(&dir).unwrap();
}

fn r(path: &str, at: u64) -> Recent {
    Recent { path: PathBuf::from(path), opened_at: at }
}

#[test]
fn recent_files_put_the_latest_first_once() {
    assert_eq!(noted(vec![], Path::new("D:/a.funda"), 7), vec![r("D:/a.funda", 7)]);
    let list = vec![r("D:/b.funda", 5), r("D:/a.funda", 3)];
    assert_eq!(noted(list.clone(), Path::new("D:/a.funda"), 9), vec![r("D:/a.funda", 9), r("D:/b.funda", 5)]);
    assert_eq!(
        noted(list.clone(), Path::new("D:/c.funda"), 9),
        vec![r("D:/c.funda", 9), r("D:/b.funda", 5), r("D:/a.funda", 3)]
    );
    assert_eq!(forgotten(list.clone(), Path::new("D:/b.funda")), vec![r("D:/a.funda", 3)]);
    assert_eq!(forgotten(list.clone(), Path::new("D:/z.funda")), list);
}

#[test]
fn recent_files_stop_at_fifty() {
    let full: Vec<Recent> = (0..MAX as u64).map(|i| r(&format!("D:/p{i}.funda"), i)).collect();
    let list = noted(full, Path::new("D:/new.funda"), 99);
    assert_eq!(list.len(), MAX);
    assert_eq!(list[0], r("D:/new.funda", 99));
    assert_eq!(list[MAX - 1], r("D:/p48.funda", 48));
}

#[test]
fn recent_files_store_as_fundacad_1_did() {
    let text = serde_json::to_value(vec![r("D:/a.funda", 3)]).unwrap();
    assert_eq!(text, json!([{"path": "D:/a.funda", "openedAt": 3}]));
}

#[test]
fn a_bad_recent_entry_is_skipped_and_the_rest_kept() {
    use super::recent::readable;
    assert_eq!(readable(vec![]), vec![]);
    assert_eq!(
        readable(vec![json!({"path": "D:/parts/lid.funda", "openedAt": 17})]),
        vec![r("D:/parts/lid.funda", 17)]
    );
    let mixed = vec![
        json!({"path": "D:/parts/lid.funda", "openedAt": 17}),
        json!({"path": 4}),
        json!("E:/loose.funda"),
        json!({"path": "E:/box.fundab", "openedAt": 3}),
    ];
    assert_eq!(readable(mixed), vec![r("D:/parts/lid.funda", 17), r("E:/box.fundab", 3)]);
}

#[test]
fn dirty_is_a_change_from_what_was_read_or_written() {
    use super::is_dirty;
    let saved = new_document();
    let mut edited = new_document();
    edited.insert("parameters".into(), json!({"width": 42.5}));
    assert!(!is_dirty(Some(&saved), Some(&new_document())));
    assert!(is_dirty(Some(&edited), Some(&saved)));
    assert!(is_dirty(Some(&saved), None), "a document nothing was read from is unsaved");
    assert!(!is_dirty(None, Some(&saved)), "an STL is never dirty");
    assert!(!is_dirty(None, None));
}

mod guard {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{SharedString, TestAppContext, VisualTestContext};

    use super::super::{ask_close, ask_discard, Close};
    use crate::overlay::{self, asking, press, test_window};

    fn discard(cx: &mut VisualTestContext, dirty: bool) -> Rc<RefCell<Option<bool>>> {
        let got = Rc::new(RefCell::new(None));
        let g = got.clone();
        cx.update(|window, cx| {
            window.spawn(cx, async move |cx| *g.borrow_mut() = Some(ask_discard(dirty, "Discard it?".into(), cx).await))
        })
        .detach();
        cx.run_until_parked();
        got
    }

    fn close(cx: &mut VisualTestContext) -> Rc<RefCell<Option<Close>>> {
        let got = Rc::new(RefCell::new(None));
        let g = got.clone();
        cx.update(|window, cx| {
            window.spawn(cx, async move |cx| *g.borrow_mut() = Some(ask_close("Save changes to Lid?".into(), cx).await))
        })
        .detach();
        cx.run_until_parked();
        got
    }

    fn answer(cx: &mut VisualTestContext, keys: &[&str]) {
        for key in keys {
            cx.update(|window, cx| press(window, cx, key));
        }
        cx.run_until_parked();
    }

    fn shown(cx: &mut VisualTestContext) -> Option<(SharedString, Vec<SharedString>)> {
        cx.update(|_, cx| asking(cx))
    }

    #[test]
    fn a_clean_document_goes_on_without_a_question() {
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        let got = discard(cx, false);
        assert_eq!((*got.borrow(), shown(cx)), (Some(true), None));
    }

    #[test]
    fn a_dirty_document_goes_on_only_on_discard() {
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        let question = Some(("Discard it?".into(), vec!["Discard".into(), "Cancel".into()]));
        for (keys, want) in [(&["left", "enter"][..], true), (&["enter"][..], false), (&["escape"][..], false)] {
            let got = discard(cx, true);
            assert_eq!((*got.borrow(), shown(cx)), (None, question.clone()), "{keys:?} asked first");
            answer(cx, keys);
            assert_eq!((*got.borrow(), shown(cx)), (Some(want), None), "{keys:?}");
        }
    }

    #[test]
    fn closing_asks_save_dont_save_or_cancel() {
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        let labels: Vec<SharedString> = vec!["Save".into(), "Don't save".into(), "Cancel".into()];
        let cases = [
            (&["enter"][..], Close::Save),
            (&["right", "enter"][..], Close::Discard),
            (&["right", "right", "space"][..], Close::Stay),
            (&["escape"][..], Close::Stay),
        ];
        for (keys, want) in cases {
            let got = close(cx);
            assert_eq!(shown(cx), Some(("Save changes to Lid?".into(), labels.clone())), "{keys:?}");
            answer(cx, keys);
            assert_eq!((*got.borrow(), shown(cx)), (Some(want), None), "{keys:?}");
        }
    }

    #[test]
    fn without_an_overlay_nothing_is_lost() {
        let mut app = TestAppContext::single();
        let cx = app.add_empty_window();
        let got = discard(cx, true);
        assert_eq!(*got.borrow(), Some(false));
        let got = close(cx);
        assert_eq!(*got.borrow(), Some(Close::Stay));
        assert_eq!(cx.update(|_, cx| overlay::toasts(cx)), Vec::<SharedString>::new());
    }
}
