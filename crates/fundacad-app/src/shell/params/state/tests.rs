use serde_json::json;

use super::super::rows::rows;
use super::*;

fn doc() -> Doc {
    json!({
        "paramDefs": {
            "wall": {"expr": "2.5", "value": 2.5, "unit": "mm", "comment": "outer"},
            "depth": {"expr": "wall * 7", "value": 17.5, "unit": "mm"},
            "d4": {"expr": "depth", "value": 17.5, "unit": "mm", "target": {"kind": "feature", "feature": "e4", "field": "distance"}}
        },
        "features": [{"id": "e4", "type": "extrude", "sketch": "s3", "distance": 17.5}]
    })
    .as_object()
    .unwrap()
    .clone()
}

fn row(name: &str, col: Col) -> Key {
    Key::Row(name.into(), col)
}

fn notes(problems: &[(Key, &str)], preview: &[(Key, f64)], refused: &[(&str, &str)]) -> Notes {
    Notes {
        problems: problems.iter().map(|(k, v)| (k.clone(), (*v).to_owned())).collect(),
        preview: preview.iter().cloned().collect(),
        refused: refused.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
    }
}

#[test]
fn texts_list_every_field_and_a_model_row_has_no_comment() {
    assert_eq!(texts(&Rows::default()), HashMap::new());
    let want: HashMap<Key, String> = [
        (row("wall", Col::Name), "wall"),
        (row("wall", Col::Expr), "2.5"),
        (row("wall", Col::Comment), "outer"),
        (row("depth", Col::Name), "depth"),
        (row("depth", Col::Expr), "wall * 7"),
        (row("depth", Col::Comment), ""),
        (row("d4", Col::Name), "d4"),
        (row("d4", Col::Expr), "depth"),
    ]
    .into_iter()
    .map(|(k, v)| (k, v.to_owned()))
    .collect();
    assert_eq!(texts(&rows(&doc())), want);
}

#[test]
fn a_commit_names_the_change_of_its_column() {
    let rows = rows(&doc());
    let mut n = Notes::default();
    assert_eq!(
        n.commit(&rows, &row("wall", Col::Name), "shell"),
        Some(Change::Rename { from: "wall".into(), to: "shell".into() })
    );
    assert_eq!(
        n.commit(&rows, &row("d4", Col::Expr), "depth + 1"),
        Some(Change::Expr { name: "d4".into(), expr: "depth + 1".into() })
    );
    assert_eq!(
        n.commit(&rows, &row("depth", Col::Comment), "inside"),
        Some(Change::Comment { name: "depth".into(), comment: "inside".into() })
    );
    assert_eq!(n.commit(&rows, &row("gone", Col::Expr), "3"), None);
    assert_eq!(n.commit(&rows, &Key::NewExpr, "3"), None);
    assert_eq!(n, Notes::default());
}

#[test]
fn committing_the_stored_text_changes_nothing_and_drops_its_refusal_and_preview() {
    let rows = rows(&doc());
    let key = row("depth", Col::Expr);
    let mut n = notes(&[(key.clone(), "no"), (row("wall", Col::Expr), "kept")], &[(key.clone(), 4.)], &[]);
    assert_eq!(n.commit(&rows, &key, "wall * 7"), None);
    assert_eq!(n, notes(&[(row("wall", Col::Expr), "kept")], &[], &[]));
}

#[test]
fn a_refused_text_keeps_its_note_and_its_field_until_a_later_commit_goes_through() {
    let mut d = doc();
    let rows = rows(&d);
    let key = row("depth", Col::Expr);
    let mut n = notes(&[], &[(key.clone(), 9.)], &[]);
    let change = n.commit(&rows, &key, "wall *").unwrap();
    let refused = change.apply(&mut d.clone());
    let why = refused.clone().unwrap_err();
    n.settle(&change, refused);
    assert_eq!(n, notes(&[(key.clone(), &why)], &[], &[]));
    assert!(!n.resets(&key, false, "wall *", "wall * 7"));

    let change = n.commit(&rows, &key, "wall * 3").unwrap();
    let done = change.apply(&mut d);
    assert_eq!(done, Ok(()));
    n.settle(&change, done);
    assert_eq!(n, Notes::default());
    assert_eq!(d["paramDefs"]["depth"]["value"], json!(7.5));
}

#[test]
fn a_field_shows_the_stored_text_only_when_it_is_idle_clean_and_different() {
    let key = row("wall", Col::Name);
    let n = Notes::default();
    assert!(n.resets(&key, false, "wal", "wall"));
    assert!(!n.resets(&key, true, "wal", "wall"));
    assert!(!n.resets(&key, false, "wall", "wall"));
    assert!(!notes(&[(key.clone(), "taken")], &[], &[]).resets(&key, false, "wal", "wall"));
}

