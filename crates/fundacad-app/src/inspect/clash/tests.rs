use serde_json::json;

use super::*;

fn reply(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn nothing_found_says_no_clashes() {
    let r = read(&reply(json!({"pairs": []})));
    assert_eq!(r, Report::default());
    assert_eq!(summary(&r), "No clashes");
}

#[test]
fn one_clash_names_the_pair_and_its_volume() {
    let r = read(&reply(json!({"pairs": [{"a": "b1", "b": "b2", "aName": "Box", "bName": "Lid", "volume": 12.3456}]})));
    assert_eq!(
        r.rows,
        vec![Clash { a: "b1".into(), b: "b2".into(), pair: "Box and Lid".into(), detail: "12.346 mm³ overlap".into(), close: false }]
    );
    assert_eq!(summary(&r), "1 clash");
}

#[test]
fn many_clashes_close_pairs_and_unchecked_bodies() {
    let r = read(&reply(json!({
        "pairs": [
            {"a": "b1", "b": "b2", "aName": "Box", "bName": "Lid", "volume": 3},
            {"a": "b2", "b": "b3", "aName": "", "bName": "Pin", "volume": 0.5},
        ],
        "clearances": [{"a": "b1", "b": "b3", "aName": "Box", "bName": "Pin", "distance": 0.15}],
        "unchecked": [{"id": "b4", "name": "Shell", "reason": "not a closed solid"}, {"id": "b5", "name": "", "reason": "open"}],
        "message": "Stopped after checking 64 candidate pairs",
    })));
    let pairs: Vec<(&str, &str, bool)> = r.rows.iter().map(|c| (c.pair.as_str(), c.detail.as_str(), c.close)).collect();
    assert_eq!(
        pairs,
        [("Box and Lid", "3 mm³ overlap", false), ("b2 and Pin", "0.5 mm³ overlap", false), ("Box and Pin", "0.15 mm apart", true)]
    );
    assert_eq!(r.unchecked, ["Shell: not a closed solid", "b5: open"]);
    assert_eq!(r.note.as_deref(), Some("Stopped after checking 64 candidate pairs"));
    assert_eq!(summary(&r), "2 clashes, 1 close pair, 2 not checked");
}

#[test]
fn close_pairs_alone_still_say_no_clashes() {
    let r = read(&reply(json!({"pairs": [], "clearances": [
        {"a": "b1", "b": "b3", "aName": "Box", "bName": "Pin", "distance": 0.1},
        {"a": "b1", "b": "b2", "aName": "Box", "bName": "Lid", "distance": 0.2},
    ]})));
    assert_eq!(summary(&r), "No clashes, 2 close pairs");
}

fn pair(close: bool) -> Clash {
    Clash { a: "b1".into(), b: "b2".into(), pair: "Box and Lid".into(), detail: String::new(), close }
}

#[test]
fn the_footer_says_how_close_was_looked_for_only_when_no_pair_was_that_close() {
    let none = Report::default();
    assert_eq!(footer(&none, None), ["Esc to close"]);
    assert_eq!(footer(&none, Some(0.25)), ["No pairs closer than 0.25 mm", "Esc to close"]);
    let clash = Report { rows: vec![pair(false)], ..Report::default() };
    let hint = "Click a row to select the pair, Esc to close";
    assert_eq!(footer(&clash, None), [hint]);
    assert_eq!(footer(&clash, Some(0.2)), ["No pairs closer than 0.2 mm", hint]);
    let close = Report { rows: vec![pair(false), pair(true)], ..Report::default() };
    assert_eq!(footer(&close, Some(0.2)), [hint]);
}
