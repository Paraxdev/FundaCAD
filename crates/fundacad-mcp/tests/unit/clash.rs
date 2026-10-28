use fundacad_mcp::budget::Page;
use fundacad_mcp::clash::*;
use serde_json::json;

#[test]
fn a_sweep_counts_both_ends() {
    let s = sweep_of(&json!({"param": "press", "from": 0, "to": 12, "steps": 13})).unwrap();
    assert_eq!(s.values.len(), 13);
    assert_eq!(s.values[12], 12.0);
    let s = sweep_of(&json!({"param": "press", "from": 0, "to": 1, "step": 0.25})).unwrap();
    assert_eq!(s.values, vec![0.0, 0.25, 0.5, 0.75, 1.0]);
    let s = sweep_of(&json!({"param": "a", "from": 10, "to": 0, "step": 5})).unwrap();
    assert_eq!(s.values, vec![10.0, 5.0, 0.0]);
    assert!(sweep_of(&json!({"param": "a", "from": 0, "to": 1})).is_err());
    assert!(sweep_of(&json!({"param": "a", "values": [1, 2], "by": 3})).is_err());
}

#[test]
fn a_step_that_does_not_divide_the_span_still_ends_at_to() {
    let s = sweep_of(&json!({"param": "press", "from": 0, "to": 10, "step": 3})).unwrap();
    assert_eq!(s.values, vec![0.0, 3.0, 6.0, 9.0, 10.0]);
    let s = sweep_of(&json!({"param": "press", "from": 0, "to": 1, "step": 5})).unwrap();
    assert_eq!(s.values, vec![0.0, 1.0]);
    assert!(sweep_of(&json!({"param": "a", "from": 0, "to": 100, "step": 1})).is_err());
}

#[test]
fn steps_that_were_not_checked_are_not_counted_as_clear() {
    let clear = json!({"pairs": [], "clearances": [], "checked": [{"id": "body1", "name": "Frame"}, {"id": "body2", "name": "Slider"}]});
    let partial = json!({"pairs": [], "clearances": [], "checked": [{"id": "body1", "name": "Frame"}],
                         "errors": [{"feature_id": "ex2", "message": "depth must be positive"}]});
    let cut = json!({"pairs": [], "clearances": [], "truncated": true, "checked": [{"id": "body1", "name": "Frame"}, {"id": "body2", "name": "Slider"}],
                     "message": "Stopped after checking 400 candidate pairs; pick a smaller set of bodies for a full sweep."});
    let text = sweep_report(
        "press",
        "mm",
        &[
            Step { value: 0.0, reply: Ok(clear) },
            Step { value: 6.0, reply: Ok(cut) },
            Step { value: 12.0, reply: Ok(partial) },
            Step { value: 13.0, reply: Err("the geometry engine could not be reached".into()) },
        ],
        0.0,
        &["Frame".to_string(), "Slider".to_string()],
    );
    assert!(text.starts_with("No overlaps at any of the 3 checked steps. 1 step could not be checked."), "{text}");
    assert!(text.contains("1 step had failed features"), "{text}");
    assert!(text.contains("At 1 step the check stopped early: Stopped after checking 400"), "{text}");
    assert!(text.contains("press = 6: clear (stopped early, not every pair checked)"), "{text}");
    assert!(
        text.contains("press = 12: clear (Slider not built) (features failed: ex2: depth must be positive)"),
        "{text}"
    );
    assert!(
        text.contains("Slider was not built at 1 step (press = 12 mm), so its pairs were not checked there."),
        "{text}"
    );
    let none = sweep_report("press", "mm", &[Step { value: 0.0, reply: Err("x".into()) }], 1.0, &[]);
    assert!(none.starts_with("None of the 1 steps could be checked.\n"), "{none}");
}

