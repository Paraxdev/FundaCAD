use std::path::Path;

use super::{card_names, date, example_doc, opened_line, EXAMPLES};

const MIN: u64 = 60_000;
const DAY: u64 = 24 * 60 * MIN;

#[test]
fn opened_line_reads_in_words() {
    let now = 1_795_000_000_000;
    assert_eq!(opened_line(now, now - 5_000), "Opened just now");
    assert_eq!(opened_line(now, now - MIN), "Opened 1 minute ago");
    assert_eq!(opened_line(now, now - 42 * MIN), "Opened 42 minutes ago");
    assert_eq!(opened_line(now, now - 3 * 60 * MIN), "Opened 3 hours ago");
    assert_eq!(opened_line(now, now - DAY - MIN), "Opened yesterday");
    assert_eq!(opened_line(now, now - 4 * DAY), "Opened 4 days ago");
    assert_eq!(opened_line(now, now + MIN), "Opened just now");
}

#[test]
fn an_old_file_shows_its_date() {
    // 2026-11-12 10:00 UTC.
    let at = 1_794_477_600_000;
    assert_eq!(opened_line(at + 30 * DAY, at), "Opened on 12 Nov 2026");
    assert_eq!(date(0), "1 Jan 1970");
    assert_eq!(date(951_782_400_000), "29 Feb 2000");
}

#[test]
fn a_card_names_the_file_and_its_folder() {
    let (name, folder) = card_names(Path::new("/work/brackets/wall.funda"));
    assert_eq!((name.as_str(), folder.as_str()), ("wall", "brackets"));
    let (name, folder) = card_names(Path::new("lone.funda"));
    assert_eq!((name.as_str(), folder.as_str()), ("lone", ""));
}

#[test]
fn the_examples_follow_examples_json() {
    let listed: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../../examples/templates/examples.json")).unwrap();
    let ids: Vec<&str> = listed.iter().map(|e| e["id"].as_str().unwrap()).collect();
    let ours: Vec<&str> = EXAMPLES.iter().filter(|e| e.text.is_some()).map(|e| e.id).collect();
    assert_eq!(ours, ids);
    for (ex, json) in EXAMPLES.iter().zip(&listed) {
        assert_eq!(ex.name, json["name"].as_str().unwrap());
        assert_eq!(ex.icon, json["icon"].as_str().unwrap());
    }
}

#[test]
fn every_example_reads_as_a_document() {
    for ex in EXAMPLES.iter().filter(|e| e.text.is_some()) {
        let doc = example_doc(ex).unwrap_or_else(|| panic!("{} does not read", ex.id));
        assert!(doc.get("features").is_some_and(|f| f.is_array()), "{} has no features", ex.id);
    }
}

#[test]
fn the_printer_is_a_placeholder_until_its_file_lands() {
    let printer = EXAMPLES.iter().find(|e| e.id == "printer").unwrap();
    assert!(printer.text.is_none());
    assert!(example_doc(printer).is_none());
}

#[test]
fn every_home_glyph_is_in_the_icon_pack() {
    use gpui::AssetSource as _;
    let fixed = ["plus", "open", "close", "body", "history"];
    let missing: Vec<&str> = fixed
        .into_iter()
        .chain(EXAMPLES.iter().map(|e| e.icon))
        .filter(|g| crate::assets::Assets.load(&crate::ui::icon_path(g)).ok().flatten().is_none())
        .collect();
    assert!(missing.is_empty(), "missing icons: {missing:?}");
}
