use super::tidy;
use crate::overlay::{MenuItem, MenuRow};

fn item(label: &str) -> MenuRow {
    MenuRow::Item(MenuItem::call(label.to_string(), |_, _| {}))
}

fn shape(rows: &[MenuRow]) -> String {
    rows.iter()
        .map(|r| match r {
            MenuRow::Item(i) => i.label.to_string(),
            MenuRow::Separator => "-".into(),
            MenuRow::Submenu { label, .. } => format!("{label}>"),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn separators_left_by_empty_sections_go() {
    let rows = vec![MenuRow::Separator, item("a"), MenuRow::Separator, MenuRow::Separator, item("b"), MenuRow::Separator];
    assert_eq!(shape(&tidy(rows)), "a - b");
}

#[test]
fn a_menu_of_separators_is_empty() {
    assert!(tidy(vec![MenuRow::Separator, MenuRow::Separator]).is_empty());
}