#[test]
fn a_pair_that_was_not_tested_is_never_called_clear() {
    let reason =
        "has faces that point the wrong way, at 65 of its edges the two faces disagree about which side is inside";
    let r = json!({"pairs": [], "clearances": [], "uncheckedPairs": 1,
                   "unchecked": [{"id": "body1", "name": "Echo Dot 2", "reason": reason}]});
    let text = report(&r, 1.0, Page::all(), false);
    assert!(!text.contains("No bodies overlap"), "{text}");
    assert!(
        text.starts_with("NOT CHECKED: 1 pair that may overlap, because one of the two bodies cannot be judged:"),
        "{text}"
    );
    assert!(text.contains(&format!("  body1 \"Echo Dot 2\" {reason}")), "{text}");
    assert!(text.contains("No overlap among the pairs that were checked."), "{text}");

    let clear = json!({"pairs": [], "clearances": []});
    assert!(report(&clear, 0.0, Page::all(), false).starts_with("No bodies overlap."));

    let swept = sweep_report(
        "press",
        "mm",
        &[Step { value: 0.0, reply: Ok(clear) }, Step { value: 4.0, reply: Ok(r) }],
        0.0,
        &[],
    );
    assert!(swept.contains("press = 0: clear\n"), "{swept}");
    assert!(swept.contains("press = 4: no overlap found (body1 not judged, its pairs not checked)"), "{swept}");
    assert!(
        swept.contains(&format!(
            "At 1 step a body could not be judged and its pairs were NOT CHECKED: body1 \"Echo Dot 2\" {reason}."
        )),
        "{swept}"
    );
}

#[test]
fn a_failed_step_says_why_each_feature_failed() {
    let failed = json!({"pairs": [], "clearances": [],
                        "errors": [{"feature_id": "mech1", "message": "joint pin2 stays 0.8 mm apart, the linkage cannot close"},
                                   {"feature_id": "ex3", "message": "nothing to cut"}]});
    let text = sweep_report("press", "mm", &[Step { value: 11.0, reply: Ok(failed) }], 0.0, &[]);
    assert!(
        text.contains(
            "press = 11: clear (features failed: mech1: joint pin2 stays 0.8 mm apart, the linkage cannot close; ex3: nothing to cut)"
        ),
        "{text}"
    );
}

#[test]
fn a_sweep_names_where_it_clashes() {
    let clash = json!({"pairs": [{"a": "body1", "b": "body2", "aName": "Head", "bName": "Slider", "volume": 2.5}],
                       "clearances": []});
    let clear = json!({"pairs": [], "clearances": [{"a": "body1", "b": "body2", "aName": "Head", "bName": "Slider",
                                                   "distance": 0.4, "pointA": [0, 0, 0], "pointB": [0, 0, 0.4]}]});
    let text = sweep_report(
        "press",
        "mm",
        &[Step { value: 0.0, reply: Ok(clear) }, Step { value: 4.0, reply: Ok(clash) }],
        1.0,
        &[],
    );
    assert!(text.starts_with("Overlaps at 1 of 2 steps: press = 4 mm."), "{text}");
    assert!(text.contains("0.4 mm (body1 \"Head\" / body2 \"Slider\", at press = 0 mm)"), "{text}");
    assert!(text.contains("press = 4: CLASH body1/body2 2.5 mm3"), "{text}");
}

/// A bar through a row of pins: pins 2..13 overlap it alike, pin 1 by more, and pins 20..59 pass 1 mm from it.
fn a_bar_through_pins() -> serde_json::Value {
    let pin = |i: usize| (format!("body{}", i + 1), format!("Pin {i}"));
    let mut pairs = Vec::new();
    for i in 1..=13 {
        let (id, name) = pin(i);
        let (y, volume) = (i as f64 * 3.0, if i == 1 { 9.0 } else { 4.0 });
        pairs.push(json!({"a": "body1", "aName": "Bar", "b": id, "bName": name, "volume": volume,
                          "bbox": {"min": [0.0, y, 0.0], "max": [1.0, y + 2.0, 2.0]}}));
    }
    let clearances: Vec<_> = (20..60)
        .map(|i| {
            let (id, name) = pin(i);
            json!({"a": "body1", "aName": "Bar", "b": id, "bName": name, "distance": 1.0,
                   "pointA": [0.0, i as f64, 0.0], "pointB": [0.0, i as f64, 1.0]})
        })
        .collect();
    json!({"pairs": pairs, "clearances": clearances})
}

