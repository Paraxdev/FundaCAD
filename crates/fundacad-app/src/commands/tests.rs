use super::keymap::{apply, conflicts, resolve, Problem, UserKey};
use super::keys::{table, Combo, Ctx};
use super::{live, predicate, summary};

fn user(id: &str, key: &str) -> UserKey {
    UserKey { id: id.into(), key: key.into(), shift: false, ctrl: false }
}

fn combo(text: &str) -> Combo {
    Combo::parse(text).unwrap()
}

#[test]
fn combos_read_and_write_as_fundacad_1_shows_them() {
    let cases = [
        ("Ctrl+Shift+H", Combo::new("h", true, true), "Ctrl+Shift+H", "ctrl-shift-h"),
        ("home", Combo::new("home", false, false), "Home", "home"),
        ("Left", Combo::new("arrowleft", false, false), "Left", "left"),
        ("shift+F6", Combo::new("f6", true, false), "Shift+F6", "shift-f6"),
        ("Ctrl++", Combo::new("+", false, true), "Ctrl++", "ctrl-+"),
        ("?", Combo::new("?", false, false), "?", "?"),
        ("Esc", Combo::new("escape", false, false), "Escape", "escape"),
    ];
    for (text, parsed, shown, stroke) in cases {
        let c = Combo::parse(text).unwrap();
        assert_eq!((&c, c.to_string().as_str(), c.keystroke().as_str()), (&parsed, shown, stroke), "{text}");
        assert_eq!(Combo::parse(&c.to_string()).unwrap(), c, "{text} round trip");
    }
}

#[test]
fn combos_refuse_alt_unknown_keys_and_modifiers() {
    assert_eq!(Combo::parse("Alt+K"), Err("Alt is read by the tools, pick a key without it".into()));
    assert_eq!(Combo::parse("Ctrl+F13"), Err("Ctrl+F13 is not a key".into()));
    assert_eq!(Combo::parse("Hyper+K"), Err("hyper is not a modifier".into()));
    assert_eq!(Combo::parse("Ctrl+F12").unwrap(), Combo::new("f12", false, true));
}

#[test]
fn the_shipped_table_has_no_clash_and_fixed_rows_first() {
    let rows = table();
    assert_eq!(conflicts(&rows), Vec::<(usize, usize)>::new());
    let fixed = rows.iter().take_while(|r| r.fixed).count();
    assert_eq!(fixed, 15);
    let redo: Vec<String> = rows.iter().filter(|r| r.action == "redo").map(|r| r.combo.clone().unwrap().to_string()).collect();
    assert_eq!(redo, vec!["Ctrl+Y", "Ctrl+Shift+Z"], "the menu shows the first, Ctrl+Y as FundaCAD 1");
    assert!(rows[fixed..].iter().all(|r| !r.fixed));
    let sketch = rows.iter().find(|r| r.action == "sketch").unwrap();
    assert_eq!(sketch.id, "sketch|model|S");
}

#[test]
fn no_user_keys_leave_the_table_as_it_is() {
    assert_eq!(apply(table(), &[]), (table(), vec![]));
}

#[test]
fn one_user_key_moves_its_row_first_and_wins_a_clash() {
    let (rows, problems) = apply(table(), &[user("extrude|model|E", "Shift+J")]);
    let first = &rows[0];
    assert_eq!((first.action, first.combo.clone()), ("extrude", Some(combo("Shift+J"))));
    assert_eq!(rows.len(), table().len());
    assert_eq!(problems, vec![]);

    let (rows, problems) = apply(table(), &[user("extrude|model|E", "T")]);
    assert_eq!(rows[0].combo, Some(combo("T")));
    // T is the sketch Trim key, a different context, so it is no clash.
    assert_eq!(problems, vec![]);

    let (rows, problems) = apply(table(), &[user("extrude|model|E", "F")]);
    assert_eq!(problems, vec![]);
    assert_eq!(resolve(&rows, &combo("F"), false).map(|r| r.action), Some("extrude"));
    let fillet = rows.iter().find(|r| r.action == "fillet").unwrap();
    assert_eq!(fillet.combo, None, "the shipped row that had F is unbound, so no clash is left to warn of");
}

#[test]
fn two_user_keys_on_one_key_clash_and_a_fixed_row_keeps_its_key() {
    let keys = [user("extrude|model|E", "J"), user("fillet|model|F", "J")];
    let (rows, problems) = apply(table(), &keys);
    assert_eq!(problems, vec![Problem::Conflict { key: "J".into(), first: "Extrude", second: "Fillet" }]);
    assert_eq!(resolve(&rows, &combo("J"), false).map(|r| r.action), Some("extrude"));

    let (rows, problems) = apply(table(), &[user("sketch|model|S", "Shift+H")]);
    assert_eq!(problems, vec![]);
    assert_eq!(rows.iter().find(|r| r.action == "show-all-bodies").unwrap().combo, None);
    assert_eq!(rows.iter().find(|r| r.action == "hide-selected").unwrap().combo, Some(combo("H")));
}

