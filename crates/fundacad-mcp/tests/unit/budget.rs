use fundacad_mcp::budget::*;
use serde_json::{json, Map, Value};

fn pin(i: usize) -> Row {
    let name = if i == 1 { "Pin".to_string() } else { format!("Pin {i}") };
    Row::of_line(format!("body{i}"), name.clone(), format!("body{i} \"{name}\": 2.0 x 2.0 x 2.0 mm, 6 faces"))
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

#[test]
fn a_short_list_reads_as_it_always_did() {
    let rows: Vec<Row> = (1..=FOLD_FROM).map(pin).collect();
    let texts: Vec<String> = rows.iter().map(|r| r.text.clone()).collect();
    assert_eq!(fold(rows), texts);
}

#[test]
fn alike_rows_fold_into_the_first_with_the_ids_of_the_rest() {
    let mut rows: Vec<Row> = (1..=12).map(pin).collect();
    rows.insert(1, Row::of_line("body99".into(), "Hub".into(), "body99 \"Hub\": 20.0 x 20.0 x 5.0 mm, 3 faces".into()));
    let folded = fold(rows);
    assert_eq!(folded.len(), 2);
    assert_eq!(
        folded[0],
        "body1 \"Pin\": 2.0 x 2.0 x 2.0 mm, 6 faces (and 11 more alike: body2..body12, named \"Pin 2\"..\"Pin 12\")"
    );
    assert_eq!(folded[1], "body99 \"Hub\": 20.0 x 20.0 x 5.0 mm, 3 faces");
}

#[test]
fn rows_that_differ_beyond_their_ids_stay_apart() {
    let mut rows: Vec<Row> = (1..=11).map(pin).collect();
    rows[5] = Row::of_line("body6".into(), "Pin 6".into(), "body6 \"Pin 6\": 3.0 x 2.0 x 2.0 mm, 6 faces".into());
    rows[7] = Row::of_line("body8".into(), "Bolt 8".into(), "body8 \"Bolt 8\": 2.0 x 2.0 x 2.0 mm, 6 faces".into());
    let folded = fold(rows);
    assert_eq!(folded.len(), 3);
    assert!(folded[0].contains("(and 8 more alike: body2..body5, body7, body9..body11,"), "{}", folded[0]);
    assert!(folded[1].starts_with("body6 \"Pin 6\": 3.0"));
    assert!(folded[2].starts_with("body8 \"Bolt 8\""));
}

#[test]
fn a_folded_row_keeps_the_lines_under_it() {
    let rows: Vec<Row> = (1..=11)
        .map(|i| Row::of_line(format!("body{i}"), "Pin".into(), format!("body{i} \"Pin\" | 2 mm\n  ! a seam")))
        .collect();
    let folded = fold(rows);
    assert_eq!(folded, vec!["body1 \"Pin\" | 2 mm (and 10 more alike: body2..body11)\n  ! a seam".to_string()]);
}

#[test]
fn ranges_join_runs_of_numbered_ids() {
    assert_eq!(ranges(&["body4", "body5", "body6", "body9"], false), "body4..body6, body9");
    assert_eq!(ranges(&["body4", "body5"], false), "body4, body5");
    assert_eq!(ranges(&["Pin", "Pin", "Bar"], true), "\"Pin\", \"Bar\"");
    assert_eq!(ranges(&[], false), "");
}

#[test]
fn capped_ranges_stop_at_the_cap_and_count_the_rest() {
    let ids: Vec<String> = (1..=40).map(|i| format!("body{}", i * 2)).collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (said, left) = ranges_capped(&ids, false, 30);
    assert_eq!(said, "body2, body4, body6, body8");
    assert_eq!(left, 36);
    assert_eq!(ranges_capped(&["body1", "body2", "body3"], false, 30), ("body1..body3".to_string(), 0));
    // One id longer than the cap is still said, a row never lists none of its ids.
    assert_eq!(ranges_capped(&["body100", "body200"], false, 3), ("body100".to_string(), 1));
}

#[test]
fn ids_sort_the_way_a_person_counts() {
    let mut ids = vec!["body10", "body2", "body1", "sketch3"];
    ids.sort_by(|a, b| natural(a, b));
    assert_eq!(ids, vec!["body1", "body2", "body10", "sketch3"]);
}

#[test]
fn a_copy_number_is_not_part_of_the_name() {
    assert_eq!(stem("Pin 12"), "Pin");
    assert_eq!(stem("Pin"), "Pin");
    assert_eq!(stem("M3"), "M3");
}

#[test]
fn a_page_reads_its_limit_and_offset() {
    assert_eq!(Page::of(&args(json!({})), 30).unwrap(), Page { offset: 0, limit: 30 });
    assert_eq!(Page::of(&args(json!({"limit": null})), 30).unwrap(), Page { offset: 0, limit: 30 });
    assert_eq!(Page::of(&args(json!({"limit": 0, "offset": 5})), 30).unwrap(), Page { offset: 5, limit: 0 });
    for bad in [json!({"limit": -1}), json!({"offset": 1.5}), json!({"limit": "ten"})] {
        assert!(Page::of(&args(bad.clone()), 30).is_err(), "{bad}");
    }
}

#[test]
fn a_page_says_what_it_left_out_and_how_to_ask_for_it() {
    let rows: Vec<usize> = (0..25).collect();
    let (shown, more) = Page { offset: 10, limit: 10 }.cut(rows.clone(), "rows");
    assert_eq!(shown, (10..20).collect::<Vec<_>>());
    assert_eq!(more.unwrap(), "showing rows 11 to 20 of 25: pass offset 20 for the next 10, or limit 0 for all");

    let (shown, more) = Page { offset: 20, limit: 10 }.cut_asking(rows.clone(), "rows", "full true and ");
    assert_eq!(shown, (20..25).collect::<Vec<_>>());
    assert_eq!(more.unwrap(), "showing rows 21 to 25 of 25");

    let (shown, more) = Page { offset: 0, limit: 10 }.cut_asking(rows.clone(), "rows", "full true and ");
    assert_eq!(shown.len(), 10);
    assert!(more.unwrap().ends_with("pass full true and offset 10 for the next 10, or full true and limit 0 for all"));

    let (shown, more) = Page::all().cut(rows.clone(), "rows");
    assert_eq!((shown.len(), more), (25, None));

    let (shown, more) = Page { offset: 30, limit: 10 }.cut(rows, "rows");
    assert!(shown.is_empty());
    assert_eq!(more.unwrap(), "no rows from offset 30: there are 25");
}

#[test]
fn a_huge_limit_shows_every_row_from_the_offset() {
    let huge = Page::of(&args(json!({"limit": 1e30, "offset": 1})), 30).unwrap();
    let (shown, more) = huge.cut(vec![1, 2, 3], "rows");
    assert_eq!(shown, vec![2, 3]);
    assert_eq!(more.unwrap(), "showing rows 2 to 3 of 3");
}

#[test]
fn selector_numbers_lose_their_float_noise() {
    assert_eq!(rounded(&json!(2.9999999999999996)), json!(3.0));
    assert_eq!(rounded(&json!(4.44e-16)), json!(0.0));
    assert_eq!(rounded(&json!(-1.0e-9)).to_string(), "0.0");
    assert_eq!(rounded(&json!(1.23456789)), json!(1.234568));
    assert_eq!(rounded(&json!({"n": [7, 0.5, "x", -1.0]})), json!({"n": [7, 0.5, "x", -1.0]}));
    assert_ne!(rounded(&json!(1.0)), json!(1));
}

#[test]
fn selectors_print_one_to_a_line_and_parse_back() {
    let sel = json!({
        "body1": {"faces": {"F0": {"normal": [0.0, 0.0, 0.9999999999999998], "area": 4.0},
                            "F1": {"normal": [1.0, 0.0, 0.0], "area": 4.0}},
                  "edges": {"E0": {"length": 2.0000000000000004}}},
        "body2": {"faces": {}}
    });
    let out = selector_json(sel.as_object().unwrap());
    assert_eq!(out.lines().filter(|l| l.contains("\"F0\"") || l.contains("\"F1\"") || l.contains("\"E0\"")).count(), 3);
    assert_eq!(out.lines().count(), 14, "{out}");
    let back: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(back, rounded(&sel));
    assert_eq!(selector_json(&Map::new()), "{}");
}

#[test]
fn a_long_separate_export_folds_the_files_of_one_name_and_size() {
    let mut written: Vec<(String, u64)> = vec![("Pin.stl".into(), 684), ("Hub.stl".into(), 14084)];
    written.extend((2..=3000).map(|i| (format!("Pin_{i}.stl"), 684)));
    written.push(("Pin_3001.stl".into(), 700));
    let rows = files(&written, true);
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!(rows[0], "  Pin.stl (684 bytes) (and 2999 more alike: Pin_2..Pin_3000)");
    assert_eq!(rows[1], "  Hub.stl (14084 bytes)");
    assert_eq!(rows[2], "  Pin_3001.stl (700 bytes)", "a file of another size is a row of its own");

    let every = files(&written, false);
    assert_eq!(every.len(), written.len());
    assert_eq!(every[2], "  Pin_2.stl (684 bytes)");
}

#[test]
fn a_short_separate_export_lists_every_file() {
    let written: Vec<(String, u64)> = (1..=FOLD_FROM).map(|i| (format!("Pin_{i}.stl"), 684)).collect();
    let rows = files(&written, true);
    assert_eq!(rows.len(), FOLD_FROM);
    assert_eq!(rows[0], "  Pin_1.stl (684 bytes)");
}

#[test]
fn folded_files_cap_their_ids_and_say_how_to_list_them() {
    let written: Vec<(String, u64)> = (1..=400).map(|i| (format!("Pin_{}.stl", i * 2), 684)).collect();
    let rows = files(&written, true);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].ends_with("more, full true lists every file)"), "{}", rows[0]);
    assert!(rows[0].len() < 400, "{}", rows[0]);
}