#[test]
fn a_long_list_sums_first_and_folds_alike_pairs() {
    let r = a_bar_through_pins();
    let text = report(&r, 1.0, Page { offset: 0, limit: 30 }, false);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "13 overlapping pairs: 57 mm3 overlap in all, largest first, alike pairs in one row");
    assert_eq!(lines[1], "  body1 \"Bar\" / body2 \"Pin 1\": 9 mm3 overlap, from (0, 3, 0) to (1, 5, 2)");
    assert_eq!(
        lines[2],
        "  body1 \"Bar\" / body3 \"Pin 2\": 4 mm3 overlap, from (0, 6, 0) to (1, 8, 2) \
         (and 11 more alike: body1 / body4..body14)"
    );
    assert_eq!(lines[3], "Within 1 mm without overlapping: 40 pairs, nearest first, alike pairs in one row");
    assert!(lines[4].ends_with("(and 39 more alike: body1 / body22..body60)"), "{text}");
    assert_eq!(lines.len(), 5, "{text}");
}

#[test]
fn every_pair_stays_reachable_by_page_and_full() {
    let r = a_bar_through_pins();
    let full = report(&r, 1.0, Page::all(), true);
    assert!(full.starts_with("13 overlapping pairs: 57 mm3 overlap in all, largest first\n"), "{full}");
    assert!(!full.contains("alike"), "{full}");
    assert!(full.contains("  body1 \"Bar\" / body60 \"Pin 59\": 1 mm apart, at (0, 59, 0) and (0, 59, 1)"), "{full}");
    assert_eq!(full.lines().count(), 2 + 13 + 40);

    let first = report(&r, 1.0, Page { offset: 0, limit: 5 }, true);
    assert!(first.contains("  showing overlap rows 1 to 5 of 13: pass offset 5 for the next 5, or limit 0 for all"));
    assert!(first.contains("  showing near rows 1 to 5 of 40: pass offset 5 for the next 5, or limit 0 for all"));
    let last = report(&r, 1.0, Page { offset: 35, limit: 5 }, true);
    assert!(last.contains("  no overlap rows from offset 35: there are 13"), "{last}");
    assert!(last.contains("  showing near rows 36 to 40 of 40"), "{last}");
    assert!(last.contains("body60 \"Pin 59\""), "{last}");
}

#[test]
fn a_fold_with_more_ids_than_fit_says_how_many_and_how_to_list_them() {
    let clearances: Vec<_> = (0..200)
        .map(|i| {
            json!({"a": "body1", "aName": "Bar", "b": format!("body{}", 2 + i * 2), "bName": format!("Pin {i}"),
                   "distance": 0.5, "pointA": [0.0, 0.0, 0.0], "pointB": [0.0, 0.0, 0.5]})
        })
        .collect();
    let text = report(&json!({"pairs": [], "clearances": clearances}), 1.0, Page { offset: 0, limit: 30 }, false);
    assert!(text.contains(" more, full true lists every pair)"), "{text}");
    assert!(text.len() < 600, "{} bytes: {text}", text.len());
}

#[test]
fn a_short_list_reads_as_it_always_did() {
    let r = json!({"pairs": [{"a": "body1", "aName": "Bar", "b": "body2", "bName": "Pin", "volume": 4.0,
                              "bbox": {"min": [0.0, 0.0, 0.0], "max": [1.0, 2.0, 2.0]}}],
                   "clearances": []});
    assert_eq!(
        report(&r, 1.0, Page { offset: 0, limit: 30 }, false),
        "1 overlapping pair:\n  body1 \"Bar\" / body2 \"Pin\": 4 mm3 overlap, from (0, 0, 0) to (1, 2, 2)\n\
         No other pair comes within 1 mm."
    );
}

#[test]
fn pairs_with_no_body_in_common_fold_to_their_pair_ids_in_counting_order() {
    let clearances: Vec<_> = (1..=12)
        .map(|i| {
            json!({"a": format!("body{i}"), "aName": format!("Pin {i}"), "b": format!("body{}", i + 1),
                   "bName": format!("Pin {}", i + 1), "distance": 0.5, "pointA": [0.0, 0.0, 0.0], "pointB": [0.5, 0.0, 0.0]})
        })
        .collect();
    let text = report(&json!({"pairs": [], "clearances": clearances}), 1.0, Page { offset: 0, limit: 30 }, false);
    assert!(text.contains("(and 11 more alike: body2/body3, body3/body4, "), "{text}");
    assert!(text.contains("body9/body10, body10/body11, body11/body12, body12/body13)"), "{text}");
}
