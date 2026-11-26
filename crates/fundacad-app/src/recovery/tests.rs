use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;

use super::store::{discard, leftovers, question, sweep, write_slot, Envelope, Leftover, Own};
use super::{due, warn_now};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-app-test-{}-recovery-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn doc(width: f64) -> fundacad_client::Doc {
    let mut d = crate::files::new_document();
    d.insert("features".into(), json!([{"id": "b3", "type": "box", "length": 12.5, "width": width, "height": 4}]));
    d
}

fn envelope(source: Option<&str>, saved_at: u64) -> Envelope {
    Envelope { source: source.map(PathBuf::from), saved_at }
}

fn read_doc(path: &Path) -> serde_json::Value {
    let blobs = path.with_extension("blobs");
    let text = fundacad_format::read_document(path, &blobs).unwrap();
    let _ = std::fs::remove_dir_all(blobs);
    serde_json::from_str(&text).unwrap()
}

#[test]
fn a_snapshot_is_due_after_a_rest_or_when_the_oldest_edit_is_too_old() {
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    assert!(!due(at(29), at(0), at(0)));
    assert!(due(at(30), at(0), at(0)));
    assert!(!due(at(119), at(100), at(0)));
    assert!(due(at(120), at(100), at(0)));
    assert!(!due(at(5), at(10), at(10)), "an edit seen after now is not due");
}

#[test]
fn the_failure_warning_shows_once_at_the_third_failure() {
    assert_eq!((0..6).map(warn_now).collect::<Vec<_>>(), [false, false, false, true, false, false]);
}

#[test]
fn the_question_names_the_file_and_the_age_in_whole_minutes() {
    let saved = 1_800_000_000_000;
    let lid = envelope(Some("D:/parts/Lid v2.funda"), saved);
    assert_eq!(question(&lid, saved), "Recover unsaved work? (Lid v2.funda, ~1 min old)");
    assert_eq!(question(&lid, saved + 89_999), "Recover unsaved work? (Lid v2.funda, ~1 min old)");
    assert_eq!(question(&lid, saved + 90_000), "Recover unsaved work? (Lid v2.funda, ~2 min old)");
    assert_eq!(
        question(&envelope(None, saved), saved + 47 * 60_000),
        "Recover unsaved work? (an unsaved document, ~47 min old)"
    );
    assert_eq!(question(&lid, saved - 5_000), "Recover unsaved work? (Lid v2.funda, ~1 min old)");
}