#[test]
fn fundacad_1_entries_keep_their_modifiers() {
    let read: Vec<UserKey> = serde_json::from_str(
        r#"[{"id": "extrude|model|E", "key": "j", "ctrl": true, "shift": true}, {"id": "fillet|model|F", "key": "g"}]"#,
    )
    .unwrap();
    assert_eq!(read[0], UserKey { id: "extrude|model|E".into(), key: "j".into(), shift: true, ctrl: true });
    let (rows, problems) = apply(table(), &read);
    assert_eq!(problems, vec![]);
    let got: Vec<_> = rows.iter().take(2).map(|r| (r.action, r.combo.clone())).collect();
    assert_eq!(got, vec![("extrude", Some(combo("Ctrl+Shift+J"))), ("fillet", Some(combo("G")))]);
    assert_eq!(serde_json::to_string(&user("a|model|Q", "Ctrl+Q")).unwrap(), r#"{"id":"a|model|Q","key":"Ctrl+Q"}"#);
}

#[test]
fn keys_the_app_holds_outside_the_table_are_refused() {
    let held = ["Tab", "Ctrl+`", "Ctrl+=", "Ctrl++", "Ctrl+-", "Ctrl+0", "Ctrl+Shift+1", "Ctrl+Shift+2", "?"];
    let keys: Vec<UserKey> = held.iter().map(|k| user("move|model|M", k)).collect();
    let (rows, problems) = apply(table(), &keys);
    let by: Vec<(String, &str)> = problems
        .iter()
        .map(|p| match p {
            Problem::Reserved { key, by, .. } => (key.clone(), *by),
            other => panic!("{other:?}"),
        })
        .collect();
    let want = [
        ("Tab", "Box select filter"),
        ("Ctrl+`", "Console"),
        ("Ctrl+=", "Interface size"),
        ("Ctrl++", "Interface size"),
        ("Ctrl+-", "Interface size"),
        ("Ctrl+0", "Interface size"),
        ("Ctrl+Shift+1", "Items"),
        ("Ctrl+Shift+2", "History"),
        ("?", "Shortcut help"),
    ];
    assert_eq!(by, want.iter().map(|(k, b)| (k.to_string(), *b)).collect::<Vec<_>>());
    assert_eq!(rows, table(), "no refused key moved a row");
    let (_, problems) = apply(table(), &[user("move|model|M", "Ctrl+9")]);
    assert_eq!(problems, vec![]);
}

#[test]
fn single_key_shortcuts_off_leaves_only_ctrl_and_named_keys() {
    let rows = table();
    let of = |action: &str| rows.iter().find(|r| r.action == action).unwrap();
    let cases = [("sketch", false), ("show-all-bodies", false), ("shortcut-help", false), ("save", true), ("front", true),
        ("fit", true), ("escape", true), ("region-next", true), ("next-face", true)];
    for (action, kept) in cases {
        assert_eq!(live(of(action), false), kept, "{action}");
        assert!(live(of(action), true), "{action}");
    }
}

#[test]
fn many_user_keys_report_each_problem_and_apply_the_rest() {
    let keys = [
        user("measure|model|I", ""),
        user("nothing|model|Q", "Q"),
        user("undo|global|Ctrl+Z", "Ctrl+U"),
        user("move|model|M", "Ctrl+S"),
        user("fillet|model|F", "Alt+F"),
        user("chamfer|model|B", "Shift+B"),
    ];
    let (rows, problems) = apply(table(), &keys);
    assert_eq!(
        problems,
        vec![
            Problem::Unknown { id: "nothing|model|Q".into() },
            Problem::Reserved { id: "undo|global|Ctrl+Z".into(), key: "Ctrl+Z".into(), by: "Undo" },
            Problem::Reserved { id: "move|model|M".into(), key: "Ctrl+S".into(), by: "Save" },
            Problem::Unreadable {
                id: "fillet|model|F".into(),
                why: "Alt is read by the tools, pick a key without it".into()
            },
        ]
    );
    let changed: Vec<_> = rows.iter().take(2).map(|r| (r.action, r.combo.clone())).collect();
    assert_eq!(changed, vec![("chamfer", Some(combo("Shift+B"))), ("measure", None)]);
    assert_eq!(resolve(&rows, &combo("I"), false).map(|r| r.action), None);
    assert_eq!(resolve(&rows, &combo("M"), false).map(|r| r.action), Some("move"));
}

#[test]
fn a_key_resolves_by_context() {
    let rows = table();
    assert_eq!(resolve(&rows, &combo("S"), false).map(|r| r.action), Some("sketch"));
    assert_eq!(resolve(&rows, &combo("L"), true).map(|r| r.action), Some("line"));
    assert_eq!(resolve(&rows, &combo("T"), false).map(|r| r.action), None);
    assert_eq!(resolve(&rows, &combo("Ctrl+Z"), true).map(|r| r.action), Some("undo"));
}

#[test]
fn bare_keys_wait_for_text_fields_and_every_key_for_overlays() {
    let rows = table();
    let of = |action: &str, ctx: Ctx| predicate(rows.iter().find(|r| r.action == action && r.context == ctx).unwrap());
    assert_eq!(of("sketch", Ctx::Model), "Model && !Input && !Modal");
    assert_eq!(of("line", Ctx::Sketch), "Sketch && !Input && !Modal");
    assert_eq!(of("save", Ctx::Global), "Workspace && !Modal");
    assert_eq!(of("palette", Ctx::Global), "Workspace && !Modal");
    assert_eq!(of("front", Ctx::Global), "Workspace && !Modal");
    assert_eq!(of("boolean-subtract", Ctx::Model), "Model && !Input && !Modal");
    assert_eq!(of("show-all-bodies", Ctx::Model), "Model && !Input && !Modal");
    assert_eq!(of("escape", Ctx::Global), "Workspace && !Input && !Modal");
}

#[test]
fn the_problems_summary_names_the_first_and_counts_the_rest() {
    let unknown = |id: &str| Problem::Unknown { id: id.into() };
    assert_eq!(summary(&[]), None);
    assert_eq!(summary(&[unknown("a|model|Q")]), Some("No shortcut is called a|model|Q".into()));
    assert_eq!(
        summary(&[unknown("a|model|Q"), unknown("b|sketch|W"), unknown("c|global|E")]),
        Some("No shortcut is called a|model|Q, and 2 more".into())
    );
}