#[test]
fn a_refused_delete_is_noted_until_a_later_delete_of_it_goes_through() {
    let mut d = doc();
    let mut n = Notes::default();
    let change = Change::Delete("wall".into());
    let refused = change.apply(&mut d);
    let why = refused.clone().unwrap_err();
    n.settle(&change, refused);
    assert_eq!(n, notes(&[], &[], &[("wall", &why)]));

    let unhook = Change::Expr { name: "d4".into(), expr: "17.5".into() };
    assert_eq!(unhook.apply(&mut d), Ok(()));
    for name in ["depth", "wall"] {
        let change = Change::Delete(name.into());
        let done = change.apply(&mut d);
        assert_eq!(done, Ok(()), "{name}");
        n.settle(&change, done);
    }
    assert_eq!(n, Notes::default());
    assert_eq!(d["paramDefs"].as_object().unwrap().keys().collect::<Vec<_>>(), ["d4"]);
}

#[test]
fn a_refused_add_marks_the_button_and_typing_in_either_field_clears_it() {
    let d = doc();
    let rows = rows(&d);
    for typed_in in [Key::NewName, Key::NewExpr] {
        let mut n = Notes::default();
        let change = Change::Add { name: "wall".into(), expr: "4".into(), unit: "mm" };
        let refused = change.apply(&mut d.clone());
        let why = refused.clone().unwrap_err();
        n.settle(&change, refused);
        assert_eq!(n, notes(&[(Key::Add, &why)], &[], &[]));
        assert!(!n.problems.contains_key(&Key::NewName));
        n.check(Some(&d), &rows, &typed_in, "");
        assert_eq!(n, Notes::default(), "{typed_in:?}");
    }
}

#[test]
fn an_add_that_goes_through_clears_the_add_row() {
    let mut d = doc();
    let mut n = notes(&[(Key::Add, "taken"), (Key::NewExpr, "bad")], &[(Key::NewExpr, 3.)], &[]);
    let change = Change::Add { name: "lid".into(), expr: "depth / 5".into(), unit: "count" };
    let done = change.apply(&mut d);
    assert_eq!(done, Ok(()));
    n.settle(&change, done);
    assert_eq!(n, Notes::default());
    assert_eq!(d["paramDefs"]["lid"], json!({"expr": "depth / 5", "value": 3.5, "unit": "count"}));
}

#[test]
fn checking_an_expression_previews_its_value_or_notes_why_it_will_not_evaluate() {
    let d = doc();
    let rows = rows(&d);
    let mut n = Notes::default();
    n.check(Some(&d), &rows, &Key::NewExpr, "depth - 0.5");
    assert_eq!(n, notes(&[], &[(Key::NewExpr, 17.)], &[]));
    n.check(Some(&d), &rows, &Key::NewExpr, "depth -");
    assert_eq!(n.preview, HashMap::new());
    assert_eq!(n.problems.keys().collect::<Vec<_>>(), [&Key::NewExpr]);
    n.check(Some(&d), &rows, &Key::NewExpr, "");
    assert_eq!(n, Notes::default());

    let key = row("depth", Col::Expr);
    n.check(Some(&d), &rows, &key, "depth + 1");
    assert_eq!(n.problems.keys().collect::<Vec<_>>(), [&key]);
    n.check(Some(&d), &rows, &key, "wall * 7");
    assert_eq!(n, Notes::default());
    n.check(None, &rows, &key, "wall * 2");
    assert_eq!(n, Notes::default());
    n.check(Some(&d), &rows, &row("wall", Col::Comment), "wall +");
    assert_eq!(n, Notes::default());
}

#[test]
fn retain_drops_the_notes_of_rows_that_are_gone() {
    let rows = rows(&doc());
    let mut n = notes(
        &[(row("wall", Col::Name), "a"), (row("old", Col::Expr), "b"), (Key::Add, "c"), (Key::NewExpr, "d")],
        &[(row("old", Col::Expr), 1.), (row("d4", Col::Expr), 2.)],
        &[("old", "e"), ("wall", "f")],
    );
    n.retain(&rows);
    assert_eq!(
        n,
        notes(
            &[(row("wall", Col::Name), "a"), (Key::Add, "c"), (Key::NewExpr, "d")],
            &[(row("d4", Col::Expr), 2.)],
            &[("wall", "f")]
        )
    );
    n.retain(&Rows::default());
    assert_eq!(n, notes(&[(Key::Add, "c"), (Key::NewExpr, "d")], &[], &[]));
}
