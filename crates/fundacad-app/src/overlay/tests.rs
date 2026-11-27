use super::confirm::{first_active, Choice};
use super::menu::{step, MenuItem, MenuRow};
use super::palette::{rank, Hit};
use super::score::score;
use super::toast::{Kind, Stack, Toast, MAX};

#[test]
fn score_prefers_a_start_and_a_run() {
    assert_eq!(score("", "fit view"), 1.);
    assert_eq!(score("x", "fit view"), 0.);
    assert_eq!(score("vf", "fit view"), 0.);
    // f at 0: 2 + 3, i next: 3, t next: 4, then the short label bonus 2 * 0.1.
    assert!((score("fit", "fit view") - 12.2).abs() < 1e-5);
    assert!(score("fv", "fit view") < score("fi", "fit view"));
    assert!(score("view", "fit view") < score("view", "view"));
}

fn hit(id: &'static str, label: &str) -> Hit {
    Hit { id, label: label.to_string().into(), group: "View".into() }
}

#[test]
fn rank_keeps_matches_best_first_and_caps_at_forty() {
    let rows = vec![hit("top", "Top View"), hit("fit", "Fit View"), hit("save", "Save"), hit("front", "Front View")];
    let ids = |hits: Vec<Hit>| hits.into_iter().map(|h| h.id).collect::<Vec<_>>();
    assert_eq!(ids(rank(rows.clone(), "")), vec!["top", "fit", "save", "front"]);
    assert_eq!(ids(rank(rows.clone(), "FI")), vec!["fit", "front"]);
    assert_eq!(ids(rank(rows.clone(), "zz")), Vec::<&str>::new());
    assert_eq!(ids(rank(rows, "view")), vec!["top", "fit", "front"]);
    let many: Vec<Hit> = (0..50).map(|_| hit("x", "Same")).collect();
    assert_eq!(rank(many, "s").len(), 40);
}

#[test]
fn toasts_stop_at_three_and_push_out_one_without_a_button() {
    let mut s = Stack::default();
    assert_eq!(s.push(Toast::info("a")), (1, 0));
    s.push(Toast::warning("b").with_action("Undo", |_, _| {}));
    s.push(Toast::error("c"));
    assert_eq!(s.items.len(), MAX);
    assert_eq!(s.push(Toast::info("d")), (4, 0));
    let shown: Vec<_> = s.items.iter().map(|i| (i.id, i.toast.message.to_string(), i.toast.kind)).collect();
    assert_eq!(shown, vec![(2, "b".into(), Kind::Warning), (3, "c".into(), Kind::Error), (4, "d".into(), Kind::Info)]);
}

#[test]
fn toasts_all_with_buttons_lose_the_oldest() {
    let mut s = Stack::default();
    for m in ["a", "b", "c", "d"] {
        s.push(Toast::info(m).with_action("Undo", |_, _| {}));
    }
    let ids: Vec<_> = s.items.iter().map(|i| i.id).collect();
    assert_eq!(ids, vec![2, 3, 4]);
}

#[test]
fn the_same_toast_again_starts_its_time_again() {
    let mut s = Stack::default();
    let first = s.push(Toast::info("saved"));
    let again = s.push(Toast::info("saved"));
    assert_eq!((first, again, s.items.len()), ((1, 0), (1, 1), 1));
    assert!(!s.expire(1, 0, None));
    assert!(s.expire(1, 1, None));
    assert!(s.items.is_empty());
    assert!(!s.dismiss(1));
}

#[test]
fn toast_hold_times_follow_kind_and_button() {
    let ms = |t: Toast| t.hold().as_millis();
    assert_eq!(ms(Toast::info("a")), 5000);
    assert_eq!(ms(Toast::warning("a")), 8000);
    assert_eq!(ms(Toast::error("a")), 10000);
    assert_eq!(ms(Toast::info("a").with_action("Undo", |_, _| {})), 15000);
}

fn row(label: &str, disabled: bool) -> MenuRow {
    MenuRow::Item(MenuItem::call(label.to_string(), |_, _| {}).disabled(disabled))
}

#[test]
fn menu_keys_skip_separators_and_greyed_rows_and_wrap() {
    let rows = vec![row("New", false), MenuRow::Separator, row("Save", true), row("Export", false)];
    assert_eq!(step(&rows, None, 1), Some(0));
    assert_eq!(step(&rows, None, -1), Some(3));
    assert_eq!(step(&rows, Some(0), 1), Some(3));
    assert_eq!(step(&rows, Some(3), 1), Some(0));
    assert_eq!(step(&rows, Some(0), -1), Some(3));
    assert_eq!(step(&[], None, 1), None);
    assert_eq!(step(&[MenuRow::Separator, row("Save", true)], None, 1), None);
}

#[test]
fn enter_answers_the_primary_choice_else_the_last() {
    assert_eq!(first_active(&[Choice::primary("Save"), Choice::danger("Don't save"), Choice::plain("Cancel")]), 0);
    assert_eq!(first_active(&[Choice::danger("Discard"), Choice::plain("Cancel")]), 1);
    assert_eq!(first_active(&[]), 0);
}
