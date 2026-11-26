use serde_json::json;

use super::{menu, pick, related, shown, typed_edit, Act, Entry, FieldKind};
use crate::timeline::fixture::{doc, strings};
use crate::timeline::rows::Rows;

fn on(act: Act, label: &str) -> Entry {
    Entry::Item { act: Some(act), label: label.into(), keys: "", danger: false }
}

fn rows(keys: &[&str]) -> Rows {
    Rows { keys: strings(keys), anchor: keys.first().map(|k| (*k).to_owned()) }
}

#[test]
fn one_plain_step_gets_the_full_menu_without_reset_or_remove() {
    let d = doc();
    assert_eq!(
        menu(&d, &strings(&["bore"])),
        vec![
            Entry::Item { act: Some(Act::Rename), label: "Rename".into(), keys: "F2", danger: false },
            on(Act::Suppress(true), "Suppress"),
            on(Act::RollBefore, "Roll back before this"),
            on(Act::RollHere, "Roll to here"),
            on(Act::Note, "Add note"),
            Entry::Separator,
            Entry::Item { act: Some(Act::Delete), label: "Delete".into(), keys: "Del", danger: true },
        ]
    );
}

#[test]
fn a_named_suppressed_step_with_a_note_offers_reset_unsuppress_and_remove() {
    let mut d = doc();
    d["suppressed"] = json!(["base", "lone"]);
    d.insert("featureNotes".into(), json!({"base": "check the fillet"}));
    let labels: Vec<String> = menu(&d, &strings(&["base"]))
        .into_iter()
        .map(|e| match e {
            Entry::Item { label, .. } => label,
            Entry::Separator => "-".into(),
        })
        .collect();
    assert_eq!(
        labels,
        strings(&[
            "Rename",
            "Reset name",
            "Unsuppress",
            "Roll back before this",
            "Roll to here",
            "Edit note",
            "Remove note",
            "-",
            "Delete"
        ])
    );
    assert!(menu(&d, &strings(&["base"])).contains(&on(Act::Suppress(false), "Unsuppress")));
}

#[test]
fn several_steps_get_the_shared_items_and_the_single_ones_off() {
    let d = doc();
    let off = |label: &str| Entry::Item { act: None, label: label.into(), keys: "", danger: false };
    let three = menu(&d, &strings(&["pad", "round", "lone"]));
    assert_eq!(
        three,
        vec![
            off("Rename (select one feature)"),
            on(Act::Suppress(true), "Suppress these 3"),
            off("Roll back before this (select one feature)"),
            Entry::Separator,
            Entry::Item { act: Some(Act::Delete), label: "Delete these 3".into(), keys: "Del", danger: true },
        ]
    );
    let mut all = doc();
    all["suppressed"] = json!(["lone", "round"]);
    assert_eq!(menu(&all, &strings(&["round", "lone"]))[1], on(Act::Suppress(false), "Unsuppress these 2"));
    assert!(menu(&d, &[]).is_empty());
}

#[test]
fn a_plain_click_on_the_open_row_folds_it_and_a_modified_one_does_not() {
    let order = strings(&["base", "pad", "hole", "bore"]);
    let open = rows(&["pad"]);
    assert_eq!(pick(&open, &order, "pad", false, false), Rows::default());
    assert_eq!(pick(&open, &order, "bore", false, false), rows(&["bore"]));
    assert_eq!(
        pick(&open, &order, "bore", true, false),
        Rows { keys: strings(&["pad", "bore"]), anchor: Some("bore".into()) }
    );
    assert_eq!(
        pick(&open, &order, "bore", false, true),
        Rows { keys: strings(&["pad", "hole", "bore"]), anchor: Some("pad".into()) }
    );
    let two = Rows { keys: strings(&["pad", "bore"]), anchor: Some("pad".into()) };
    assert_eq!(pick(&two, &order, "pad", false, false), rows(&["pad"]), "a click in a run takes that row alone");
}

#[test]
fn the_filter_shows_the_related_rows_while_on_and_something_is_picked() {
    let d = doc();
    let every = strings(&["base", "pad", "hole", "bore", "round", "lid", "lone"]);
    assert_eq!(shown(&d, &Rows::default(), false), every);
    assert_eq!(shown(&d, &rows(&["round"]), false), strings(&["pad", "round"]));
    assert_eq!(shown(&d, &rows(&["round"]), true), every);
    assert_eq!(shown(&d, &rows(&["gone"]), false), every, "a pick the document lost filters nothing");
    assert_eq!(related(&d, &Rows::default()), None);
    assert_eq!(related(&d, &rows(&["hole", "lid"])), Some(strings(&["hole", "bore", "lid"])));
}

#[test]
fn a_field_left_as_it_was_writes_nothing() {
    let mut d = doc();
    d.insert("featureNotes".into(), json!({"pad": "7 deep"}));
    assert_eq!(typed_edit(&d, FieldKind::Rename, "bore", "Extrude 2"), None);
    assert_eq!(typed_edit(&d, FieldKind::Rename, "bore", "  Extrude 2 "), None);
    assert_eq!(typed_edit(&d, FieldKind::Rename, "bore", "Bore"), Some("Bore".into()));
    assert_eq!(typed_edit(&d, FieldKind::Rename, "base", ""), Some(String::new()), "blank resets the name");
    assert_eq!(typed_edit(&d, FieldKind::Note, "pad", "7 deep"), None);
    assert_eq!(typed_edit(&d, FieldKind::Note, "pad", " 9 deep "), Some("9 deep".into()));
    assert_eq!(typed_edit(&d, FieldKind::Note, "hole", ""), None);
    assert_eq!(typed_edit(&d, FieldKind::Note, "hole", "XZ"), Some("XZ".into()));
}