#[test]
fn an_empty_or_missing_folder_has_no_leftovers() {
    let dir = temp("none");
    assert_eq!(leftovers(&dir, None), []);
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(leftovers(&dir, None), []);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_running_apps_slot_is_never_a_leftover_and_a_gone_apps_is() {
    let dir = temp("alive");
    let own = Own::claim(&dir, "41-7".into()).unwrap();
    write_slot(&dir, own.id(), &doc(8.0), None, &envelope(Some("C:/a/plate.funda"), 900), &Default::default()).unwrap();
    let other = Own::claim(&dir, "52-3".into()).unwrap();
    write_slot(&dir, other.id(), &doc(9.0), None, &envelope(None, 950), &Default::default()).unwrap();
    assert_eq!(leftovers(&dir, Some("41-7")), [], "the other app still runs");
    assert!(Own::claim(&dir, "52-3".into()).is_err(), "a slot is claimed once");
    drop(other);
    let want = Leftover { id: "52-3".into(), doc: dir.join("52-3.funda"), envelope: envelope(None, 950) };
    assert_eq!(leftovers(&dir, Some("41-7")), [want]);
    assert_eq!(read_doc(&dir.join("52-3.funda"))["features"][0]["width"], json!(9.0));
    drop(own);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn leftovers_come_newest_first_and_broken_slots_are_skipped() {
    let dir = temp("many");
    for (id, at) in [("1-1", 300), ("2-2", 700), ("3-3", 500)] {
        let own = Own::claim(&dir, id.into()).unwrap();
        write_slot(
            &dir,
            id,
            &doc(at as f64),
            None,
            &envelope(Some(&format!("E:/m/{id}.funda")), at),
            &Default::default(),
        )
        .unwrap();
        drop(own);
    }
    std::fs::write(dir.join("4-4.json"), "not json").unwrap();
    std::fs::write(dir.join("5-5.json"), r#"{"source":null,"savedAt":999}"#).unwrap();
    let got: Vec<(String, u64)> = leftovers(&dir, None).into_iter().map(|l| (l.id, l.envelope.saved_at)).collect();
    assert_eq!(got, [("2-2".to_owned(), 700), ("3-3".to_owned(), 500), ("1-1".to_owned(), 300)]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_cleared_or_discarded_slot_is_gone_and_a_running_one_is_kept() {
    let dir = temp("clear");
    let own = Own::claim(&dir, "7-1".into()).unwrap();
    write_slot(&dir, "7-1", &doc(3.0), None, &envelope(None, 10), &Default::default()).unwrap();
    discard(&dir, "7-1");
    assert!(dir.join("7-1.funda").is_file(), "its app still runs");
    own.clear();
    assert!(!dir.join("7-1.funda").exists() && !dir.join("7-1.json").exists());
    write_slot(&dir, "7-1", &doc(3.0), None, &envelope(None, 10), &Default::default()).unwrap();
    drop(own);
    assert!(!dir.join("7-1.lock").exists(), "a clean exit frees its lock");
    discard(&dir, "7-1");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_snapshot_written_again_replaces_the_last() {
    let dir = temp("again");
    let own = Own::claim(&dir, "8-2".into()).unwrap();
    write_slot(&dir, "8-2", &doc(1.5), None, &envelope(None, 10), &Default::default()).unwrap();
    write_slot(&dir, "8-2", &doc(6.25), None, &envelope(Some("F:/x/y.funda"), 20), &Default::default()).unwrap();
    drop(own);
    let left = leftovers(&dir, None);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].envelope, envelope(Some("F:/x/y.funda"), 20));
    assert_eq!(read_doc(&left[0].doc)["features"][0]["width"], json!(6.25));
    assert!(!dir.join("8-2.tmp.funda").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

fn listing(dir: &Path) -> Vec<String> {
    let mut n: Vec<String> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    n.sort();
    n
}

#[test]
fn a_write_given_up_while_it_ran_leaves_nothing() {
    let dir = temp("stopped");
    let own = Own::claim(&dir, "9-4".into()).unwrap();
    let stop = std::sync::atomic::AtomicBool::new(true);
    write_slot(&dir, "9-4", &doc(2.5), None, &envelope(None, 30), &stop).unwrap();
    assert_eq!(listing(&dir), ["9-4.lock"]);
    drop(own);
    assert_eq!(listing(&dir), Vec::<String>::new());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn sweep_deletes_what_gone_apps_left_half_and_keeps_whole_or_running_slots() {
    let dir = temp("sweep");
    sweep(&dir, None);
    let own = Own::claim(&dir, "1-1".into()).unwrap();
    let running = Own::claim(&dir, "2-2".into()).unwrap();
    std::fs::write(dir.join("2-2.tmp.funda"), "{").unwrap();
    let whole = Own::claim(&dir, "3-3".into()).unwrap();
    write_slot(&dir, "3-3", &doc(4.0), None, &envelope(None, 40), &Default::default()).unwrap();
    std::fs::write(dir.join("3-3.tmp.funda"), "{").unwrap();
    drop(whole);
    std::fs::write(dir.join("4-4.lock"), "").unwrap();
    std::fs::write(dir.join("5-5.json"), "{}").unwrap();
    std::fs::write(dir.join("6-6.funda"), "{}").unwrap();
    std::fs::write(dir.join("7-7.tmp.funda"), "{").unwrap();
    std::fs::write(dir.join("notes.txt"), "kept").unwrap();
    sweep(&dir, Some("1-1"));
    assert_eq!(listing(&dir), ["1-1.lock", "2-2.lock", "2-2.tmp.funda", "3-3.funda", "3-3.json", "notes.txt"]);
    assert_eq!(leftovers(&dir, Some("1-1")).iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["3-3"]);
    drop((own, running));
    let _ = std::fs::remove_dir_all(&dir);
}

mod app {
    use std::path::Path;

    use gpui::{AppContext as _, SharedString, TestAppContext, VisualTestContext};

    use super::super::{adopt, give_up, install_in, store, Current};
    use super::{doc, envelope, temp};
    use crate::files::Files;
    use crate::overlay::{asking, press, test_window, toasts};
    use crate::viewport::Viewport;

    fn start(cx: &mut VisualTestContext, dir: &Path) {
        let dir = dir.to_path_buf();
        cx.update(|window, cx| {
            let viewport = cx.new(|_| Viewport::new());
            let files = cx.new(|cx| Files::new(viewport.clone(), window, cx));
            install_in(dir, &viewport, &files, window, cx);
        });
        cx.run_until_parked();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut n: Vec<String> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        n.sort();
        n
    }

    fn leave(dir: &Path, id: &str, saved_at: u64) {
        let slot = store::Own::claim(dir, id.into()).unwrap();
        store::write_slot(
            dir,
            id,
            &doc(2.0),
            None,
            &envelope(Some("G:/k/bracket.funda"), saved_at),
            &Default::default(),
        )
        .unwrap();
        drop(slot);
    }

    fn question(saved_at: u64) -> Option<(SharedString, Vec<SharedString>)> {
        let q = store::question(&envelope(Some("G:/k/bracket.funda"), saved_at), store::now_ms());
        Some((q.into(), vec!["Recover".into(), "Discard".into()]))
    }

    #[test]
    fn the_running_app_holds_its_slot_until_it_gives_up() {
        let dir = temp("held");
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        start(cx, &dir);
        let held = names(&dir);
        assert_eq!(held.len(), 1);
        assert!(held[0].ends_with(".lock"), "{held:?}");
        assert_eq!(cx.update(|_, cx| asking(cx)), None, "nothing to offer");
        cx.update(|_, cx| give_up(cx));
        assert_eq!(names(&dir), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_leftover_is_offered_and_discard_deletes_it() {
        let dir = temp("offer-discard");
        let saved_at = store::now_ms() - 3 * 60_000;
        leave(&dir, "61-5", saved_at);
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        start(cx, &dir);
        assert_eq!(cx.update(|_, cx| asking(cx)), question(saved_at));
        for key in ["right", "enter"] {
            cx.update(|window, cx| press(window, cx, key));
        }
        cx.run_until_parked();
        assert_eq!(cx.update(|_, cx| asking(cx)), None);
        assert!(names(&dir).iter().all(|n| !n.starts_with("61-5")), "{:?}", names(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn escape_keeps_the_leftover_for_the_next_start_and_only_the_newest_is_asked() {
        let dir = temp("offer-escape");
        let newest = store::now_ms() - 60_000;
        leave(&dir, "70-1", newest - 10 * 60_000);
        leave(&dir, "71-1", newest);
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        start(cx, &dir);
        assert_eq!(cx.update(|_, cx| asking(cx)), question(newest));
        cx.update(|window, cx| press(window, cx, "escape"));
        cx.run_until_parked();
        assert_eq!(cx.update(|_, cx| asking(cx)), None);
        let left: Vec<String> = store::leftovers(&dir, None).into_iter().map(|l| l.id).collect();
        assert_eq!(left, ["71-1", "70-1"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn autosave(cx: &mut VisualTestContext) -> gpui::Entity<super::super::Autosave> {
        cx.update(|_, cx| cx.global::<Current>().0.clone())
    }

    #[test]
    fn recover_with_a_broken_snapshot_says_why_and_keeps_it() {
        let dir = temp("recover-broken");
        let saved_at = store::now_ms() - 4 * 60_000;
        leave(&dir, "62-8", saved_at);
        std::fs::write(dir.join("62-8.funda"), "[1, 2]").unwrap();
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        start(cx, &dir);
        assert_eq!(cx.update(|_, cx| asking(cx)), question(saved_at));
        cx.update(|window, cx| press(window, cx, "enter"));
        cx.run_until_parked();
        let toasts = cx.update(|_, cx| toasts(cx));
        assert_eq!(toasts.len(), 1, "{toasts:?}");
        assert!(toasts[0].starts_with("Could not recover the unsaved work: "), "{toasts:?}");
        assert!(toasts[0].ends_with("62-8.funda is not a document"), "{toasts:?}");
        let a = autosave(cx);
        assert_eq!(cx.update(|_, cx| a.read(cx).clock.adopted.clone()), None);
        assert_eq!(store::leftovers(&dir, None).into_iter().map(|l| l.id).collect::<Vec<_>>(), ["62-8"]);
        cx.update(|_, cx| give_up(cx));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_adopted_slot_goes_once_this_app_writes_its_own() {
        let dir = temp("adopt-write");
        leave(&dir, "63-1", store::now_ms() - 60_000);
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        start(cx, &dir);
        cx.update(|window, cx| press(window, cx, "escape"));
        cx.run_until_parked();
        let a = autosave(cx);
        cx.update(|_, cx| adopt(&a, "63-1".into(), cx));
        assert_eq!(cx.update(|_, cx| toasts(cx)), ["Recovered unsaved work, use Save As to keep it"]);
        assert_eq!(cx.update(|_, cx| a.read(cx).clock.adopted.clone()).as_deref(), Some("63-1"));
        a.update(cx, |a, cx| {
            a.clock.writing = true;
            a.wrote(3, Err("disk full".into()), cx);
        });
        assert!(names(&dir).iter().any(|n| n == "63-1.funda"), "a failed write keeps it");
        a.update(cx, |a, cx| {
            a.clock.writing = true;
            a.wrote(4, Ok(()), cx);
        });
        assert!(names(&dir).iter().all(|n| !n.starts_with("63-1")), "{:?}", names(&dir));
        assert_eq!(cx.update(|_, cx| a.read(cx).clock.written), Some(4));
        cx.update(|_, cx| give_up(cx));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clean_document_clears_the_adopted_slot_on_the_next_tick() {
        let dir = temp("adopt-clean");
        leave(&dir, "64-2", store::now_ms() - 60_000);
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        start(cx, &dir);
        cx.update(|window, cx| press(window, cx, "escape"));
        cx.run_until_parked();
        let a = autosave(cx);
        cx.update(|_, cx| adopt(&a, "64-2".into(), cx));
        a.update(cx, |a, cx| a.tick(cx));
        assert_eq!(cx.update(|_, cx| a.read(cx).clock.clone()), super::super::Clock::default());
        let left = names(&dir);
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].ends_with(".lock") && !left[0].starts_with("64-2"), "{left:?}");
        cx.update(|_, cx| give_up(cx));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_third_failure_in_a_row_warns() {
        let dir = temp("warn");
        let mut app = TestAppContext::single();
        let (cx, _overlay) = test_window(&mut app);
        start(cx, &dir);
        let a = autosave(cx);
        for n in 1..=4 {
            a.update(cx, |a, cx| a.wrote(n, Err("denied".into()), cx));
            let want: &[&str] =
                if n < 3 { &[] } else { &["Autosave keeps failing, unsaved work may not be recoverable"] };
            assert_eq!(cx.update(|_, cx| toasts(cx)), want, "after {n}");
        }
        cx.update(|_, cx| give_up(cx));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
