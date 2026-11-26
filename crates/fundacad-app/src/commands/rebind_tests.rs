use super::keymap::{apply, clash, combo_of, rebind, reset, Clash, UserKey};
use super::keys::{table, Combo};

fn combo(text: &str) -> Combo {
    Combo::parse(text).unwrap()
}

fn id_of(action: &str) -> String {
    table().into_iter().find(|r| r.action == action).unwrap().id
}

#[test]
fn a_key_on_another_live_row_is_used_and_a_fixed_or_reserved_one_is_taken() {
    let rows = table();
    let extrude = id_of("extrude");
    assert_eq!(clash(&rows, &extrude, &combo("B")), Some(Clash::Used { by: "Chamfer (bevel)", id: id_of("chamfer") }));
    assert_eq!(clash(&rows, &extrude, &combo("Ctrl+S")), Some(Clash::Taken { by: "Save" }));
    assert_eq!(clash(&rows, &extrude, &combo("Ctrl+0")), Some(Clash::Taken { by: "Interface size" }));
    assert_eq!(clash(&rows, &extrude, &combo("J")), None);
    // L is a sketch row's, which is not live in the model while Extrude's model row is.
    assert_eq!(clash(&rows, &extrude, &combo("Shift+L")), None);
}

#[test]
fn replace_moves_the_key_and_unbinds_the_row_that_had_it() {
    let (extrude, chamfer) = (id_of("extrude"), id_of("chamfer"));
    let user = rebind(&[], &extrude, Some(&combo("B")), Some(&chamfer));
    let (rows, problems) = apply(table(), &user);
    assert!(problems.is_empty(), "{problems:?}");
    let on = |id: &str| rows.iter().find(|r| r.id == id).unwrap().combo.clone();
    assert_eq!((on(&extrude), on(&chamfer)), (Some(combo("B")), None));
    assert!(reset(&user, &extrude).iter().all(|u: &UserKey| u.id != extrude));
    let unbound = rebind(&user, &extrude, None, None);
    assert_eq!(unbound.iter().filter(|u| u.id == extrude).count(), 1);
    assert_eq!(apply(table(), &unbound).0.iter().find(|r| r.id == extrude).unwrap().combo, None);
}

#[test]
fn a_key_press_makes_its_combo() {
    assert_eq!(combo_of("b", Some("b"), true, false, false), Ok(Some(combo("Ctrl+B"))));
    assert_eq!(combo_of("/", Some("?"), false, true, false), Ok(Some(combo("?"))));
    assert_eq!(combo_of("left", None, false, true, false), Ok(Some(combo("Shift+Left"))));
    assert_eq!(combo_of("shift", None, false, true, false), Ok(None));
    assert!(combo_of("e", Some("e"), false, false, true).is_err());
}
