use super::keymap::{apply, clash, rebind, resolve};
use super::keys::{table, Combo, Ctx};

fn combo(text: &str) -> Combo {
    Combo::parse(text).unwrap()
}

fn action(text: &str, sketch: bool) -> Option<&'static str> {
    resolve(&table(), &combo(text), sketch).map(|r| r.action)
}

#[test]
fn sketch_mode_reads_fundacad_1_tool_and_constraint_keys() {
    let keys = [
        ("L", "line"),
        ("R", "rectangle"),
        ("C", "circle"),
        ("A", "arc"),
        ("D", "dimension"),
        ("T", "trim"),
        ("O", "offset"),
        ("F", "fillet-sketch"),
        ("P", "project"),
        ("M", "move-sketch"),
        ("H", "horizontal"),
        ("V", "vertical"),
        ("N", "perpendicular"),
        ("Shift+P", "parallel"),
        ("Shift+L", "collinear"),
    ];
    for (k, a) in keys {
        assert_eq!(action(k, true), Some(a), "{k}");
    }
}

#[test]
fn the_same_letters_keep_their_model_meaning_outside_a_sketch() {
    assert_eq!(action("T", false), None);
    assert_eq!(action("F", false), Some("fillet"));
    assert_eq!(action("M", false), Some("move"));
    assert_eq!(action("O", false), Some("offset-plane"));
    assert_eq!(action("H", false), Some("hide-selected"));
    assert_eq!(action("Shift+P", false), None);
}

#[test]
fn a_sketch_key_rebinds_and_clashes_only_with_sketch_rows() {
    let rows = table();
    let parallel = rows.iter().find(|r| r.action == "parallel" && r.context == Ctx::Sketch).unwrap().id.clone();
    let line = rows.iter().find(|r| r.action == "line" && r.context == Ctx::Sketch).unwrap().id.clone();
    assert!(clash(&rows, &parallel, &combo("L")).is_some(), "L is the sketch Line");
    assert_eq!(clash(&rows, &parallel, &combo("J")), None);
    let (rows, problems) = apply(table(), &rebind(&[], &parallel, Some(&combo("J")), None));
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(resolve(&rows, &combo("J"), true).map(|r| r.action), Some("parallel"));
    assert_eq!(resolve(&rows, &combo("J"), false).map(|r| r.action), None);
    assert!(rows.iter().any(|r| r.id == line && r.combo == Some(combo("L"))));
}
